#!/usr/bin/env node
// ============================================================
// agent-brain.mjs â€” Brain v3 Orchestration Service
//
// Deterministic orchestration layer between Ears and Mouth.
// Processes Firestore intake records through the Cortex loop
// and manages envelopes (the R/C/M/T work hierarchy).
//
// Phase 7A: responsibilities, quick ack, cron scheduler
//   - Responsibility scheduler: cron-triggered Râ†’M envelope creation
//   - Quick ack: immediate delivery when intake is claimed
//   - Rich context injection: responsibilities carry full process docs
//
// Phase 8: production hardening
//   - Periodic archival of complete/failed/stale needs_input envelopes
//   - Contracts-driven configuration (no hardcoded values)
//   - Removed BRAIN_V3_ENABLED feature gate + dead delegate handler
//
// Design principles:
//   - LLMs think. Deterministic systems orchestrate.
//   - One envelope format, all scales.
//   - Firestore is the shared work repository.
//   - Memory is hardwired (Phase 3+).
//   - Agents are cognitive workers, not orchestrators.
//
// Run:
//   node agent-brain.mjs
// ============================================================
import { readFileSync, appendFileSync, existsSync, watchFile, readdirSync, writeFileSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';

// ---- Shared library imports (Phase 0 extraction) ----
import { getGceToken } from '../corekit/lib/gce-auth.mjs';
import { createClient as createFirestoreClient, firestoreEncode, firestoreDecode } from '../corekit/lib/firestore.mjs';
import { parseJsonResponse } from '../corekit/lib/json-repair.mjs';
import { createVertexText, CORTEX_SCHEMAS, smartTruncate } from '../corekit/lib/vertex-text.mjs';
import { createProjectRegistry } from '../corekit/lib/projects.mjs';
import { createProcessEngine } from '../corekit/lib/process-engine.mjs';
import { createScheduler } from '../corekit/lib/scheduler.mjs';
import { createApprovalChecker } from '../corekit/lib/approvals.mjs';
import { createArchivalSweeper } from '../corekit/lib/archival.mjs';
import { createArtifactManager } from '../corekit/lib/artifacts.mjs';
import { createNotifier } from '../corekit/lib/notifications.mjs';
import { createHistoryWriter } from '../corekit/lib/history.mjs';
import { composeDelegationMarker, composeDelegationResultMarker } from '../corekit/lib/delegation.mjs';
import { makeAddress } from '../corekit/lib/channel.mjs';
import { extractVerdict, extractFailSummary, extractFailRecommendation } from '../corekit/lib/verdict.mjs';
import { createLifecycleHandler } from '../corekit/lib/envelope-lifecycle.mjs';
import { executeCheckpoints } from '../corekit/lib/checkpoint-executor.mjs';
import { extractCheckpoints } from '../corekit/lib/plan-utils.mjs';
import { extractCues, searchWork, recentWorkDigest } from '../corekit/lib/work-recall.mjs';
import {
  handleSynthesize,
  handleBlocked,
  handleNeedsInput,
  handleStatusUpdate,
  handleSynthesizeWithFailure,
  handleFollowProcess,
  handleDelegate,
  handleCheckpointPlan
} from './actions/index.mjs';

// Alias: many call sites still use getAuthToken() for direct REST calls.
// Maps to the cached version from gce-auth.mjs (strictly better).
const getAuthToken = getGceToken;

// ---- Contracts (loaded first â€” config depends on it) ----
const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
let CONTRACTS = {};
try {
  CONTRACTS = JSON.parse(readFileSync(CORE_DIR + '/corekit/contracts.json', 'utf8'));
} catch (e) {
  console.log('[brain] WARN: contracts.json not found, using defaults');
}

// ---- Config ----
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';
const AGENT_EMAIL = process.env.AGENT_USER_EMAIL || '';
const GATEWAY_PORT = CONTRACTS.gateway?.port || 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`;
const MAX_ITERATIONS = CONTRACTS.dispatch?.max_iterations || 12;
const GATEWAY_TIMEOUT_MS = CONTRACTS.dispatch?.gateway_timeout_ms || 600_000;
const STALE_CLEANUP_HOURS = CONTRACTS.dispatch?.stale_cleanup_hours || 24;
const ARCHIVE_AGE_DAYS = CONTRACTS.dispatch?.archive_age_days || 7;
const ARCHIVE_INTERVAL_MS = CONTRACTS.dispatch?.archive_interval_ms || 1 * 60 * 60 * 1000; // 1h default
const NEEDS_INPUT_TIMEOUT_HOURS = CONTRACTS.dispatch?.needs_input_timeout_hours || 72;
const STEP_LEDGER_ENABLED = CONTRACTS.dispatch?.step_ledger_enabled !== false; // default true
const CHECKPOINT_RESUME_ENABLED = CONTRACTS.dispatch?.checkpoint_resume_enabled !== false; // default true
const CLAIM_STALE_MS = CONTRACTS.dispatch?.claim_stale_ms || 600_000; // 10 min
const LOG_FILE = '/tmp/agent-brain.log';
const CORTEX_ROUTE = CONTRACTS.agents?.gatewayRoute || 'brain/cortex';

// Brain's own LLM â€” used ONLY for simple textâ†’text summarization via direct
// Vertex AI calls (not through gateway). Classify/decide/synthesize always use
// cortex through the gateway. See summarizeViaVertex() below.
const BRAIN_MODEL = CONTRACTS.dispatch?.model || 'gemini-2.5-flash';
const BRAIN_ROUTE = CORTEX_ROUTE;  // classify/decide/synthesize always use cortex

// ---- Project contracts config ----
const PROJECT_PROMOTION_AUTO = CONTRACTS.projects?.promotion_auto || false;

// ---- Artifacts config (loaded from prime Firestore doc at startup) ----
// ARTIFACTS_ROOT_FOLDER_ID is now declared in the artifacts wrapper below

// ---- Context forwarding budgets (chars per prior step) ----
const CTX_DISPATCH_SUCCESS = CONTRACTS.dispatch?.ctx_dispatch_success || 4000;
const CTX_DISPATCH_FAILURE = CONTRACTS.dispatch?.ctx_dispatch_failure || 3000;
const CTX_AGENT_STEP = CONTRACTS.dispatch?.ctx_agent_step || 8000;
const CTX_CORTEX_STEP = CONTRACTS.dispatch?.ctx_cortex_step || 4000;

// Brain's own LLM for simple textâ†’text tasks (summarize, compress, rephrase).
// Now uses the extracted vertex-text.mjs module via createVertexText().
// Bypasses the neural gateway entirely — no agent routing, no workspace, no tools.

const VERTEX_LOCATION = CONTRACTS.utility?.location || CONTRACTS.vertex?.location || 'global';

// ---- Initialize utility LLM client (vertex-text.mjs) ----
const _vtx = createVertexText({
  projectId: GCP_PROJECT,
  location: VERTEX_LOCATION,
  model: CONTRACTS.utility?.model || BRAIN_MODEL,
  timeoutMs: CONTRACTS.utility?.timeout_ms || 30_000,
  enforceSchemaTimeoutMs: CONTRACTS.utility?.enforce_schema_timeout_ms || 15_000,
  enforceSchemaMaxAttempts: CONTRACTS.utility?.enforce_schema_max_attempts || 2,
  logger: log,
});

// ---- Thin wrappers preserving existing call signatures ----
// These delegate to the lib module but keep the brain's call sites unchanged.

async function summarizeViaVertex(text, instruction, opts = {}) {
  return _vtx.transform(text, instruction, opts);
}

async function enforceSchema(cortexRaw, mode) {
  return _vtx.enforceSchema(cortexRaw, mode);
}

async function smartSummarize(text, budget, prompt) {
  return _vtx.summarize(text, prompt, { budget });
}

async function generateTitle(text, type = 'mission') {
  return _vtx.generateTitle(text, type);
}

// Coerce LLM output fields to string — Cortex/synthesize/motor may return objects
function toStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return typeof v === 'object' ? (v.instruction || v.text || JSON.stringify(v)) : String(v);
}

/**
 * Build a delivery Address from decoded source_meta and source_channel.
 * Brain-local counterpart of parseAddress() — works with decoded JS objects
 * (no Firestore stringValue wrappers) since the brain's in-memory envelopes
 * are fully decoded by firestoreDecode.
 */
function addressFromMeta(sourceMeta, sourceChannel) {
  if (!sourceMeta) return makeAddress(sourceChannel === 'gchat' ? 'gchat' : 'dashboard');
  // New canonical path: source_meta.address (already decoded sub-object)
  const addr = sourceMeta.address;
  if (addr && addr.channel) {
    if (addr.channel === 'gchat') {
      return makeAddress('gchat', { space: addr.space || null, thread: addr.thread || null });
    }
    return makeAddress('dashboard', { fleet_agent: addr.fleet_agent ?? null });
  }
  // Legacy fallback: flat fields on source_meta
  const space = sourceMeta.spaceName || sourceMeta.space || null;
  const thread = sourceMeta.threadName || null;
  if (space) return makeAddress('gchat', { space, thread });
  if (sourceChannel === 'gchat') return makeAddress('gchat');
  return makeAddress('dashboard');
}

/**
 * Create a C→T pair under a parent envelope and return the checkpoint ID.
 * Enforces M→C→T hierarchy for all terminal outputs.
 * CP4: idempotent via ctKey — if a C envelope with matching ct_key already
 * exists under this parent, returns the existing ID (no duplicate creation).
 */
async function createCT(parentEnvelope, { checkpointTitle, taskTitle, taskOutput, taskIntent = 'execute', taskStatus = 'complete', deliveryStatus = 'internal', deliveryAddress = null, ctKey = null }) {
  // CP4: idempotent dedup — check if this CT pair already exists
  if (ctKey && parentEnvelope.children?.length > 0) {
    for (const childId of parentEnvelope.children) {
      try {
        const existing = await firestoreRead('work', childId);
        if (existing?.type === 'C' && existing?.source_meta?.ct_key === ctKey) {
          log('INFO', `createCT dedup: ct_key=${ctKey} already exists as ${childId}, skipping`);
          return childId;
        }
      } catch { /* child may not exist */ }
    }
  }

  const cpId = generateId('w');
  const tId = generateId('w');
  const cpEnvelope = {
    id: cpId, type: 'C', parent_id: parentEnvelope.id,
    owner: AGENT_EMAIL || AGENT_ID,
    status: taskStatus === 'complete' ? 'complete' : 'active',
    intent: 'checkpoint', title: checkpointTitle,
    instruction: checkpointTitle, accept_criteria: null,
    context_summary: null, output: null,
    children: [tId], context_forward: null, error: null,
    source_channel: 'brain',
    source_meta: ctKey ? { ct_key: ctKey } : {},
    project_id: parentEnvelope.project_id || null,
    created_at: now(), started_at: now(),
    completed_at: taskStatus === 'complete' ? now() : null,
    updated_at: now(), iteration: 0,
  };
  const tEnvelope = {
    id: tId, type: 'T', parent_id: cpId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: taskStatus, intent: taskIntent,
    title: taskTitle, instruction: taskTitle,
    accept_criteria: null, context_summary: null,
    output: taskOutput, children: [], context_forward: null,
    error: null, source_channel: parentEnvelope.source_channel || 'brain',
    source_meta: parentEnvelope.source_meta || {},
    created_at: now(), started_at: now(),
    completed_at: taskStatus === 'complete' ? now() : null,
    updated_at: now(), iteration: 0,
    delivery_status: deliveryStatus,
    ...(deliveryAddress ? { delivery_address: deliveryAddress } : {}),
  };
  await firestoreWrite('work', cpId, cpEnvelope);
  await firestoreWrite('work', tId, tEnvelope);
  parentEnvelope.children = parentEnvelope.children || [];
  parentEnvelope.children.push(cpId);
  parentEnvelope.updated_at = now();
  return cpId;
}

/**
 * Strip GChat context framing from raw intake text.
 * Removes headers like "[Current message - respond to this]\nUser:" that
 * get prepended by agent-ears preprocessing.
 */
function stripChatFraming(text) {
  if (!text) return text;
  return text
    .replace(/^\[Current message[^\]]*\]\s*/i, '')
    .replace(/^\[Chat messages since[^\]]*\]\s*(?:Someone:.*\n)*/i, '')
    .replace(/^\[Previous context[^\]]*\]\s*/i, '')
    .replace(/^(User|Someone|Human):\s*/i, '')
    .trim();
}

// ---- Gateway token ----
let GATEWAY_TOKEN = 'no-token';
try {
  GATEWAY_TOKEN = readFileSync(CORE_DIR + '/.gateway-token', 'utf8').trim();
} catch {
  if (process.env.GATEWAY_TOKEN) {
    GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
  } else if (process.env.COREKIT_GATEWAY_TOKEN) {
    GATEWAY_TOKEN = process.env.COREKIT_GATEWAY_TOKEN;
  } else {
    log('WARN', 'No gateway token found');
  }
}

// ---- Agent registry ----
let REGISTRY = { agents: {} };
try {
  REGISTRY = JSON.parse(readFileSync(CORE_DIR + '/corekit/agent-registry.json', 'utf8'));
} catch {
  log('WARN', 'agent-registry.json not found');
}

// ---- Skill index (runtime discovery, replaces static TOOLS.md) ----
function buildSkillIndex() {
  const index = [];
  const skillsDirs = [CORE_DIR + '/skills'];

  // Determine specialty from chat-config.json
  let specialty = '';
  try {
    const cfg = JSON.parse(readFileSync(CORE_DIR + '/corekit/chat-config.json', 'utf8'));
    specialty = cfg.specialty || cfg.agentType || '';
  } catch {}
  if (specialty) {
    skillsDirs.push(CORE_DIR + '/corekit/specialties/' + specialty + '/skills');
  }

  // Also scan custom per-agent skills
  const customDir = CORE_DIR + '/workspace/custom-skills';
  if (existsSync(customDir)) {
    skillsDirs.push(customDir);
  }

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const skillDir = dir + '/' + name;
      const jsonPath = skillDir + '/skill.json';
      if (!existsSync(jsonPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(jsonPath, 'utf8'));
        index.push({
          id: manifest.id || name,
          name: manifest.name || name,
          agent_parts: Array.isArray(manifest.agent_part) ? manifest.agent_part : [manifest.agent_part || 'motor'],
          when_to_use: manifest.when_to_use || '',
          category: manifest.category || '',
          path: skillDir + '/SKILL.md',
        });
      } catch {}
    }
  }
  return index;
}

let SKILL_INDEX = buildSkillIndex();

// Format the full skill index as a readable catalog for execution agents
function formatSkillCatalog(skillIndex) {
  if (!skillIndex?.length) return '';
  const entries = skillIndex.map(s =>
    `- ${s.name} (${s.id}): ${s.when_to_use || s.category || ''}\n  → readFile ${s.path}`
  );
  return `\n\n[AVAILABLE SKILLS]\nBefore using any command tool, read the relevant SKILL.md:\n${entries.join('\n')}\n\nDo NOT guess skill paths. Only the paths listed above exist.\n[END AVAILABLE SKILLS]`;
}

// ---- Project registry (via corekit/lib/projects.mjs, Phase 1A extraction) ----
// NOTE: _projects is initialized later in startupInit() after PRIME_ID/AGENT_ID are set.
// The globals PROJECTS, DEFAULT_PROJECT_ID, PROJECT_CHILDREN provide backward compat
// for direct reads throughout the brain.
let _projects = null; // initialized in startupInit()
let PROJECTS = {};
let PROJECT_CHILDREN = {};
let DEFAULT_PROJECT_ID = null;

function _initProjectRegistry() {
  _projects = createProjectRegistry({
    firestore: _db,
    primeId: PRIME_ID,
    agentId: AGENT_ID,
    agentEmail: AGENT_EMAIL,
    gcpProject: GCP_PROJECT,
    contracts: CONTRACTS,
    logger: log,
    generateId: generateId,
    writeHistory: writeHistory,
  });
}

// Thin wrappers preserving existing call signatures
async function loadProjects() {
  if (!_projects) _initProjectRegistry();
  await _projects.load();
  // Sync globals for backward compat
  PROJECTS = _projects.getAll();
  PROJECT_CHILDREN = _projects.getChildren();
  DEFAULT_PROJECT_ID = _projects.getDefaultId();
}

async function ensureProjectsLoaded() {
  if (!_projects) _initProjectRegistry();
  await _projects.ensureLoaded();
  PROJECTS = _projects.getAll();
  PROJECT_CHILDREN = _projects.getChildren();
  DEFAULT_PROJECT_ID = _projects.getDefaultId();
}

function getAccumulatedProjectContext(projectId) {
  if (!_projects) return { chain: [], context: {} };
  return _projects.getAccumulatedContext(projectId);
}

function validateProjectDepth(parentId) {
  if (!_projects) return true;
  return _projects.validateDepth(parentId);
}

async function checkProjectCompletion(projectId) {
  if (!_projects) return;
  await _projects.checkCompletion(projectId);
}

function hasCircularDependency(sourceId, targetId, envelopes) {
  if (!_projects) return false;
  return _projects.hasCircularDep(sourceId, targetId, envelopes);
}

function validateMissionProjectId(envelope) {
  if (!_projects) {
    if (envelope.type === 'M' && !envelope.project_id) {
      envelope.project_id = DEFAULT_PROJECT_ID;
    }
    return envelope;
  }
  return _projects.validateMissionProject(envelope);
}

async function ensureDefaultProject() {
  if (!_projects) _initProjectRegistry();
  await _projects.ensureDefault();
  DEFAULT_PROJECT_ID = _projects.getDefaultId();
}

function buildProjectContext(projectId, envelopeContext) {
  if (!_projects) return null;
  return _projects.buildContext(projectId, envelopeContext, CORE_DIR);
}

async function checkDependencies(envelope) {
  if (!_projects) return true;
  return _projects.checkDependencies(envelope);
}

async function activateDependents(completedMissionId) {
  if (!_projects) return;
  await _projects.activateDependents(completedMissionId);
}

async function suggestContextPromotions(envelope) {
  if (!_projects) return;
  await _projects.suggestContextPromotions(envelope);
}

// ---- Process engine (via corekit/lib/process-engine.mjs, Phase 1B extraction) ----
// NOTE: _engine is initialized lazily because it depends on brain functions
// (callAgent, writeHistory, etc.) that are defined later in this file.
let _engine = null;
let PROCESSES = {}; // synced from engine for backward compat

function _initProcessEngine() {
  _engine = createProcessEngine({
    firestore: _db,
    vertexText: _vtx,
    projects: _projects,
    agentDispatcher: callAgent,
    logger: log,
    config: {
      coreDir: CORE_DIR,
      primeId: PRIME_ID,
      agentId: AGENT_ID,
      agentEmail: AGENT_EMAIL,
      gcpProject: GCP_PROJECT,
    },
    generateId,
    writeHistory,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    sendNotification: async () => {}, // engine destructures but doesn't call
    createCT,
    suggestContextPromotions,
    buildProjectContext,
    onMissionComplete: async (mission) => {
      // Create delegation result envelope for delivery back to the delegator
      if (!mission.source_meta?.delegation_ref) return;
      const resultMarker = composeDelegationResultMarker({
        targetEmail: mission.source_meta.delegated_from || '',
        ref: mission.source_meta.delegation_ref,
        status: mission.status,
        missionId: mission.id,
        body: toStr(mission.output).substring(0, 500),
      });
      const resultOutputId = generateId('w');
      await firestoreWrite('work', resultOutputId, {
        id: resultOutputId,
        type: 'T',
        parent_id: mission.id,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'complete',
        intent: 'delegation_result',
        title: `Delegation result for ${mission.source_meta.delegation_ref}`,
        instruction: 'Deliver delegation result marker',
        output: resultMarker,
        delivery_status: 'pending',
        delivery_target: mission.source_meta.delegated_from || null,
        delivery_space_id: (mission.project_id && PROJECTS[mission.project_id]?.gchat_space_id) || null,
        delivery_address: makeAddress('gchat', {
          space: (mission.project_id && PROJECTS[mission.project_id]?.gchat_space_id)
            ? `spaces/${PROJECTS[mission.project_id].gchat_space_id}`
            : null,
        }),
        project_id: mission.project_id || null,
        source_channel: 'brain',
        source_meta: { delegation_ref: mission.source_meta.delegation_ref },
        created_at: now(),
        updated_at: now(),
      });
      log('INFO', `Delegation result envelope created: ${resultOutputId} for mission ${mission.id}`);
    },
  });
}

function _ensureEngine() {
  if (!_engine) _initProcessEngine();
}

// Thin wrappers preserving existing call signatures
async function loadProcesses() {
  _ensureEngine();
  await _engine.loadProcesses();
  PROCESSES = _engine.getAllProcesses();
}

async function ensureProcessesLoaded() {
  _ensureEngine();
  await _engine.ensureLoaded();
  PROCESSES = _engine.getAllProcesses();
}

async function createPlan(processId, parameters, projectId, instruction) {
  _ensureEngine();
  return _engine.createPlan(processId, parameters, projectId, instruction);
}

async function approvePlan(planId, approvedBy) {
  _ensureEngine();
  return _engine.approvePlan(planId, approvedBy);
}

async function stampPlan(planId, intake, memoryContext) {
  _ensureEngine();
  return _engine.stampPlan(planId, intake, memoryContext);
}

async function amendPlan(planId, reason, changes, amendedBy) {
  _ensureEngine();
  return _engine.amendPlan(planId, reason, changes, amendedBy);
}

function processToCheckpointPlan(process, parameters) {
  _ensureEngine();
  return _engine.processToCheckpointPlan(process, parameters);
}

async function executeProcess(intake, decision, memoryContext, processId, existingEnvelope) {
  _ensureEngine();
  return _engine.execute(intake, decision, memoryContext, processId, existingEnvelope);
}

async function runProcessPlan(mission, checkpointEnvelopes, memoryContext, startCpIndex, startTaskIndex) {
  _ensureEngine();
  return _engine.runPlan(mission, checkpointEnvelopes, memoryContext, startCpIndex, startTaskIndex);
}

async function resumeProcessPlan(mission) {
  _ensureEngine();
  return _engine.resumePlan(mission);
}





/**
 * Merge two context packets (maps of keyâ†’entry). Child wins on key collision.
 * Both inputs are { key: { kind, ref, url, name, summary, updatedAt, updatedBy } }
 */
function mergeContextPackets(parentCtx, childCtx) {
  if (!parentCtx && !childCtx) return {};
  if (!parentCtx) return { ...(childCtx || {}) };
  if (!childCtx) return { ...(parentCtx || {}) };
  return { ...parentCtx, ...childCtx }; // shallow by key â€” child overrides
}

/**
 * Render a context packet as structured text for brain injection.
 * Handles both rich context entries (kind/ref/summary) and legacy flat values.
 */
function renderContextPacket(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [];
  for (const [key, entry] of Object.entries(ctx)) {
    if (!entry) continue;
    // Rich context entry (has 'kind' or 'summary')
    if (typeof entry === 'object' && (entry.kind || entry.summary)) {
      const kind = entry.kind || 'unknown';
      const name = entry.name || key;
      const line = `${key} (${kind}): ${name}`;
      lines.push(line);
      const details = [];
      if (entry.ref) details.push(`ID: ${entry.ref}`);
      if (entry.url) details.push(`URL: ${entry.url}`);
      if (entry.updatedAt) {
        const dateStr = typeof entry.updatedAt === 'string' ? entry.updatedAt.substring(0, 10) : '';
        const byStr = entry.updatedBy ? ` by ${entry.updatedBy}` : '';
        details.push(`Updated: ${dateStr}${byStr}`);
      }
      if (details.length > 0) lines.push(`  ${details.join(' | ')}`);
      if (entry.summary) lines.push(`  ${entry.summary}`);
    } else {
      // Legacy flat value (string, number, array)
      const val = Array.isArray(entry) ? entry.join(', ') : String(entry);
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join('\n');
}

// buildProjectContext is now a thin wrapper (L282) delegating to projects.mjs

/**
 * Attempt to backfill null-ref context entries after a motor dispatch creates resources.
 * Looks for patterns like folder IDs, sheet IDs, doc IDs in the agent output.
 */
async function backfillContextRefs(envelope, agentOutput) {
  if (!agentOutput || !envelope.context || typeof envelope.context !== 'object') return;
  const nullRefEntries = Object.entries(envelope.context)
    .filter(([, entry]) => entry && typeof entry === 'object' && entry.ref === null);
  if (nullRefEntries.length === 0) return;

  // Extract resource IDs from common creation patterns in motor output
  const patterns = [
    { kind: 'drive_folder', regex: /(?:created folder|folder id|folderId)[:\s]+['"]?([a-zA-Z0-9_-]{20,})['"]?/gi },
    { kind: 'sheet', regex: /(?:created spreadsheet|spreadsheet id|spreadsheetId)[:\s]+['"]?([a-zA-Z0-9_-]{20,})['"]?/gi },
    { kind: 'doc', regex: /(?:created document|document id|documentId)[:\s]+['"]?([a-zA-Z0-9_-]{20,})['"]?/gi },
  ];

  let updated = false;
  for (const [key, entry] of nullRefEntries) {
    for (const { kind, regex } of patterns) {
      if (entry.kind !== kind) continue;
      const match = regex.exec(agentOutput);
      if (match) {
        entry.ref = match[1];
        entry.updatedAt = now();
        entry.updatedBy = `backfill`;
        updated = true;
        log('INFO', `Context backfill: ${key} â†’ ref=${match[1]}`);
        break;
      }
    }
  }

  if (updated) {
    await firestoreWrite('work', envelope.id, { ...envelope, context: envelope.context, updated_at: now() });
    log('INFO', `Context backfill: updated envelope ${envelope.id} with ${nullRefEntries.filter(([,e]) => e.ref !== null).length} refs`);
  }
}

// ---- File read cache (60s TTL) ----
const _fileCache = new Map(); // path â†’ { content, readAt }
const FILE_CACHE_TTL_MS = 60_000;

function cachedReadFile(filePath) {
  const cached = _fileCache.get(filePath);
  if (cached && (Date.now() - cached.readAt) < FILE_CACHE_TTL_MS) {
    return cached.content;
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    _fileCache.set(filePath, { content, readAt: Date.now() });
    return content;
  } catch {
    _fileCache.set(filePath, { content: null, readAt: Date.now() });
    return null;
  }
}

// ---- Responsibility config (via scheduler.mjs, Phase 2 extraction) ----
let _scheduler = null;
let RESPONSIBILITIES = [];

// ---- Firestore REST client (via corekit/lib/firestore.mjs) ----
// FIRESTORE_BASE: still used by 27 direct REST call sites in un-extracted code
// (projects, processes, approvals, etc.). Will be removed when those are extracted.
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const _db = createFirestoreClient({ projectId: GCP_PROJECT, logger: log });

// Thin wrappers preserving existing (collection, docId) call signature.
// The lib client uses full paths; these prepend the prime scope.

async function firestoreWrite(collection, docId, data) {
  // Invariant check: M-type envelope with parent_id should be C-type
  if (collection === 'work' && data && data.type === 'M' && data.parent_id) {
    log('ERROR', `Invariant violation: M-type envelope ${data.id} has parent_id ${data.parent_id}. Correcting to type C.`);
    data.type = 'C';
    data.delivery_status = 'internal';
  }
  // Enforce project_id on all Mission writes (brain-specific guard)
  if (collection === 'work' && data && data.type === 'M') {
    validateMissionProjectId(data);
  }
  return _db.write(`primes/${PRIME_ID}/${collection}/${docId}`, data);
}

async function firestoreRead(collection, docId) {
  return _db.read(`primes/${PRIME_ID}/${collection}/${docId}`);
}

async function firestoreQuery(collection, filters) {
  return _db.query(`primes/${PRIME_ID}`, collection, filters);
}

// ---- Envelope helpers ----
function generateId(prefix = 'w') {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

// ---- Idempotency: step-key derivation (CP2) ----
// Deterministic step key: SHA-256 hash of [envId, iteration, action, target]
// Stable across replays — same inputs always produce the same key
function deriveStepKey(envId, iteration, action, target = '') {
  const input = `${envId}|${iteration}|${action}|${target}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

// Check if a dispatch step has already been recorded in the envelope's step ledger
function isStepComplete(envelope, stepKey) {
  if (!STEP_LEDGER_ENABLED) return false;
  const ledger = envelope.step_ledger || {};
  const entry = ledger[stepKey];
  return entry?.status === 'complete' || entry?.status === 'failed';
}

// Get a previously recorded step result (for skip-on-replay)
function getStepResult(envelope, stepKey) {
  if (!STEP_LEDGER_ENABLED) return null;
  const ledger = envelope.step_ledger || {};
  return ledger[stepKey] || null;
}

// Record a completed dispatch step in the envelope's step ledger
// Persists to Firestore atomically with the envelope update
async function recordStep(envelope, stepKey, result) {
  if (!STEP_LEDGER_ENABLED) return;
  const ledger = envelope.step_ledger || {};
  ledger[stepKey] = {
    status: result.success ? 'complete' : 'failed',
    agent: result.agent || 'unknown',
    ts: now(),
    durationMs: result.durationMs || 0,
    outputHash: result.output
      ? createHash('sha256').update(toStr(result.output)).digest('hex').substring(0, 8)
      : null,
  };
  envelope.step_ledger = ledger;
  await firestoreWrite('work', envelope.id, envelope);
}

// ---- Idempotency: durable claim (CP3) ----
// Firestore-backed processing lock — survives daemon restarts.
// The local `processing` boolean remains as belt-and-suspenders.
async function claimEnvelope(envelopeId) {
  const claimId = `${AGENT_ID}-${Date.now()}`;
  try {
    const env = await firestoreRead('work', envelopeId);
    if (!env) return claimId; // New or missing envelope — claim freely
    if (env.claimed_by) {
      // Check if the existing claim is stale
      const claimAge = Date.now() - (env.claimed_at_ms || 0);
      if (claimAge < CLAIM_STALE_MS) {
        log('WARN', `Claim conflict: ${envelopeId} claimed by ${env.claimed_by} (${Math.round(claimAge / 1000)}s ago)`);
        return null; // Another instance has a valid claim
      }
      log('INFO', `Reclaiming stale envelope ${envelopeId} (claimed ${Math.round(claimAge / 1000)}s ago by ${env.claimed_by})`);
    }
    await firestoreWrite('work', envelopeId, {
      ...env,
      claimed_by: claimId,
      claimed_at_ms: Date.now(),
    });
    return claimId;
  } catch (e) {
    log('WARN', `Claim attempt failed for ${envelopeId}: ${e.message}`);
    return claimId; // Proceed anyway — belt-and-suspenders with local guard
  }
}

async function releaseClaim(envelopeId, claimId) {
  try {
    const env = await firestoreRead('work', envelopeId);
    if (env && env.claimed_by === claimId) {
      env.claimed_by = null;
      env.claimed_at_ms = null;
      await firestoreWrite('work', envelopeId, env);
    }
  } catch (e) {
    log('WARN', `Claim release failed for ${envelopeId}: ${e.message}`);
  }
}

// ---- Gateway HTTP dispatch ----
async function callCortex(mode, payload) {
  const systemPrompt = buildSystemPrompt(mode, payload);
  const userPrompt = `[BRAIN-ORCHESTRATED]\n${buildUserPrompt(mode, payload)}`;

  // Per-agent generation parameters from registry
  const cortexConfig = REGISTRY.agents?.cortex || {};
  const maxTokens = cortexConfig.max_tokens || 32768;
  const temperature = cortexConfig.temperature ?? 0.4;
  const topP = cortexConfig.top_p ?? 0.95;

  log('INFO', `Calling Cortex: mode=${mode} (max_tokens=${maxTokens}, temp=${temperature}, top_p=${topP})`);
  const _cortexStart = Date.now();

  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BRAIN_ROUTE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: temperature,
      top_p: topP,
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });

  const _cortexDuration = Date.now() - _cortexStart;

  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Cortex HTTP error: ${resp.status} ${text.substring(0, 200)}`);
    return { error: `HTTP ${resp.status}`, raw: text };
  }

  const data = await resp.json();

  // Debug: log the response structure to understand the format
  const msg = data.choices?.[0]?.message;
  log('DEBUG', `Cortex response structure: role=${msg?.role}, content_type=${typeof msg?.content}, has_choices=${!!data.choices?.length}`);

  // Extract content — handle both string and array-of-objects formats
  let content = '';
  if (typeof msg?.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg?.content)) {
    // Response may contain array of content blocks (e.g. [{type: "text", text: "..."}])
    content = msg.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
  }

  log('DEBUG', `Cortex raw response (${content.length} chars): ${content.substring(0, 300)}`);

  // Phase 4.3: Attach usage metadata to the parsed result for telemetry
  const parsed = await enforceSchema(content, mode);
  if (parsed && typeof parsed === 'object') {
    parsed.usage = data.usage || null;
    parsed.durationMs = _cortexDuration;
  }
  return parsed;
}

// ---- Prefrontal: work decomposition (the Brief) ----
async function callPrefrontal(payload) {
  const prefrontalConfig = REGISTRY.agents?.prefrontal || {};
  const route = prefrontalConfig.route || 'brain/prefrontal';
  const maxTokens = prefrontalConfig.max_tokens || 32768;
  const temperature = prefrontalConfig.temperature ?? 0.6;
  const topP = prefrontalConfig.top_p ?? 0.95;

  // Build system prompt: prefrontal SOUL + process/project context
  const sysParts = [];
  const soulPaths = [
    CORE_DIR + '/workspace-prefrontal/SOUL.md',
    CORE_DIR + '/workspace/prefrontal/SOUL.md',
  ];
  for (const p of soulPaths) {
    const soul = cachedReadFile(p);
    if (soul) { sysParts.push(`[SOUL — analytical decomposition guidance]\n${soul}`); break; }
  }
  if (Object.keys(PROCESSES).length > 0) {
    sysParts.push(`[PROCESS REGISTRY — known playbooks]\n${JSON.stringify(
      Object.values(PROCESSES).map(p => ({ id: p.id, name: p.name, description: (p.description || '').substring(0, 200) })),
      null, 2
    )}`);
  }
  const envProjectId = payload.envelope?.project_id;
  if (envProjectId && PROJECTS[envProjectId]) {
    const proj = PROJECTS[envProjectId];
    sysParts.push(`[PROJECT CONTEXT]\n${JSON.stringify({
      id: proj.id, name: proj.name, description: proj.description,
      context: proj.context || {},
      team: (proj.team || []).map(m => ({ email: m.email, role: m.role, name: m.name, type: m.type })),
    }, null, 2)}`);
  }
  sysParts.push('You MUST respond with exactly one JSON block and nothing else.');
  const systemPrompt = sysParts.join('\n\n');

  // Build user prompt: instruction + memory + accumulated context
  const analyzePayload = {
    mode: 'analyze',
    instruction: payload.envelope?.instruction || '',
    context_summary: payload.envelope?.context_summary || '',
    memory: payload.memory || {},
    prior_results: payload.prior_results || [],
  };
  const userPrompt = `[BRAIN-ORCHESTRATED]\n${JSON.stringify(analyzePayload)}`;

  log('INFO', `Calling Prefrontal: analyze (max_tokens=${maxTokens}, temp=${temperature}, top_p=${topP})`);
  const start = Date.now();

  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: route,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
    }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });

  const durationMs = Date.now() - start;

  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Prefrontal HTTP error: ${resp.status} ${text.substring(0, 200)}`);
    return null;
  }

  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  let content = '';
  if (typeof msg?.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg?.content)) {
    content = msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  }

  log('INFO', `Prefrontal responded (${content.length} chars, ${durationMs}ms)`);

  const brief = await enforceSchema(content, 'analyze');
  if (brief && brief.parts) {
    const owners = brief.parts.reduce((acc, p) => { acc[p.ownership] = (acc[p.ownership] || 0) + 1; return acc; }, {});
    log('INFO', `Brief: ${brief.parts.length} parts (${Object.entries(owners).map(([k, v]) => `${k}=${v}`).join(', ')}), process_match=${brief.process_match || 'none'}`);
  }
  return brief;
}

function buildSystemPrompt(mode, payload) {
  const parts = [];

  // 1. Read SOUL.md â€” core decision-making guidance
  const soulPaths = [
    CORE_DIR + '/workspace-cortex/SOUL.md',
    CORE_DIR + '/workspace/SOUL.md',
  ];
  let soulContent = null;
  for (const p of soulPaths) {
    soulContent = cachedReadFile(p);
    if (soulContent) break;
  }
  if (soulContent) {
    parts.push(`[SOUL â€” core decision-making guidance]\n${soulContent}`);
  }

  // 2. Read IDENTITY.md â€” who you are
  const identityPaths = [
    CORE_DIR + '/workspace/IDENTITY.md',
  ];
  let identityContent = null;
  for (const p of identityPaths) {
    identityContent = cachedReadFile(p);
    if (identityContent) break;
  }
  if (identityContent) {
    parts.push(`[IDENTITY â€” who you are]\n${identityContent}`);
  }

  // 3. Read MEMORY.md â€” baseline knowledge
  const memoryPaths = [
    CORE_DIR + '/workspace/MEMORY.md',
  ];
  let memoryContent = null;
  for (const p of memoryPaths) {
    memoryContent = cachedReadFile(p);
    if (memoryContent) break;
  }
  if (memoryContent) {
    parts.push(`[MEMORY â€” baseline knowledge]\n${memoryContent}`);
  }


  // 4. Agent registry with tool descriptions
  // Structured agent capabilities summary — more scannable than raw JSON
  const agentSummary = Object.entries(REGISTRY.agents).map(([name, a]) => {
    const tools = (a.tools || []).join(', ') || 'none';
    const intents = (a.intents || []).join(', ');
    return `  - ${name} (intents: ${intents})\n    Description: ${a.description || ''}\n    Tools: [${tools}]\n    Constraints: ${a.constraints || 'none'}`;
  }).join('\n\n');
  parts.push(`[AGENT CAPABILITIES — route tasks to the correct brain part]\n${agentSummary}`);

  // 5. Project registry (if any projects exist)
  if (Object.keys(PROJECTS).length > 0) {
    const projectSummary = Object.values(PROJECTS).map(p => ({
      id: p.id, name: p.name, status: p.status, description: p.description,
      context: p.context || {},
      team: (p.team || []).map(m => ({ email: m.email, role: m.role, name: m.name, type: m.type })),
      gchat_space_id: p.gchat_space_id || null,
    }));
    parts.push(`[PROJECT REGISTRY â€” active work streams with context]\nEach project carries context that applies to all missions within it. When classifying or deciding, identify the relevant project and use its context.\n${JSON.stringify(projectSummary, null, 2)}`);
  }

  // 6. Process registry (if any processes exist)
  if (Object.keys(PROCESSES).length > 0) {
    const processSummary = Object.values(PROCESSES).map(p => ({
      id: p.id, name: p.name, description: p.description,
      version: p.version || 1,
      step_count: (p.steps || []).length,
      parameters: Object.keys(p.parameters || {}),
    }));
    parts.push(`[PROCESS REGISTRY â€” reusable playbooks]\nProcesses are stored, versioned playbooks that define step-by-step workflows. Use the "follow_process" action when work matches an existing process. Available:\n${JSON.stringify(processSummary, null, 2)}`);
  }

  // 6. Mode and JSON constraint
  parts.push(`Mode: ${mode}\nYou MUST respond with exactly one JSON block and nothing else.`);

  return parts.join('\n\n');
}

function buildUserPrompt(mode, payload) {
  if (mode === 'classify') {
    const classifyPayload = {
      mode: 'classify',
      inbound: payload.inbound,
      memory: payload.memory || {},
      core_facts: payload.memory?.recalled || null,
      active_envelopes: payload.active_envelopes || [],
      recent_completed_missions: payload.recent_completed_missions || [],
      classification_guidance: {
        blocked_missions: 'If a blocked mission exists and the user message addresses the blocker or asks to retry/fix/continue the work, classify as "continue" with continue_mission set to the mission ID. Do NOT classify as "attach" for blocked missions â€” use "continue" instead.',
        attach_vs_continue: '"attach" = follow-up info or new instruction for active/waiting work. "continue" = resume blocked/stalled work or retry after failure.',
        dedup_prevention: 'CRITICAL: If a recent_completed_mission has a very similar instruction to the new inbound message (same goal/action), do NOT create a new_mission. Instead classify as "attach" to add follow-up context to the prior mission. Only create new_mission if the inbound is genuinely different work.',
        project_identification: 'If the work matches a known project from the project_registry, set project_id in your response. Not every piece of work belongs to a project.',
        required_processes: 'CRITICAL: Projects may define required_processes â€” activities that MUST go through a specific process. When classifying, if any part of the instruction matches a required_process description on a project, you MUST set project_id to that project. On the decide step, the required process will be surfaced for you to follow.',
      },
    };
    classifyPayload.skill_index = SKILL_INDEX;
    if (Object.keys(PROJECTS).length > 0) {
      classifyPayload.project_registry = Object.values(PROJECTS).map(p => {
        const entry = {
          id: p.id, name: p.name, description: p.description,
          context_summary: JSON.stringify(p.context || {}),
        };
        // Surface required_processes so Cortex can match incoming work
        const rp = p.required_processes || p.context?.required_processes;
        if (rp && Array.isArray(rp) && rp.length > 0) {
          entry.required_processes = rp;
        }
        return entry;
      });
    }
    if (Object.keys(PROCESSES).length > 0) {
      classifyPayload.process_registry = Object.values(PROCESSES).map(p => ({
        id: p.id, name: p.name, description: p.description,
        parameters: Object.keys(p.parameters || {}),
      }));
    }
    return JSON.stringify(classifyPayload);
  }
  if (mode === 'decide') {
    const decidePayload = {
      mode: 'decide',
      envelope: payload.envelope,
      memory: payload.memory || {},
      envelope_context: payload.envelope_context || null,
      agent_registry: REGISTRY.agents,
      prior_results: payload.prior_results || [],
      iteration: payload.iteration || 1,
      pending_intake_count: payload.pending_intake_count || 0,
      pending_queue: payload.pending_queue || [],
    };
    decidePayload.skill_index = SKILL_INDEX;
    // Inject project context if envelope is scoped to a project
    const envProjectId = payload.envelope?.project_id;
    if (envProjectId && PROJECTS[envProjectId]) {
      const proj = PROJECTS[envProjectId];
      decidePayload.project = proj;
      // Surface required_processes explicitly so Cortex sees them prominently
      const rp = proj.required_processes || proj.context?.required_processes;
      if (rp && Array.isArray(rp) && rp.length > 0) {
        decidePayload.required_processes = rp;
      }
    }
    // Inject available processes so Cortex can suggest follow_process
    if (Object.keys(PROCESSES).length > 0) {
      decidePayload.available_processes = Object.values(PROCESSES).map(p => ({
        id: p.id, name: p.name, description: (p.description || '').substring(0, 200),
        step_count: (p.steps || []).length,
        parameters: p.parameters || {},
        intent_keywords: p.intent_keywords || [],
      }));
    }
    // Inject Brief from ANALYZE phase when present
    if (payload.brief) {
      decidePayload.brief = payload.brief;
      decidePayload.dispatch_guidance = {
        rule: 'To commit work from the Brief, use checkpoint_plan. You may provide a full checkpoints array OR just a goal + constraints — prefrontal will structure the detailed plan if you omit checkpoints.',
        minimal_form: '{ action: "checkpoint_plan", goal: "...", constraints: "..." } — prefrontal structures the plan',
        full_form: '{ action: "checkpoint_plan", checkpoints: [...] } — you provide the full structure',
        preference: 'Use the minimal form unless you have specific structural requirements.',
        step_types: 'standard (local work via motor/research), delegation (teammate — set target_email), approval_gate (destructive_or_public risk — operator gate), ask (unresolvable unknowns — use needs_input)',
        sequencing: 'Independent parts fan out within a checkpoint. Dependent parts serialize via checkpoint boundaries.',
        skill_guidance: 'When writing task instructions for motor, name the relevant skills from skill_index that the task will need. Motor will read the SKILL.md for exact syntax.',
      };
    } else {
      // No Brief (non-execution-bound or analysis failed) — fall back to checkpoint_plan guidance
      decidePayload.dispatch_guidance = {
        rule: 'ALL work MUST use checkpoint_plan. One focused task per task entry. Even single-step work is one checkpoint with one task.',
        reasoning: 'Each motor task has a limited step budget. Atomic tasks prevent timeouts and preserve context on failure. The M→C→T hierarchy ensures progress tracking and enables re-planning on failure.',
        skill_guidance: 'When writing task instructions for motor, name the relevant skills from skill_index that the task will need. Motor will read the SKILL.md for exact syntax.',
      };
    }
    return JSON.stringify(decidePayload);
  }
  return JSON.stringify(payload);
}

// parseJsonResponse, repairTruncatedJson, extractBalancedJson
// are now imported from corekit/lib/json-repair.mjs (Phase 0C extraction)

// ---- Gateway HTTP dispatch to agents ----
// ---- Notification summarizer (via notifications.mjs, Phase 3 extraction) ----
let _notifier = null;

function _initNotifier() {
  _notifier = createNotifier({
    vertexText: _vtx,
    firestoreWrite,
    generateId,
    cachedReadFile,
    getGatewayConfig: () => ({ url: GATEWAY_URL, token: GATEWAY_TOKEN, route: BRAIN_ROUTE }),
    getProjects: () => PROJECTS,
    logger: log,
    config: {
      primeId: PRIME_ID,
      agentId: AGENT_ID,
      agentEmail: AGENT_EMAIL,
      coreDir: CORE_DIR,
    },
  });
}

async function summarizeForDelivery(type, rawText, context) {
  if (!_notifier) _initNotifier();
  return _notifier.summarizeForDelivery(type, rawText, context);
}
async function callAgent(agentId, envelope) {
  const agentInfo = REGISTRY.agents[agentId];
  if (!agentInfo) {
    return { success: false, output: null, error: `Unknown agent: ${agentId}`, durationMs: 0 };
  }

  // Pre-flight: check gateway liveness
  const alive = await checkGatewayLiveness();
  if (!alive) {
    return { success: false, output: null, error: 'Gateway unreachable', durationMs: 0 };
  }

  const route = agentInfo.route || `brain/${agentId}`;
  const instruction = envelope.instruction || envelope.task || '';
  const context = envelope.context_summary || '';
  const criteria = envelope.accept_criteria || '';

  // Resolve shared workspace path — mission-scoped for checkpoint tasks
  const workspaceId = envelope._missionId || envelope.parent_id || envelope.id;
  const workspaceDirective = workspaceId
    ? `\n\n## Local Workspace\nYour local working directory is \`${CORE_DIR}/shared/${workspaceId}/\`.\nThis is an **ephemeral** workspace — it is cleaned up when the mission ends.\nUse it for temporary files, intermediate work, and staging.\n\nIf a **Shared Workspace** (Google Drive folder) is listed in the Project Context above, that is the **persistent** source of truth:\n- Pull files you need: \`drive-download <fileId> ${CORE_DIR}/shared/${workspaceId}/<filename>\`\n- Push changes back: \`drive-upload "${CORE_DIR}/shared/${workspaceId}/<filename>" <folderId>\`\n- Organize the shared workspace with clear subfolders (e.g. src/, docs/, configs/)\n- List contents: \`drive-ls <folderId>\`\n\nWrite substantial outputs (plans, reports, code) as FILES, not just text responses.\nYour text response should summarize what you did and reference the filenames.\nPrior step outputs are also saved here — check with \`ls ${CORE_DIR}/shared/${workspaceId}/\`.`
    : '';

  const userMessage = [
    `[BRAIN-ORCHESTRATED]`,
    instruction,
    workspaceDirective,
    envelope._projectContext ? `\n## Project Context\n${envelope._projectContext}` : '',
    envelope._sourceText ? `\n## Original User Request\n${envelope._sourceText}` : '',
    context ? `\n## Context\n${context}` : '',
    criteria ? `\n## Acceptance Criteria\n${criteria}` : '',
    envelope.prior_results_context ? `\n## Prior Work\n${envelope.prior_results_context}` : '',
    envelope.memory_context ? `\n## Relevant Memory\n${envelope.memory_context}` : '',
  ].filter(Boolean).join('\n');

  // Per-agent generation parameters from registry
  const agentConfig = REGISTRY.agents?.[agentId] || {};
  const maxTokens = agentConfig.max_tokens || 16384;
  const temperature = agentConfig.temperature ?? 0.5;
  const topP = agentConfig.top_p ?? 0.9;

  log('INFO', `Dispatching to ${agentId} via ${route} (max_tokens=${maxTokens}, temp=${temperature}, top_p=${topP})`);
  const start = Date.now();

  try {
    const resp = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: route,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: maxTokens,
        temperature: temperature,
        top_p: topP,
      }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });

    const durationMs = Date.now() - start;

    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Agent ${agentId} HTTP error: ${resp.status} ${text.substring(0, 200)}`);
      return { success: false, output: null, error: `HTTP ${resp.status}`, durationMs };
    }

    const data = await resp.json();
    let content = '';
    const msg = data.choices?.[0]?.message;
    if (typeof msg?.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg?.content)) {
      content = msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
    }

    log('INFO', `Agent ${agentId} responded (${content.length} chars, ${durationMs}ms)`);

    // callAgent is a pure transport function: HTTP 200 → success: true.
    // Content inspection (verdict detection, motor failure patterns) is the
    // caller's responsibility. Moved to checkpoint-executor in Phase 3.1.
    // Phase 4.3: Pass through usage metadata for telemetry
    return { success: true, output: content, error: null, durationMs, usage: data.usage || null };
  } catch (e) {
    const durationMs = Date.now() - start;
    const isTimeout = e.name === 'TimeoutError' || e.message?.includes('abort');
    log(isTimeout ? 'WARN' : 'ERROR', `Agent ${agentId} ${isTimeout ? 'timed out' : 'dispatch error'}: ${e.message} (${durationMs}ms)`);
    return { success: false, output: null, error: isTimeout ? `The operation timed out after ${Math.round(durationMs / 1000)}s` : e.message, durationMs, timedOut: isTimeout };
  }
}

// ---- Gateway liveness check ----
async function checkGatewayLiveness() {
  try {
    const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    log('WARN', 'Gateway liveness check failed');
    return false;
  }
}

// ---- Queue awareness: pending intake with ordered details ----
async function getPendingIntakeQueue() {
  try {
    const pending = await firestoreQuery('intake', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ]);
    const filtered = pending.filter(item => {
      const targetAgentId = item.source_meta?.agentId;
      return !targetAgentId || targetAgentId === AGENT_ID;
    });
    return {
      count: filtered.length,
      queue: filtered.map((item, i) => ({
        position: i + 1,
        text: (item.text || '').substring(0, 120),
        source: item.source || 'unknown',
      })),
    };
  } catch {
    return { count: 0, queue: [] };
  }
}

// ---- Memory: recall context via temporal-memory agent ----
// Episodic retrieval: pre-fetches MEMORY.md, core-memory (query-filtered + recent),
// work-ledger digest (7d), and cue-searched work history (30d/180d), then passes
// all candidates to temporal-memory for synthesis. Escalation allows temporal-memory
// to request deeper history (one bounded retry).
async function recallMemory(query, context = {}) {
  try {
    // Build enriched query from multiple sources
    const queryParts = [query];
    if (context.instruction) queryParts.push(`Task: ${context.instruction}`);
    if (context.context_summary) queryParts.push(`Context: ${context.context_summary}`);
    const enrichedQuery = queryParts.join('\n');
    const scope = context.scope || 'targeted';
    const cues = context.cues || extractCues(enrichedQuery);

    log('INFO', `Memory recall: scope=${scope} cues=[${cues.slice(0, 5).join(',')}] query="${enrichedQuery.substring(0, 120)}"`);

    // ---- Layer A: Working Memory (MEMORY.md) ----
    const memoryParts = [];
    const memoryPath = `${CORE_DIR}/workspace/MEMORY.md`;
    try {
      if (existsSync(memoryPath)) {
        const memContent = readFileSync(memoryPath, 'utf8').trim();
        if (memContent) memoryParts.push(`## Working Memory (MEMORY.md)\n${memContent}`);
      }
    } catch (e) {
      log('WARN', `Memory recall: MEMORY.md read failed: ${e.message}`);
    }

    // ---- Layer B: Core Memory (Firestore) — query-filtered + recent scan, deduped ----
    const coreMemScript = `${CORE_DIR}/bin/core-memory-read`;
    const seenCoreIds = new Set();
    if (existsSync(coreMemScript)) {
      // B1: query-filtered core memory
      if (cues.length > 0) {
        try {
          const coreQueryResult = execFileSync(coreMemScript, [
            '--query', cues.slice(0, 4).join(' '),
            '--status', 'active', '--limit', '10',
          ], { timeout: 10000, stdio: 'pipe', env: { ...process.env, CORE_DIR } });
          const coreQueryText = coreQueryResult.toString().trim();
          if (coreQueryText && !coreQueryText.includes('0 entries') && !coreQueryText.includes('No core memory')) {
            memoryParts.push(`## Core Memory (query: ${cues.slice(0, 4).join(' ')})\n${coreQueryText}`);
            // Extract IDs to dedup against recent scan
            for (const m of coreQueryText.matchAll(/\(([a-f0-9-]{8,})\)/g)) seenCoreIds.add(m[1]);
          }
        } catch (e) {
          log('WARN', `Memory recall: core-memory-read --query failed: ${e.message}`);
        }
      }
      // B2: recent core memory (30d window)
      try {
        const coreRecentResult = execFileSync(coreMemScript, [
          '--status', 'active', '--since', '30d', '--limit', '8',
        ], { timeout: 10000, stdio: 'pipe', env: { ...process.env, CORE_DIR } });
        const coreRecentText = coreRecentResult.toString().trim();
        if (coreRecentText && !coreRecentText.includes('0 entries') && !coreRecentText.includes('No core memory')) {
          // Simple dedup: only add if it has entries not already seen
          const hasNew = ![...coreRecentText.matchAll(/\(([a-f0-9-]{8,})\)/g)].every(m => seenCoreIds.has(m[1]));
          if (hasNew || seenCoreIds.size === 0) {
            memoryParts.push(`## Core Memory (recent 30d)\n${coreRecentText}`);
          }
        }
      } catch (e) {
        log('WARN', `Memory recall: core-memory-read --since 30d failed: ${e.message}`);
      }
    }

    // ---- Layer C: Recent Work Digest (7 days) ----
    let layerCHits = 0;
    try {
      const digest = await recentWorkDigest({
        firestoreQuery,
        owner: AGENT_EMAIL || AGENT_ID,
        sinceDays: 7,
        limit: 50,
      });
      if (digest) {
        memoryParts.push(digest);
        layerCHits = (digest.match(/^- /gm) || []).length;
      }
    } catch (e) {
      log('WARN', `Memory recall: recentWorkDigest failed: ${e.message}`);
    }

    // ---- Layer D: Episodic Work Search (cue-driven) ----
    let layerDHits = 0;
    const sinceDays = scope === 'deep' ? 180 : 30;
    const searchLimit = scope === 'deep' ? 12 : 6;
    if (cues.length > 0) {
      try {
        const workHits = await searchWork({
          firestoreQuery,
          owner: AGENT_EMAIL || AGENT_ID,
          cues,
          sinceDays,
          limit: searchLimit,
        });
        layerDHits = workHits.length;
        if (workHits.length > 0) {
          const hitLines = workHits.map(h =>
            `- [${h.type}] ${h.title || h.instruction_blurb} (id:${h.id}, ${h.completed_at || h.created_at}, score:${h.score.toFixed(2)})\n  ${h.output_blurb || ''}`.trim()
          ).join('\n');
          memoryParts.push(`## Episodic Work History (${sinceDays}d, ${workHits.length} hits)\n${hitLines}`);
        }
      } catch (e) {
        log('WARN', `Memory recall: searchWork failed: ${e.message}`);
      }
    }

    log('INFO', `[TELEMETRY] recall_layers scope=${scope} cues=${cues.length} coreIds=${seenCoreIds.size} digestHits=${layerCHits} workHits=${layerDHits}`);

    // ---- Trim candidates to budget ----
    const CANDIDATE_BUDGET_CHARS = 8000;
    let candidateBlock = memoryParts.join('\n\n');
    if (candidateBlock.length > CANDIDATE_BUDGET_CHARS) {
      candidateBlock = candidateBlock.substring(0, CANDIDATE_BUDGET_CHARS) + '\n[...trimmed to budget]';
    }

    // ---- Pass-1: temporal-memory synthesis ----
    const preloadedContext = candidateBlock
      ? `\n\n--- PRE-LOADED MEMORY DATA ---\n${candidateBlock}\n--- END PRE-LOADED DATA ---`
      : '';

    const pass1Instruction = scope === 'deep'
      ? `Construct a focused recall package for:\n${enrichedQuery}${preloadedContext}`
      : `Recall all relevant context for:\n${enrichedQuery}\n\nIf answering requires work history older or broader than the candidates below, emit exactly {"recall_escalate": true, "cues": [...], "reason": "..."} and nothing else.${preloadedContext}`;

    const result = await callAgent('temporal-memory', {
      instruction: pass1Instruction,
      accept_criteria: 'Return relevant memory context, "No relevant context found", or an escalation object',
    });

    if (!result.success || !result.output) {
      log('INFO', `Memory recall: no context (${result.durationMs}ms)`);
      return {};
    }

    const pass1Output = toStr(result.output);

    // ---- Check for escalation ----
    if (scope !== 'deep') {
      try {
        const escalation = JSON.parse(pass1Output);
        if (escalation && escalation.recall_escalate === true) {
          log('INFO', `Memory recall: escalation requested — reason: ${escalation.reason}, refined cues: [${(escalation.cues || []).join(',')}]`);
          // Deep pass: wider search window
          const deepCues = escalation.cues && escalation.cues.length > 0 ? escalation.cues : cues;
          const deepHits = await searchWork({
            firestoreQuery,
            owner: AGENT_EMAIL || AGENT_ID,
            cues: deepCues,
            sinceDays: 180,
            limit: 12,
          });
          if (deepHits.length > 0) {
            const deepLines = deepHits.map(h =>
              `- [${h.type}] ${h.title || h.instruction_blurb} (id:${h.id}, ${h.completed_at || h.created_at}, score:${h.score.toFixed(2)})\n  ${h.output_blurb || ''}`.trim()
            ).join('\n');
            const deepBlock = `\n\n## Deep Work History (180d, ${deepHits.length} hits)\n${deepLines}`;
            const pass2Context = `\n\n--- PRE-LOADED MEMORY DATA ---\n${candidateBlock}${deepBlock}\n--- END PRE-LOADED DATA ---`;
            const pass2 = await callAgent('temporal-memory', {
              instruction: `Construct a focused recall package (no further escalation) for:\n${enrichedQuery}${pass2Context}`,
              accept_criteria: 'Return relevant memory context or "No relevant context found"',
            });
            if (pass2.success && pass2.output) {
              const recalled = toStr(pass2.output).substring(0, 3000);
              log('INFO', `Memory recalled (escalated): ${recalled.length} chars (pass1:${result.durationMs}ms pass2:${pass2.durationMs}ms)`);
              return { recalled };
            }
          }
          // Escalation requested but no deep hits found — fall through to pass-1
          log('INFO', `Memory recall: escalation found 0 deep hits, using pass-1 context`);
        }
      } catch (_) {
        // Not valid JSON — pass-1 returned a normal text package, not an escalation
      }
    }

    // ---- Return pass-1 result ----
    const recalled = pass1Output.substring(0, 3000);
    log('INFO', `Memory recalled: ${recalled.length} chars (${result.durationMs}ms)`);
    return { recalled };
  } catch (e) {
    log('WARN', `Memory recall failed: ${e.message}`);
    return {};
  }
}

// ---- Memory: write completed work deterministically ----
// Appends to MEMORY.md (working memory) for each completed envelope.
// Core memory (Firestore) is NOT auto-written here — that creates noise entries
// like "Completed M: [raw chat messages]..." which pollute long-term storage.
// Core memory writes happen via:
//   1. Motor tool calls: core-memory-write (intentional, structured facts)
//   2. Nightly consolidation: p-memory-consolidate process (curated promotions)
async function writeMemory(envelope) {
  try {
    const instruction = toStr(envelope.instruction).substring(0, 200);

    // 2. Append one-line summary to MEMORY.md (working memory accumulates during the day)
    const memoryPath = `${CORE_DIR}/workspace/MEMORY.md`;
    if (existsSync(memoryPath)) {
      const currentSize = readFileSync(memoryPath, 'utf8').length;
      if (currentSize < 3000) { // Size guard — prevent unbounded growth
        const datestamp = new Date().toISOString().substring(0, 10);
        const oneLiner = `- [${datestamp}] ${envelope.type}: ${instruction.substring(0, 120)}\n`;
        appendFileSync(memoryPath, oneLiner);
        log('INFO', `Memory write: MEMORY.md appended (${currentSize + oneLiner.length} chars)`);
      } else {
        log('INFO', `Memory write: MEMORY.md at ${currentSize} chars, skipping append (await consolidation)`);
      }
    }

    // 3. Mark envelope as memory-written (for archival)
    const token = await getAuthToken();
    if (token) {
      const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/work/${envelope.id}?updateMask.fieldPaths=memory_written`;
      const patchResp = await fetch(url, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { memory_written: { booleanValue: true } } }),
      });
      if (!patchResp.ok) {
        log('ERROR', `memory_written PATCH failed for ${envelope.id}: ${patchResp.status}`);
      }
    }
  } catch (e) {
    log('WARN', `Memory write failed: ${e.message}`);
  }
}

// ---- completeEnvelope: unified completion/blocking ceremony ----
// Phase 2.1: All terminal state transitions go through this single function.
// Ensures consistent execution of the full lifecycle:
//   fields → delivery → artifacts → write → history → memory →
//   cleanup → dependents → project → events → delegation → promotion
async function completeEnvelope(envelope, opts) {
  const {
    status,
    output,
    historyDetail,
    blocker = null,
    blockerType = null,
    eventType = status === 'blocked' ? 'on_failure' : 'on_complete',
    skipArtifacts = false,
    skipMemory = false,
    skipCleanup = false,
  } = opts;

  if (envelope.type === 'M' && envelope.parent_id) {
    log('ERROR', `Invariant violation: M-type envelope ${envelope.id} has parent_id ${envelope.parent_id}. Correcting to type C.`);
    envelope.type = 'C';
    envelope.delivery_status = 'internal';
  }

  // Step 1: Set envelope fields
  envelope.output = output;
  envelope.status = status;
  envelope.updated_at = now();

  if (status === 'complete') {
    envelope.completed_at = now();
  } else if (status === 'blocked') {
    envelope.blocker = blocker || 'Unknown blocker';
    envelope.blocker_type = blockerType || 'other';
    envelope.blocked_at = now();
  }

  // Step 2: Set delivery for top-level envelopes
  if (!envelope.parent_id) {
    envelope.delivery_status = 'pending';
    envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
  }

  // Step 3: Publish artifacts (before cleanup, so shared/ files exist)
  if (!skipArtifacts && envelope.type === 'M') {
    try {
      const artifactLinks = await publishArtifacts(envelope);
      if (artifactLinks && artifactLinks.length > 0) {
        const linkText = artifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
        envelope.output = (envelope.output || '') + `\n\n📌 **Artifacts published to Drive:**\n${linkText}`;
      }
    } catch (e) {
      log('WARN', `Artifact publishing failed: ${e.message}`);
    }
  }

  // Step 4: Write to Firestore + history
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(
    envelope.id, 'active', status, 'brain',
    historyDetail || `${status}: ${toStr(output).substring(0, 200)}`
  );
  log('INFO', `Envelope ${envelope.id} ${status} (${historyDetail || ''})`);

  // Phase 4.3: Token usage summary
  if (opts.tokenUsage && opts.tokenUsage.callCount > 0) {
    const u = opts.tokenUsage;
    log('INFO', `[TELEMETRY] mission_total mission=${envelope.id} calls=${u.callCount} input=${u.totalInput} output=${u.totalOutput} cached=${u.totalCached}`);
  }

  // Step 5: Memory + cleanup
  if (!skipMemory) {
    try { await writeMemory(envelope); } catch (e) {
      log('WARN', `Memory write failed during completion: ${e.message}`);
    }
  }
  if (!skipCleanup) {
    try { await cleanupSharedWorkspace(envelope.id); } catch (e) {
      log('WARN', `Workspace cleanup failed: ${e.message}`);
    }
  }

  // Step 6: Mission-only post-completion
  if (envelope.type === 'M') {
    try { await activateDependents(envelope.id); } catch (e) {
      log('WARN', `activateDependents failed: ${e.message}`);
    }
    if (envelope.project_id) {
      try { await checkProjectCompletion(envelope.project_id); } catch (e) {
        log('WARN', `checkProjectCompletion failed: ${e.message}`);
      }
    }
    try {
      await fireEventResponsibilities(eventType, {
        mission_id: envelope.id,
        project_id: envelope.project_id,
      });
    } catch (e) {
      log('WARN', `fireEventResponsibilities failed: ${e.message}`);
    }

    // Delegation result reply
    if (status === 'complete' && envelope.source_meta?.delegation_ref) {
      try {
        const resultMarker = composeDelegationResultMarker({
          targetEmail: envelope.source_meta.delegated_from || '',
          ref: envelope.source_meta.delegation_ref,
          status: envelope.status,
          missionId: envelope.id,
          body: toStr(envelope.output).substring(0, 500),
        });
        const resultOutputId = generateId('w');
        await firestoreWrite('work', resultOutputId, {
          id: resultOutputId,
          type: 'T',
          parent_id: envelope.id,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'delegation_result',
          title: `Delegation result for ${envelope.source_meta.delegation_ref}`,
          instruction: 'Deliver delegation result marker',
          output: resultMarker,
          delivery_status: 'pending',
          delivery_target: envelope.source_meta.delegated_from || null,
          delivery_space_id: (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id) || null,
          delivery_address: makeAddress('gchat', {
            space: (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id)
              ? `spaces/${PROJECTS[envelope.project_id].gchat_space_id}`
              : null,
          }),
          project_id: envelope.project_id || null,
          source_channel: 'brain',
          source_meta: { delegation_ref: envelope.source_meta.delegation_ref },
          created_at: now(),
          updated_at: now(),
        });
        log('INFO', `Delegation result envelope created: ${resultOutputId}`);
      } catch (e) {
        log('WARN', `Failed to create delegation result envelope: ${e.message}`);
      }
    }

    // Context promotion
    if (envelope.project_id && envelope.context) {
      try { await suggestContextPromotions(envelope); } catch (e) {
        log('WARN', `suggestContextPromotions failed: ${e.message}`);
      }
    }
  }
}

// ---- Active envelope scan: query for in-progress work ----
async function scanActiveEnvelopes() {
  try {
    // Query all live statuses â€” active, waiting, needs_input, blocked
    const statuses = ['active', 'waiting', 'needs_input', 'blocked'];
    let allEnvelopes = [];
    for (const status of statuses) {
      const envs = await firestoreQuery('work', [
        { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
        { field: 'status', op: 'EQUAL', value: { stringValue: status } },
      ]);
      allEnvelopes.push(...envs);
    }
    const summaries = allEnvelopes
      .filter(env => !env.parent_id) // Only top-level envelopes
      .map(env => ({
        id: env.id,
        type: env.type,
        instruction: toStr(env.instruction).substring(0, 200),
        status: env.status,
        blocker: env.blocker || null,
        blocker_type: env.blocker_type || null,
        updated_at: env.updated_at,
      }));
    if (summaries.length > 0) {
      log('INFO', `Active/blocked envelopes: ${summaries.length} found (${summaries.map(s => s.status).join(', ')})`);
    }
    return summaries;
  } catch (e) {
    log('WARN', `Active envelope scan failed: ${e.message}`);
    return [];
  }
}

// ---- Recent mission scan (for ack context) ----
async function scanRecentMissions(limit = 5) {
  try {
    // Query completed work envelopes (utilizes existing index on owner + status + created_at)
    const recent = await firestoreQuery('work', [
      { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
      { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } },
    ]);
    
    // Filter to Missions (type: M) in memory to avoid new composite index requirement
    return recent
      .filter(e => e.type === 'M')
      .sort((a, b) => (b.completed_at || b.updated_at || '').localeCompare(a.completed_at || a.updated_at || ''))
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        instruction: toStr(e.instruction).substring(0, 120),
        output: (typeof e.output === 'string' ? e.output : JSON.stringify(e.output) || '').substring(0, 150),
        status: e.status,
        completed_at: e.completed_at || e.updated_at,
        project_id: e.project_id || null,
      }));
  } catch (e) {
    log('WARN', `Recent mission scan failed: ${e.message}`);
    return [];
  }
}

// ---- Status update delivery (via notifications.mjs) ----
async function deliverStatusUpdate(envelopeId, message) {
  if (!_notifier) _initNotifier();
  await _notifier.writeStatusUpdate(envelopeId, message);
}

// ---- Periodic envelope archival (via archival.mjs, Phase 2 extraction) ----
let _archiver = null;

function _initArchiver() {
  _archiver = createArchivalSweeper({
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    logger: log,
    config: {
      primeId: PRIME_ID,
      staleCleanupHours: STALE_CLEANUP_HOURS,
      archiveAgeDays: ARCHIVE_AGE_DAYS,
      needsInputTimeoutHours: NEEDS_INPUT_TIMEOUT_HOURS,
    },
  });
}

async function archiveEnvelopes() {
  if (!_archiver) _initArchiver();
  await _archiver.sweep();
}

// ---- Quick ACK + message extraction (via notifications.mjs) ----
async function generateAck(intakeText, activeEnvelopes, recentMissions) {
  if (!_notifier) _initNotifier();
  return _notifier.generateAck(intakeText, activeEnvelopes, recentMissions);
}

function extractCurrentMessage(intakeText) {
  if (!_notifier) _initNotifier();
  return _notifier.extractCurrentMessage(intakeText);
}
// ---- Intake processing (Phase 3: memory + active scan + attach) ----
async function processIntake(intake) {
  await ensureProjectsLoaded();
  await ensureProcessesLoaded();
  log('INFO', `Processing intake: ${intake.id} from ${intake.source}`);

  // Extract the raw user message (verbatim) from the composite intake.
  // This preserves URLs, code snippets, and data that cortex classify may summarize away.
  const sourceText = extractCurrentMessage(intake.text);

  // Claim the intake
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'claimed',
    claimed_at: now(),
  });

  // ---- Delegation early branch ----
  // If intake has delegation_ref, skip LLM classify entirely.
  // Create mission deterministically and register as child on parent envelope.
  const delegationRef = intake.source_meta?.delegation_ref;
  if (delegationRef) {
    log('INFO', `Delegation intake detected: ref=${delegationRef} from=${intake.source_meta.delegated_from}`);

    // Dedup: check for existing non-terminal mission with same delegation_ref
    try {
      const existing = await firestoreQuery('work', [
        { field: 'source_meta.delegation_ref', op: 'EQUAL', value: { stringValue: delegationRef } },
      ]);
      const active = existing.filter(e => e.status !== 'complete' && e.status !== 'failed' && e.status !== 'cancelled');
      if (active.length > 0) {
        log('INFO', `Delegation dedup: mission ${active[0].id} already in progress for ref ${delegationRef}, skipping`);
        return;
      }
    } catch (e) {
      log('WARN', `Delegation dedup check failed (${e.message}), proceeding`);
    }

    // Ref validation: verify parent envelope exists
    let parentEnvelope = null;
    try {
      parentEnvelope = await firestoreRead('work', delegationRef);
    } catch { /* ignore */ }
    if (!parentEnvelope) {
      log('WARN', `Delegation ref ${delegationRef} not found in work collection, treating as normal intake`);
      // Fall through to normal classify path
    } else {
      // Create M envelope deterministically (no LLM classify)
      const delegationBody = intake.source_meta.delegation_body || intake.text;
      const delegationProject = intake.source_meta.delegation_project || null;
      const memoryContext = await recallMemory(delegationBody);
      const envelopeId = generateId('w');

      const envelope = {
        id: envelopeId,
        type: 'M',
        parent_id: null,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'pending',
        intent: 'execute',
        title: `Delegation: ${delegationBody.substring(0, 80)}`,
        instruction: delegationBody,
        accept_criteria: null,
        context_summary: `Delegated from ${intake.source_meta.delegated_from || 'unknown'}`,
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: intake.source,
        source_meta: {
          ...(intake.source_meta || {}),
          delegation_ref: delegationRef,
          delegated_from: intake.source_meta.delegated_from || null,
        },
        project_id: delegationProject !== 'none' ? delegationProject : DEFAULT_PROJECT_ID,
        context: null,
        source_text: sourceText || null,
        created_at: now(),
        started_at: null,
        completed_at: null,
        updated_at: now(),
        iteration: 0,
        memory_context: memoryContext,
        delivery_status: 'internal',
      };

      await firestoreWrite('work', envelopeId, envelope);
      await writeHistory(envelopeId, null, 'pending', 'brain', `Delegation from ${intake.source_meta.delegated_from || 'unknown'} (ref: ${delegationRef})`);
      log('INFO', `Created delegation mission: ${envelopeId} for ref ${delegationRef}`);

      // Register as child on parent envelope (cross-agent Firestore write)
      try {
        const updatedChildren = [...(parentEnvelope.children || []), envelopeId];
        await firestoreWrite('work', delegationRef, {
          ...parentEnvelope,
          children: updatedChildren,
          updated_at: now(),
        });
        log('INFO', `Registered ${envelopeId} as child on parent ${delegationRef}`);
      } catch (e) {
        log('WARN', `Failed to register child on parent ${delegationRef}: ${e.message}`);
      }

      // Process the delegation mission
      await processEnvelope(envelope, memoryContext);
      return;
    }
  }

  // Phase 3: Active envelope scan (moved before ACK for mission-aware acknowledgments)
  const activeEnvelopes = await scanActiveEnvelopes();

  // (Quick ack moved to after classify â€” see below)

  // Phase 3+: Dual memory recall
  // First recall: ambient context from raw inbound text (helps classify)
  const ambientMemory = await recallMemory(intake.text);

  // Call Cortex in classify mode (with ambient memory + recent missions for dedup)
  const recentMissionsForClassify = await scanRecentMissions(5);
  const decision = await callCortex('classify', {
    inbound: {
      text: intake.text,
      source: intake.source,
      source_meta: intake.source_meta || {},
    },
    memory: ambientMemory,
    active_envelopes: activeEnvelopes,
    recent_completed_missions: recentMissionsForClassify,
  });

  // Second recall: enriched with classify results (instruction, context_summary)
  // This gives processEnvelope much better memory context for the decide loop
  let memoryContext = ambientMemory;
  if (!decision.error && (decision.instruction || decision.context_summary)) {
    const enrichedMemory = await recallMemory(intake.text, {
      instruction: decision.instruction,
      context_summary: decision.context_summary,
    });
    // Merge: prefer enriched recall if it found context
    if (enrichedMemory.recalled && enrichedMemory.recalled !== ambientMemory.recalled) {
      const combined = [
        ambientMemory.recalled || '',
        enrichedMemory.recalled || '',
      ].filter(Boolean).join('\n\n---\n\n');
      memoryContext = { recalled: combined.substring(0, 4000) };
      log('INFO', `Enriched memory recall: ${memoryContext.recalled.length} chars (combined)`);
    }
  }

  if (decision.error) {
    log('ERROR', `Classify failed for intake ${intake.id}: ${JSON.stringify(decision)}`);
    // Revert to pending for retry on next poll
    await firestoreWrite('intake', intake.id, { ...intake, status: 'pending', claimed_at: null });
    log('INFO', `Intake ${intake.id} reverted to pending for retry`);
    return;
  }

  log('INFO', `Classify result: ${decision.classification || decision.action}`);

  // Normalize classification
  const classification = decision.classification || 'new_mission';

  // Quick ack â€” generate text now, inject as Câ†’T after M envelope is created
  let pendingAckText = null;
  if (intake.source && intake.source !== 'brain' && intake.source !== 'system' && !intake.quick_ack_sent
      && (classification === 'new_mission' || classification === 'continue' || classification === 'attach')) {
    const recentMissions = await scanRecentMissions(5);
    pendingAckText = await generateAck(intake.text || '', activeEnvelopes, recentMissions);
    intake.quick_ack_sent = true;
    await firestoreWrite('intake', intake.id, {
      ...intake,
      status: 'claimed',
      claimed_at: now(),
      quick_ack_sent: true,
    });
  }

  // ---- Process routing: deterministic execution for known processes ----
  if (classification === 'new_mission') {
    const processId = decision.process_id || decision.processId;
    if (processId) {
      await ensureProcessesLoaded();
      if (PROCESSES[processId]) {
        log('INFO', `Process route: '${processId}' detected â€” routing to executeProcess`);
        const processResult = await executeProcess(intake, decision, memoryContext, processId);
        if (processResult !== 'fallback_to_decide') return;
        log('INFO', `Process '${processId}' fell back to decide loop â€” continuing with normal flow`);
      }
    }
  }

  // ---- Hard dedup guard: prevent duplicate active missions ----
  if (classification === 'new_mission' && activeEnvelopes.length > 0) {
    const newInst = toStr(decision.instruction || intake.text).toLowerCase().substring(0, 120);
    const duplicate = activeEnvelopes.find(ae => {
      const aeInst = (ae.instruction || '').toLowerCase();
      // Simple similarity: shared prefix of meaningful length
      const minLen = Math.min(newInst.length, aeInst.length);
      if (minLen < 20) return false;
      let matched = 0;
      const words1 = newInst.split(/\s+/);
      const words2 = aeInst.split(/\s+/);
      for (const w of words1) {
        if (w.length > 3 && words2.includes(w)) matched++;
      }
      return matched >= 3 && matched / words1.length > 0.4;
    });
    if (duplicate) {
      log('WARN', `Dedup guard: suppressing new_mission â€” similar active envelope ${duplicate.id} exists. Forcing attach.`);
      decision.classification = 'attach';
      decision.attach_to = duplicate.id;
      await handleAttach(intake, decision, memoryContext, pendingAckText);
      return;
    }
  }

  // Hard dedup guard #2: prevent duplicate of recently completed missions
  if (classification === 'new_mission' && recentMissionsForClassify.length > 0) {
    const newInstC = toStr(decision.instruction || intake.text).toLowerCase().substring(0, 120);
    const completedDup = recentMissionsForClassify.find(rm => {
      const rmInst = (rm.instruction || '').toLowerCase();
      const minLen = Math.min(newInstC.length, rmInst.length);
      if (minLen < 20) return false;
      const words1 = newInstC.split(/\s+/);
      const words2 = rmInst.split(/\s+/);
      let matched = 0;
      for (const w of words1) {
        if (w.length > 3 && words2.includes(w)) matched++;
      }
      return matched >= 3 && matched / words1.length > 0.4;
    });
    if (completedDup) {
      log('WARN', `Dedup guard: suppressing new_mission — similar completed mission ${completedDup.id} exists (completed ${completedDup.completed_at}). Skipping intake.`);
      await firestoreWrite('intake', intake.id, { ...intake, status: 'deduped', deduped_against: completedDup.id, deduped_at: now() });
      return;
    }
  }

  // Phase 3: Handle attach classification (follow-up to existing work)
  if (classification === 'attach') {
    await handleAttach(intake, decision, memoryContext, pendingAckText);
    return;
  }

  // Handle continue classification (resume a blocked mission)
  if (classification === 'continue') {
    await handleContinue(intake, decision, memoryContext, pendingAckText);
    return;
  }

  // Handle cancel classification (explicitly abandon work)
  if (classification === 'cancel') {
    await handleCancel(intake, decision);
    return;
  }

  const envelopeId = generateId('w');

  const envelope = {
    id: envelopeId,
    type: 'M',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'pending',
    intent: decision.intent || 'decide',
    title: await generateTitle(decision.instruction || stripChatFraming(intake.text), 'mission'),
    instruction: decision.instruction || stripChatFraming(intake.text),
    accept_criteria: decision.accept_criteria || null,
    context_summary: decision.context_summary || null,
    output: null,
    children: [],
    context_forward: null,
    error: null,
    source_channel: intake.source,
    source_meta: intake.source_meta || {},
    project_id: decision.project_id || DEFAULT_PROJECT_ID,
    context: decision.context || null,
    source_text: sourceText || null, // Raw user message â€” preserved verbatim for child dispatches
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: memoryContext, // Phase 3: pass memory to processEnvelope
    delivery_status: 'internal', // Not deliverable until synthesized
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=${envelope.type})`);

  // Write history entry
  await writeHistory(envelopeId, null, 'pending', 'brain', 'Created from intake ' + intake.id);

  // Inject ack as first Câ†’T under the mission
  if (pendingAckText) {
    await createCT(envelope, {
      checkpointTitle: 'Acknowledge receipt',
      taskTitle: 'Write acknowledgment',
      taskOutput: pendingAckText,
      taskIntent: 'ack',
      deliveryStatus: 'pending',
      deliveryAddress: addressFromMeta(intake.source_meta, intake.source),
      ctKey: `ack-${envelope.id}`,
    });
    await firestoreWrite('work', envelope.id, envelope);
    log('INFO', `Ack injected as Câ†’T under ${envelopeId}`);
  }

  // Process the envelope (pass memory context to avoid re-recall)
  await processEnvelope(envelope, memoryContext);
}

// ---- Attach handler: follow-up to existing work ----
async function handleAttach(intake, decision, memoryContext, pendingAckText = null) {
  const targetId = decision.attach_to || decision.attach_to_mission || decision.continue_mission;
  log('INFO', `Attach: intake ${intake.id} â†’ target ${targetId}`);

  if (!targetId) {
    log('WARN', `Attach missing attach_to field, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  const targetEnv = await firestoreRead('work', targetId);
  if (!targetEnv) {
    log('WARN', `Attach target ${targetId} not found, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  if (targetEnv.status === 'needs_input') {
    // Resume the blocked envelope with the human's response
    log('INFO', `Resuming needs_input envelope ${targetId} with human response`);
    targetEnv.status = 'active';
    targetEnv.context_forward = intake.text;
    targetEnv.delivered_at = null;
    targetEnv.delivered_channel = null;
    targetEnv.updated_at = now();
    await firestoreWrite('work', targetId, targetEnv);
    await writeHistory(targetId, 'needs_input', 'active', 'brain', `Resumed with: ${toStr(intake.text).substring(0, 100)}`);
    await processEnvelope(targetEnv, memoryContext);
    return;
  }

  if (targetEnv.status === 'active' || targetEnv.status === 'waiting') {
    // Check if this is truly a status query or a new instruction to act on
    const isStatusQuery = /\b(?:status|progress|update|how.{0,10}going|where.{0,10}at|what.{0,10}happening)\b/i.test(intake.text);
    if (isStatusQuery) {
      // Status check â€” deliver current status
      const statusMsg = `I'm still working on that. Current task: "${targetEnv.instruction}". Status: ${targetEnv.status}, iteration ${targetEnv.iteration || 0}.`;
      const statusEnvId = generateId('w');
      await firestoreWrite('work', statusEnvId, {
        id: statusEnvId,
        type: 'T',
        parent_id: null,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'complete',
        intent: 'status_check',
        instruction: `Status check on ${targetId}`,
        output: statusMsg,
        source_channel: intake.source,
        source_meta: intake.source_meta || {},
        created_at: now(),
        started_at: now(),
        completed_at: now(),
        updated_at: now(),
        children: [],
        accept_criteria: null,
        context_summary: null,
        context_forward: null,
        error: null,
        iteration: 0,
      });
      log('INFO', `Status check delivered for ${targetId}: ${statusEnvId}`);
      return;
    }
    // New instruction for active/waiting mission â€” create linked child task
    log('INFO', `New instruction for ${targetEnv.status} mission ${targetId}, creating child task`);
    return processIntakeAsNewTask(intake, decision, memoryContext, targetId);
  }

  // For blocked envelopes, delegate to handleContinue (which knows how to reopen)
  if (targetEnv.status === 'blocked') {
    log('INFO', `Attach target ${targetId} is blocked â€” routing to handleContinue`);
    decision.continue_mission = targetId;
    return handleContinue(intake, decision, memoryContext, pendingAckText);
  }

  // For failed missions, create a child task linked to the mission
  if (targetEnv.status === 'failed') {
    log('INFO', `Attach target ${targetId} is failed â€” creating linked follow-up task`);
    return processIntakeAsNewTask(intake, decision, memoryContext, targetId);
  }

  // For complete or other statuses, treat as a new follow-up task
  log('INFO', `Attach target ${targetId} is ${targetEnv.status}, creating follow-up task`);
  log('WARN', `[TELEMETRY] classify_cascade: attach→complete_fallback→new_mission (${targetId})`);
  return processIntakeAsNewTask(intake, decision, memoryContext);
}

// ---- Helper: create new task from intake when attach falls through ----
async function processIntakeAsNewTask(intake, decision, memoryContext, parentId = null) {
  const envelopeId = generateId('w');
  const _titleInput = (decision.instruction && decision.instruction.length > 100)
    ? decision.instruction
    : stripChatFraming(intake.text) || decision.instruction || 'Untitled';
  const envelope = {
    id: envelopeId,
    type: parentId ? 'C' : 'M',
    parent_id: parentId || null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'pending',
    delivery_status: parentId ? 'internal' : 'pending',
    intent: decision.intent || 'decide',
    title: await generateTitle(_titleInput, 'mission'),
    instruction: decision.instruction || stripChatFraming(intake.text),
    source_text: intake.text || '',
    accept_criteria: decision.accept_criteria || null,
    context_summary: decision.context_summary || null,
    output: null,
    children: [],
    context_forward: null,
    error: null,
    source_channel: intake.source,
    source_meta: intake.source_meta || {},
    project_id: decision.project_id || DEFAULT_PROJECT_ID,
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: memoryContext,
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=M, fallback from intake)`);
  await writeHistory(envelopeId, null, 'pending', 'brain', 'Created from intake ' + intake.id);
  await processEnvelope(envelope, memoryContext);
}

// ---- Continue handler: resume a blocked mission ----
async function handleContinue(intake, decision, memoryContext, pendingAckText = null) {
  const targetId = decision.continue_mission || decision.continue_envelope || decision.mission_id;
  log('INFO', `Continue: intake ${intake.id} â†’ resuming blocked mission ${targetId}`);

  if (!targetId) {
    log('WARN', `Continue missing continue_mission field, treating as new_mission`);
    log('WARN', `[TELEMETRY] classify_cascade: continue→missing_target→new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  const mission = await firestoreRead('work', targetId);
  if (!mission) {
    log('WARN', `Continue target ${targetId} not found, treating as new_mission`);
    log('WARN', `[TELEMETRY] classify_cascade: continue→not_found→new_mission (${targetId})`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  // Only reopen blocked or complete missions (not active â€” that's an attach/status check)
  if (!['blocked', 'complete'].includes(mission.status)) {
    // Active target — check for stale claim and resume instead of cascading
    const claimAge = mission.claimed_at ? (Date.now() - mission.claimed_at) : Infinity;
    if (claimAge > CLAIM_STALE_MS) {
      log('INFO', `Reclaiming stale active envelope ${targetId} (claim age: ${claimAge}ms)`);
      mission.claimed_by = AGENT_ID;
      mission.claimed_at = Date.now();
      mission.context_forward = toStr(intake.text);
      mission.updated_at = now();
      await firestoreWrite('work', targetId, mission);
      return processEnvelope(mission, memoryContext);
    }
    log('WARN', `[TELEMETRY] classify_cascade: continue→active_busy→attach (${targetId}, status=${mission.status})`);
    return handleAttach(intake, { ...decision, attach_to: targetId }, memoryContext);
  }

  const prevStatus = mission.status;

  // Reopen the mission
  mission.status = 'active';
  mission.context_forward = [
    mission.context_forward || '',
    `[UNBLOCKED] ${intake.text}`,
    `[REVISED INSTRUCTION] ${decision.instruction || intake.text}`,
  ].filter(Boolean).join('\n\n');
  mission.blocker = null;
  mission.blocker_type = null;
  mission.delivered_at = null;
  mission.delivered_channel = null;
  mission.delivery_status = 'internal'; // Reset â€” will become 'pending' when re-completed
  mission._swf_state = null; // Reset retry cap for new attempt
  mission.updated_at = now();

  await firestoreWrite('work', targetId, mission);
  await writeHistory(targetId, prevStatus, 'active', 'brain',
    `Resumed via continue: ${toStr(intake.text).substring(0, 100)}`);
  log('INFO', `Mission ${targetId} reopened from ${prevStatus} → active`);

  // Mark intake as consumed BEFORE processing — prevents re-processing if processEnvelope throws
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'consumed',
    consumed_by: targetId,
    consumed_at: now(),
  });

  // Inject ack under the reopened mission (same pattern as new mission ack)
  if (pendingAckText) {
    await createCT(mission, {
      checkpointTitle: 'Acknowledge receipt',
      taskTitle: 'Write acknowledgment',
      taskOutput: pendingAckText,
      taskIntent: 'ack',
      deliveryStatus: 'pending',
      ctKey: `ack-resume-${mission.id}`,
    });
    await firestoreWrite('work', mission.id, mission);
    log('INFO', `Ack injected as C-T under resumed mission ${mission.id}`);
  }

  // Resume processing — Cortex will see the full mission context + new unblock info
  await processEnvelope(mission, memoryContext);
}

// ---- Cancel handler: explicitly abandon work ----
async function handleCancel(intake, decision) {
  const targetId = decision.cancel_target;
  log('INFO', `Cancel: intake ${intake.id} → cancelling ${targetId}`);

  if (!targetId) {
    log('WARN', `Cancel missing cancel_target field, ignoring`);
    return;
  }

  const target = await firestoreRead('work', targetId);
  if (!target) {
    log('WARN', `Cancel target ${targetId} not found`);
    return;
  }

  if (!['active', 'blocked', 'needs_input', 'waiting', 'pending'].includes(target.status)) {
    log('INFO', `Cancel target ${targetId} already in terminal state: ${target.status}`);
    return;
  }

  const prevStatus = target.status;
  target.status = 'cancelled';
  target.cancelled_at = now();
  target.cancelled_reason = decision.reasoning || intake.text || 'User requested cancellation';
  target.updated_at = now();
  await firestoreWrite('work', targetId, target);
  await writeHistory(targetId, prevStatus, 'cancelled', 'brain',
    `Cancelled: ${toStr(decision.reasoning).substring(0, 100)}`);
  log('INFO', `Mission ${targetId} cancelled (was ${prevStatus})`);

  // Cascade cancellation to children
  await cascadeCancelChildren(targetId);

  // Deliver confirmation
  await deliverStatusUpdate(targetId, `✅ Cancelled mission: "${toStr(target.instruction).substring(0, 100)}"`);
}

// Cascade-cancel all active/pending children of a cancelled envelope
async function cascadeCancelChildren(parentId) {
  const token = await getAuthToken();
  if (!token) return;
  const parentPath = `${FIRESTORE_BASE}/primes/${PRIME_ID}`;
  let nextPageToken = null;
  let cancelCount = 0;
  do {
    const url = `${parentPath}/work?pageSize=300${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) break;
    const data = await resp.json();
    const docs = (data.documents || []).map(d => ({
      id: d.name.split('/').pop(),
      ...firestoreDecode(d.fields || {}),
    }));
    for (const child of docs) {
      if (child.parent_id === parentId && ['active', 'pending', 'waiting', 'needs_input'].includes(child.status)) {
        await firestoreWrite('work', child.id, {
          status: 'cancelled',
          cancelled_at: now(),
          cancelled_reason: `Parent ${parentId} cancelled`,
          updated_at: now(),
          completed_at: now(),
        });
        await writeHistory(child.id, child.status, 'cancelled', 'brain', `Parent ${parentId} cancelled`);
        cancelCount++;
        // Recurse for grandchildren
        await cascadeCancelChildren(child.id);
      }
    }
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  if (cancelCount > 0) log('INFO', `Cascade-cancelled ${cancelCount} children of ${parentId}`);
}

// ---- CP5: Checkpoint plan resume (crash recovery) ----
// When the daemon crashes mid-checkpoint-plan, this function re-enters plan
// execution from the saved _cp_progress state, skipping analyze/decide.
async function executeCheckpointPlanResume(envelope, progress, memory) {
  const { checkpointIndex, taskIndex, allResults: savedResults, checkpoints, decision } = progress;
  if (!checkpoints || checkpoints.length === 0) {
    log('WARN', `CP5 resume: no checkpoints in progress state for ${envelope.id}, falling through to normal processing`);
    envelope._cp_progress = null;
    await firestoreWrite('work', envelope.id, envelope);
    return;
  }

  log('INFO', `CP5 resume: ${checkpoints.length} checkpoints, resuming from CP${checkpointIndex + 1} task ${taskIndex}`);

  // Phase 4.3: LLM cost telemetry — per-mission token accumulator for resume path
  const _tokenUsage = { totalInput: 0, totalOutput: 0, totalCached: 0, callCount: 0 };

  const dispatchAgent = async (agentId, payload) => {
    const res = await callAgent(agentId, payload);
    if (res?.usage) {
      const u = res.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=${agentId} model=${REGISTRY.agents?.[agentId]?.route || agentId} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} duration=${res.durationMs || 0}ms`);
    }
    return res;
  };

  const execResult = await executeCheckpoints(checkpoints, {
    dispatchAgent,
    envelope,
    log,
    writeHistory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    generateId,
    contracts: CONTRACTS,
    skillIndex: formatSkillCatalog(SKILL_INDEX),
    PROJECTS,
    addressFromMeta,
    summarizeForDelivery,
    smartSummarize,
    getAuthToken,
    FIRESTORE_BASE,
    PRIME_ID,
    AGENT_EMAIL,
    AGENT_ID,
    CORE_DIR,
    CTX_AGENT_STEP,
    CTX_DISPATCH_FAILURE,
    startCpIndex: checkpointIndex,
    startTaskIndex: taskIndex,
    savedResults,
    buildProjectContext,
  });

  if (execResult.paused) {
    return;
  }

  const allResults = execResult.results;
  const planFailed = !execResult.success;

  // Synthesize or escalate — feed results to cortex by re-entering the decide loop
  const priorResults = allResults.map(r => ({
    agent: r.agent, task: r.task, result: r.result,
    success: r.success, durationMs: r.durationMs,
    checkpoint_step: r.step,
  }));

  if (planFailed) {
    priorResults.push({
      agent: 'system',
      result: '[SYSTEM] Checkpoint plan failed during crash-recovery resume. Use "synthesize_with_failure" or "needs_input" to handle.',
    });
  }

  // Store results and let cortex synthesize
  envelope.context_forward = `[CHECKPOINT PLAN RESULTS (resumed after crash)]\n${allResults.map(r => `${r.step} (${r.agent}): ${r.success ? 'OK' : 'FAIL'} — ${toStr(r.result).substring(0, 200)}`).join('\n')}`;
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);

  // Re-enter the normal cortex loop for synthesis
  await _processEnvelopeInner(envelope, memory, null);
}

// ---- Envelope processing (Phase 3: memory-enriched Cortex loop) ----
async function processEnvelope(envelope, memoryContext) {
  log('INFO', `Processing envelope: ${envelope.id} (type=${envelope.type}, status=${envelope.status})`);

  // CP3: Durable claim — prevents concurrent processing across restarts
  const claimId = await claimEnvelope(envelope.id);
  if (!claimId) {
    log('WARN', `Skipping envelope ${envelope.id} — claimed by another processor`);
    return;
  }

  try {
    await _processEnvelopeInner(envelope, memoryContext, claimId);
  } finally {
    // CP3: Release claim on completion (success or failure)
    await releaseClaim(envelope.id, claimId);
  }

  // At the end of processEnvelope, after the child is terminal:
  if (envelope.parent_id && ['blocked', 'failed', 'complete'].includes(envelope.status)) {
    try {
      const parent = await firestoreRead('work', envelope.parent_id);
      if (parent && parent.status === 'active') {
        // Append child result to parent's context so cortex sees it on next iteration
        const childSummary = `[CHILD RESULT] ${envelope.id} (${envelope.status}): ${toStr(envelope.output).substring(0, 500)}`;
        if (!parent.context_forward) parent.context_forward = '';
        parent.context_forward += '\n' + childSummary;
        parent.updated_at = now();
        await firestoreWrite('work', parent.id, parent);
        await writeHistory(parent.id, parent.status, parent.status, 'brain',
          `Child ${envelope.id} reached ${envelope.status}`);
        log('INFO', `Propagated child ${envelope.id} (${envelope.status}) to parent ${parent.id}`);

        // Re-process parent so cortex can decide what to do
        await processEnvelope(parent, envelope.memory_context || null);
      }
    } catch (err) {
      log('WARN', `Failed to propagate child ${envelope.id} status to parent ${envelope.parent_id}: ${err.message}`);
    }
  }
}

async function _processEnvelopeInner(envelope, memoryContext, _claimId) {
  // Use passed memory context, or recall fresh if not provided
  const memory = memoryContext || await recallMemory(envelope.instruction);

  // Phase 5: Initialize shared workspace for this envelope
  await initSharedWorkspace(envelope.id);

  // CP5: Checkpoint resume — if we crashed mid-checkpoint-plan, resume from
  // the last completed step instead of re-running analyze/decide
  if (CHECKPOINT_RESUME_ENABLED && envelope._cp_progress) {
    const progress = envelope._cp_progress;
    log('INFO', `CP5 resume: envelope ${envelope.id} resuming checkpoint plan from CP${progress.checkpointIndex + 1} task ${progress.taskIndex}`);
    // Restore the decide loop state and re-enter checkpoint execution
    envelope.status = 'active';
    envelope.updated_at = now();
    await firestoreWrite('work', envelope.id, envelope);
    await writeHistory(envelope.id, 'active', 'active', 'brain', `Resuming from CP${progress.checkpointIndex + 1} task ${progress.taskIndex} (crash recovery)`);

    // Execute the remaining checkpoint plan using the saved state
    await executeCheckpointPlanResume(envelope, progress, memory);
    return;
  }

  // Mark active
  envelope.status = 'active';
  envelope.started_at = envelope.started_at || now();
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'pending', 'active', 'brain', 'Processing started');

  // Cortex loop
  let priorResults = [];
  let iteration = 0;

  // Phase 4.3: LLM cost telemetry — per-mission token accumulator
  const _tokenUsage = { totalInput: 0, totalOutput: 0, totalCached: 0, callCount: 0 };

  // If resuming from needs_input, inject the human's response
  if (envelope.context_forward) {
    priorResults.push({
      agent: 'human',
      result: envelope.context_forward,
      success: true,
    });
    log('INFO', `Injected human response: ${toStr(envelope.context_forward).substring(0, 80)}`);
  }

  let _activeGuard = null; // Phase 3.2: guard enforcement state

  // Phase 2.2: Dependencies for action handlers (Dependency Injection)
  const deps = {
    log,
    now,
    toStr,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    generateId,
    writeHistory,
    completeEnvelope,
    createCT,
    deliverStatusUpdate,
    executeProcess,
    ensureProcessesLoaded,
    PROCESSES,
    PROJECTS,
    generateTitle,
    callAgent,
    enforceSchema,
    formatSkillCatalog,
    SKILL_INDEX,
    addressFromMeta,
    summarizeForDelivery,
    smartSummarize,
    getAuthToken,
    FIRESTORE_BASE,
    PRIME_ID,
    AGENT_EMAIL,
    AGENT_ID,
    CORE_DIR,
    CTX_AGENT_STEP,
    CTX_DISPATCH_FAILURE,
    CONTRACTS,
    buildProjectContext,
    MAX_ITERATIONS,
    REGISTRY,
    executeCheckpoints,
    extractCheckpoints,
    composeDelegationMarker,
    makeAddress,
  };

  // Phase 2.3: Action dispatch table
  const ACTION_HANDLERS = {
    synthesize: handleSynthesize,
    blocked: handleBlocked,
    needs_input: handleNeedsInput,
    status_update: handleStatusUpdate,
    synthesize_with_failure: handleSynthesizeWithFailure,
    follow_process: handleFollowProcess,
    delegate: handleDelegate,
    checkpoint_plan: handleCheckpointPlan,
  };

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    envelope.iteration = iteration;

    // Queue awareness: check for pending intake
    const queueInfo = await getPendingIntakeQueue();
    if (queueInfo.count > 0) {
      log('INFO', `Pending intake: ${queueInfo.count} queued`);
    }

    // Build accumulated envelope context
    const envelopeContext = buildEnvelopeContext(
      envelope,
      priorResults,
      memory
    );
    // Store accumulated context back on envelope
    envelope._accumulated_context = envelopeContext;

    // ---- ANALYZE: prefrontal decomposes work into a Brief (first iteration only) ----
    let brief = envelope._brief || null;
    if (!brief && iteration === 1 && !envelope._processActive) {
      brief = await callPrefrontal({
        envelope: {
          id: envelope.id,
          type: envelope.type,
          instruction: envelope.instruction,
          accept_criteria: envelope.accept_criteria,
          context_summary: envelope.context_summary,
          project_id: envelope.project_id,
        },
        memory,
        prior_results: priorResults,
      });
      if (brief) {
        envelope._brief = brief;
        // Process match short-circuit: if the Brief identifies a stored process,
        // inject it as a prior result so cortex sees the recommendation
        if (brief.process_match && PROCESSES[brief.process_match]) {
          log('INFO', `Brief recommends process: ${brief.process_match}`);
        }
      }
    }

    // ---- DECIDE: cortex commits a plan from the Brief ----
    let decision = await callCortex('decide', {
      envelope: {
        id: envelope.id,
        type: envelope.type,
        instruction: envelope.instruction,
        accept_criteria: envelope.accept_criteria,
        context_summary: envelope.context_summary,
      },
      memory,
      envelope_context: envelopeContext,
      prior_results: priorResults,
      iteration,
      pending_intake_count: queueInfo.count,
      pending_queue: queueInfo.queue,
      brief,
    });

    // Phase 4.3: LLM cost telemetry — cortex call
    if (decision?.usage) {
      const u = decision.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=cortex model=${CORTEX_ROUTE} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} duration=${decision.durationMs || 0}ms`);
    }

    if (decision.error) {
      // Retry once: ask Cortex to respond with JSON only
      if (decision.error === 'parse_failed' && iteration < MAX_ITERATIONS) {
        log('WARN', `Parse failed, retrying with explicit JSON instruction`);
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Your previous response could not be parsed as JSON. Respond with EXACTLY one JSON block, no markdown fences, no text before or after. Required field: "action".`,
        });
        continue;
      }
      envelope.status = 'failed';
      envelope.error = `Cortex error: ${JSON.stringify(decision)}`;
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'failed', 'brain', envelope.error);
      log('ERROR', `Envelope ${envelope.id} failed: ${envelope.error}`);
      return;
    }

    // Schema enforcement guarantees action field — no normalization needed
    let action = decision.action;
    log('INFO', `Cortex decision: action=${action} (iteration ${iteration})`);

    // Prevent self-unblock runaway: after a self-unblock attempt, only allow
    // resolution actions (synthesize, blocked). If Cortex/enforceSchema returns
    // checkpoint_plan, it's stalling — force to blocked.
    if ((envelope._swf_state === 'awaiting_unblock' || envelope._swf_state === 'unblock_attempted') && action === 'checkpoint_plan') {
      log('WARN', `Post-unblock guard: blocking checkpoint_plan after self-unblock — forcing blocked`);
      action = 'blocked';
      decision.action = 'blocked';
      // Preserve the synthesis from the synthesize_with_failure that triggered self-unblock
      decision.blocker = decision.failure_summary || envelope._failure_synthesis || 'Could not resolve failure through alternative approach';
      decision.blocker_type = 'task_failure';
      // Use the original failure synthesis as the output so the user gets useful info
      decision.escalation_message = envelope._failure_synthesis || decision.failure_summary || decision.blocker;
    }

    // Phase 3.2: Generalized guard enforcement
    // If a guard was set in a previous iteration, enforce it now
    if (_activeGuard && iteration > _activeGuard.injectedAt) {
      if (action === _activeGuard.forbidden) {
        log('WARN', `Guard override: cortex chose forbidden '${action}', forcing '${_activeGuard.fallback}'`);
        action = _activeGuard.fallback;
        decision.action = action;
        // Transfer guard context to decision if relevant
        if (_activeGuard.context) Object.assign(decision, _activeGuard.context);
      }
      _activeGuard = null; // One-shot: guard expires after one check
    }

    // Phase 2.3: Dispatch table lookup for all 8 action handlers
    if (ACTION_HANDLERS[action]) {
      const ctx = { envelope, decision, priorResults, memoryResults: memory, iteration, _activeGuard, _tokenUsage };
      let actionResult = await ACTION_HANDLERS[action](ctx, deps);

      // Handle delegation to another handler (e.g. synthesize_with_failure -> synthesize)
      if (actionResult?.delegateAction) {
        action = actionResult.delegateAction;
        if (ACTION_HANDLERS[action]) {
          ctx.decision.action = action;
          actionResult = await ACTION_HANDLERS[action](ctx, deps);
        } else {
          log('ERROR', `Delegated action handler '${action}' not found`);
          continue;
        }
      }

      if (actionResult?.exit) return;
      if (actionResult?.activeGuard) _activeGuard = actionResult.activeGuard;
      if (actionResult?.priorResultsAppend) priorResults.push(...actionResult.priorResultsAppend);
      continue;
    }

    // Unknown action — nudge Cortex. Table-dispatched actions (synthesize, blocked, needs_input, status_update)
    // are handled above by ACTION_HANDLERS and never reach here.
    log('WARN', `Unknown action '${action}' — nudging Cortex`);
    priorResults.push({
      agent: 'system',
      result: `[SYSTEM] Invalid action "${action}". Valid actions: checkpoint_plan, delegate, synthesize, synthesize_with_failure, needs_input, blocked, follow_process, status_update.`,
    });

    // Phase 3.3: priorResults budget — prevent unbounded growth
    const PRIOR_RESULTS_MAX = CONTRACTS.dispatch?.prior_results_max || 25;
    const PRIOR_RESULTS_KEEP = Math.floor(PRIOR_RESULTS_MAX * 0.6); // keep last 60%
    if (priorResults.length > PRIOR_RESULTS_MAX) {
      const keep = priorResults.slice(-PRIOR_RESULTS_KEEP);
      const older = priorResults.slice(0, -PRIOR_RESULTS_KEEP);
      const summarized = older
        .map(r => `${r.agent || 'system'}: ${toStr(r.result).substring(0, 100)}`)
        .join('\n');
      priorResults.length = 0;
      priorResults.push(
        { agent: 'system', result: `[PRIOR WORK SUMMARY]\n${summarized}`, success: true },
        ...keep
      );
      log('INFO', `priorResults truncated: ${older.length} entries summarized, ${keep.length} kept`);
    }
  }

  // Max iterations reached
  await completeEnvelope(envelope, {
    status: 'failed',
    output: `Max iterations (${MAX_ITERATIONS}) reached`,
    historyDetail: `Max iterations (${MAX_ITERATIONS}) reached`,
    skipArtifacts: true,
    skipMemory: true,
    tokenUsage: _tokenUsage,
  });
}

// ---- Envelope context accumulation ----
const CONTEXT_TOKEN_BUDGET = CONTRACTS.dispatch?.context_token_budget || 400_000;
const CHARS_PER_TOKEN = 4; // rough estimate
const CONTEXT_CHAR_BUDGET = CONTEXT_TOKEN_BUDGET * CHARS_PER_TOKEN;

function buildEnvelopeContext(envelope, priorResults, memoryResults) {
  // Start with any previously accumulated context from Firestore
  let accumulated = envelope._accumulated_context || '';

  // Build a new block for the latest iteration
  const timestamp = now();
  const iteration = envelope.iteration || 1;
  const blockParts = [`--- Iteration ${iteration} (${timestamp}) ---`];

  // Summarize the latest prior results (only the newest ones not yet captured)
  if (priorResults && priorResults.length > 0) {
    const latest = priorResults[priorResults.length - 1];
    if (latest.agent && latest.agent !== 'system') {
      blockParts.push(`Decision: dispatch to ${latest.agent}`);
      if (latest.task) blockParts.push(`Task: ${latest.task}`);
      const resultStr = toStr(latest.result).substring(0, 2000);
      blockParts.push(`Result: ${resultStr}`);
    } else if (latest.agent === 'human') {
      blockParts.push(`Human input: ${toStr(latest.result).substring(0, 500)}`);
    }
  }

  // Append memory context summary if available
  if (memoryResults?.recalled && iteration === 1) {
    blockParts.push(`Memory: ${toStr(memoryResults.recalled).substring(0, 1000)}`);
  }

  const newBlock = blockParts.join('\n');

  // Only append if we have meaningful content beyond the header
  if (blockParts.length > 1) {
    accumulated = accumulated
      ? `${accumulated}\n\n${newBlock}`
      : newBlock;
  }

  // Budget enforcement: prune if over char budget
  if (accumulated.length > CONTEXT_CHAR_BUDGET) {
    const blocks = accumulated.split(/\n\n(?=--- Iteration )/);
    if (blocks.length > 2) {
      // Keep first 10% + last 90% of blocks
      const keepFirst = Math.max(1, Math.floor(blocks.length * 0.1));
      const keepLast = Math.max(1, Math.floor(blocks.length * 0.9));
      const pruned = [
        ...blocks.slice(0, keepFirst),
        `\n--- [${blocks.length - keepFirst - keepLast} iterations pruned for context budget] ---\n`,
        ...blocks.slice(blocks.length - keepLast),
      ];
      accumulated = pruned.join('\n\n');
      log('INFO', `Envelope context pruned: ${blocks.length} blocks → ${pruned.length} blocks (${accumulated.length} chars)`);
    }
  }

  return accumulated;
}

// ---- Artifacts (via artifacts.mjs, Phase 3 extraction) ----
let _artifacts = null;
let ARTIFACTS_ROOT_FOLDER_ID = null; // synced from module for backward compat

function _initArtifacts() {
  _artifacts = createArtifactManager({
    firestoreWrite,
    firestoreRead,
    firestoreEncode,
    getProjects: () => PROJECTS,
    getDefaultProjectId: () => DEFAULT_PROJECT_ID,
    logger: log,
    config: {
      coreDir: CORE_DIR,
      primeId: PRIME_ID,
      agentId: AGENT_ID,
      agentEmail: AGENT_EMAIL,
      gcpProject: GCP_PROJECT,
    },
  });
}

async function initSharedWorkspace(envelopeId) {
  if (!_artifacts) _initArtifacts();
  await _artifacts.initWorkspace(envelopeId);
}

async function cleanupSharedWorkspace(envelopeId) {
  if (!_artifacts) _initArtifacts();
  await _artifacts.cleanupWorkspace(envelopeId);
}

async function ensureProjectDriveFolder(projectId) {
  if (!_artifacts) _initArtifacts();
  return _artifacts.ensureProjectFolder(projectId);
}

async function publishArtifacts(envelope) {
  if (!_artifacts) _initArtifacts();
  return _artifacts.publish(envelope);
}

async function loadPrimeConfig() {
  if (!_artifacts) _initArtifacts();
  await _artifacts.loadConfig();
  ARTIFACTS_ROOT_FOLDER_ID = _artifacts.getArtifactsRootId();
}

// ---- History (via history.mjs, Phase 3 extraction) ----
let _history = null;

function _initHistory() {
  _history = createHistoryWriter({
    firestoreWrite,
    logger: log,
  });
}

async function writeHistory(envelopeId, prevStatus, newStatus, agent, detail) {
  if (!_history) _initHistory();
  await _history.write(envelopeId, prevStatus, newStatus, agent, detail);
}

// ---- Logging ----
function log(level, msg) {
  const entry = JSON.stringify({
    ts: now(),
    level,
    service: 'brain',
    agent: AGENT_ID,
    msg,
  });
  console.log(entry);
  try {
    appendFileSync(LOG_FILE, entry + '\n');
  } catch {}
}

// ---- Intake poller ----
// Uses Firestore REST query polling (real-time listeners require gRPC client).
let processing = false;

async function pollIntake() {
  if (processing) return;
  processing = true;

  try {
    const pending = await firestoreQuery('intake', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ]);

    const filtered = pending.filter(item => {
      const targetAgentId = item.source_meta?.agentId;
      return !targetAgentId || targetAgentId === AGENT_ID;
    });

    for (const intake of filtered) {
      try {
        await processIntake(intake);
      } catch (e) {
        log('ERROR', `Intake processing error: ${e.message}\n${e.stack}`);
        // Don't revert intakes already consumed by a mission
        const freshIntake = await firestoreRead('intake', intake.id).catch(() => null);
        if (freshIntake && freshIntake.status === 'consumed') {
          log('INFO', `Intake ${intake.id} already consumed by ${freshIntake.consumed_by} — not reverting despite error`);
        } else {
          const retryCount = (intake.retry_count || 0) + 1;
          const MAX_RETRIES = 3;
          try {
            if (retryCount >= MAX_RETRIES) {
              // Exhaust retries — fail the intake permanently
              await firestoreWrite('intake', intake.id, {
                ...intake,
                status: 'failed',
                error: `Exhausted ${MAX_RETRIES} retries: ${e.message}`,
                retry_count: retryCount,
                failed_at: now(),
              });
              log('ERROR', `Intake ${intake.id} permanently failed after ${MAX_RETRIES} retries: ${e.message}`);
            } else {
              // Revert to pending with incremented retry counter
              await firestoreWrite('intake', intake.id, {
                ...intake,
                status: 'pending',
                claimed_at: null,
                retry_count: retryCount,
              });
              log('WARN', `Intake ${intake.id} reverted to pending (retry ${retryCount}/${MAX_RETRIES})`);
            }
          } catch (revertErr) {
            log('ERROR', `Failed to update intake ${intake.id} status: ${revertErr.message}`);
          }
        }
      }
    }
  } catch (e) {
    log('ERROR', `Poll error: ${e.message}`);
  } finally {
    processing = false;
  }
}

// ---- Waiting envelope resumption (Phase 6) ----
let waitingCheckCount = 0;

async function checkWaitingEnvelopes() {
  waitingCheckCount++;
  // Only check every 3rd poll cycle (~9s)
  if (waitingCheckCount % 3 !== 0) return;

  try {
    const waitingEnvelopes = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'waiting' } },
      { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
    ]);

    for (const waiting of waitingEnvelopes) {
      // Check if any delegated children have completed or failed
      const children = waiting.children || [];
      if (children.length === 0) continue;

      let allChildrenDone = true;
      let childResults = [];

      for (const childId of children) {
        const child = await firestoreRead('work', childId);
        if (!child) continue;

        if (child.status === 'complete' || child.status === 'failed') {
          childResults.push({
            agent: child.owner,
            task: toStr(child.instruction).substring(0, 200),
            result: child.status === 'complete'
              ? toStr(child.output).substring(0, 4000)
              : `[FAILED] ${child.error || 'unknown'}`,
            success: child.status === 'complete',
          });
        } else {
          allChildrenDone = false;
        }
      }

      if (!allChildrenDone || childResults.length === 0) continue;

      // All delegated children are done â€” resume the waiting envelope
      log('INFO', `Resuming waiting envelope ${waiting.id}: ${childResults.length} delegation(s) complete`);

      // Inject delegation results as context_forward
      const delegationSummary = childResults.map((r, i) =>
        `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${toStr(r.result).substring(0, 500)}`
      ).join('\n\n');

      waiting.status = 'active';
      waiting.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
      waiting.updated_at = now();
      await firestoreWrite('work', waiting.id, waiting);
      await writeHistory(waiting.id, 'waiting', 'active', 'brain', `Delegation(s) complete, resuming`);

      // Resume cortex loop
      try {
        const memory = await recallMemory(waiting.instruction);
        await processEnvelope(waiting, memory);
      } catch (e) {
        log('ERROR', `Failed to resume waiting envelope ${waiting.id}: ${e.message}`);
      }
    }
  } catch (e) {
    log('WARN', `Waiting envelope check error: ${e.message}`);
  }
}

// ---- Main ----
async function main() {
  log('INFO', '=== Brain v3 starting ===');
  log('INFO', `Agent: ${AGENT_ID} | Project: ${GCP_PROJECT} | Prime: ${PRIME_ID}`);
  log('INFO', `Gateway: ${GATEWAY_URL} | Cortex route: ${CORTEX_ROUTE}`);
  log('INFO', `Brain summarizer: ${BRAIN_MODEL} (direct Vertex, bypasses gateway)`);
  log('INFO', `Registry agents: ${Object.keys(REGISTRY.agents).join(', ') || 'none loaded'}`);

  // Load prime config (artifacts root folder, etc.)
  await loadPrimeConfig();

  // Load projects from Firestore
  await loadProjects();
  await ensureDefaultProject();
  log('INFO', `Projects loaded: ${Object.keys(PROJECTS).length} active (default: ${DEFAULT_PROJECT_ID})`);

  // Verify gateway is reachable
  try {
    const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`, {
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    log('INFO', `Gateway check: HTTP ${resp.status}`);
  } catch (e) {
    log('WARN', `Gateway not reachable at startup: ${e.message}. Will retry on first intake.`);
  }

  // Initial archival sweep + periodic timer
  await archiveEnvelopes();
  setInterval(() => archiveEnvelopes(), ARCHIVE_INTERVAL_MS);
  log('INFO', `Archival sweep scheduled every ${Math.round(ARCHIVE_INTERVAL_MS / 3600000)}h`);

  // Startup recovery: re-process orphaned active/pending M envelopes
  // When brain restarts mid-processing, envelopes get stuck with no processor
  // IMPORTANT: Only recover missions with NO children (truly orphaned).
  // Missions with children were already being worked on — reprocessing them
  // from scratch creates duplicate work. Archive stale ones instead.
  // CP3: Clear stale claims from previous process instances
  log('INFO', `Idempotency config: step_ledger=${STEP_LEDGER_ENABLED}, checkpoint_resume=${CHECKPOINT_RESUME_ENABLED}, claim_stale_ms=${CLAIM_STALE_MS}`);
  try {
    // On restart, ALL claims from this agent's previous process are stale
    const claimedEnvs = await firestoreQuery('work', [
      { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
    ]);
    const staleClaimed = claimedEnvs.filter(e => e.claimed_by);
    if (staleClaimed.length > 0) {
      log('INFO', `Recovery: clearing ${staleClaimed.length} stale claims from previous process`);
      for (const sc of staleClaimed) {
        sc.claimed_by = null;
        sc.claimed_at_ms = null;
        await firestoreWrite('work', sc.id, sc);
      }
    }
  } catch (e) {
    log('WARN', `Startup recovery: failed to clear stale claims: ${e.message}`);
  }

  try {
    const agentId = AGENT_ID;
    const token = await getAuthToken();
    if (token) {
      const parentPath = `${FIRESTORE_BASE}/primes/${PRIME_ID}`;
      let allDocs = [];
      let nextPageToken = null;
      do {
        const url = `${parentPath}/work?pageSize=300${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
          log('WARN', `Startup recovery: work list failed HTTP ${resp.status}`);
          break;
        }
        const data = await resp.json();
        const pageDocs = (data.documents || []).map(d => ({
          id: d.name.split('/').pop(),
          ...firestoreDecode(d.fields || {}),
        }));
        allDocs.push(...pageDocs);
        nextPageToken = data.nextPageToken || null;
      } while (nextPageToken);

      log('INFO', `Startup recovery: scanned ${allDocs.length} work docs`);
      const orphaned = allDocs.filter(e => (e.type === 'M' || (e.type === 'C' && e.parent_id && e.intent !== 'checkpoint')) &&
        (e.owner || '').includes(agentId) &&
        (e.status === 'active' || e.status === 'pending'));
      if (orphaned.length > 0) {
        log('INFO', `Startup recovery: found ${orphaned.length} orphaned envelope(s)`);
        for (const env of orphaned) {
          const hasChildren = Array.isArray(env.children) && env.children.length > 0;

          if (hasChildren) {
            // Mission was already being worked on before restart â€” do NOT reprocess from scratch.
            // Check if the children are all done (archive the mission) or still active (let them complete).
            const childObjects = env.children.map(cid => allDocs.find(d => d.id === cid)).filter(Boolean);
            const childStatuses = childObjects.map(child => child.status || 'unknown');
            const allChildrenDone = childStatuses.every(s => s === 'complete' || s === 'archived' || s === 'failed');

            if (allChildrenDone) {
              log('INFO', `Recovery: archiving completed mission ${env.id}`);
              await firestoreWrite('work', env.id, {
                status: 'archived', archived_reason: 'child_complete',
                delivery_status: 'delivered', updated_at: now(),
              });
              await writeHistory(env.id, env.status, 'archived', 'brain', 'Archived after restart — all children complete');
            } else {
              const activeChildMissions = childObjects.filter(child =>
                (child.type === 'M' || (child.type === 'C' && child.intent !== 'checkpoint')) &&
                (child.status === 'active' || child.status === 'pending')
              );
              if (activeChildMissions.length > 0) {
                log('INFO', `Recovery: mission ${env.id} has ${activeChildMissions.length} active child missions — ensuring parent active`);
                if (env.status !== 'active') {
                  await firestoreWrite('work', env.id, { status: 'active', updated_at: now() });
                }
              } else {
                log('INFO', `Recovery: resuming mission ${env.id} — checkpoints active/pending or children terminal, resuming execution`);
                try {
                  await firestoreWrite('work', env.id, { status: 'active', updated_at: now() });
                  await writeHistory(env.id, env.status, 'active', 'brain', 'Resumed after restart — resuming execution thread');
                  const memory = await recallMemory(env.instruction);
                  await processEnvelope(env, memory);
                } catch (e) {
                  log('ERROR', `Recovery resume failed for ${env.id}: ${e.message}`);
                }
              }
            }
          } else {
            // Truly orphaned: no children, was created but processing never started
            log('INFO', `Recovering orphaned envelope: ${env.id} (status=${env.status}, title=${(env.title || '').substring(0, 60)})`);
            try {
              env.status = 'pending';
              env.iteration = 0;
              await firestoreWrite('work', env.id, { status: 'pending', iteration: 0, updated_at: now() });
              await writeHistory(env.id, 'active', 'pending', 'brain', 'Recovered after brain restart');
              const memory = await recallMemory(env.instruction);
              await processEnvelope(env, memory);
            } catch (e) {
              log('ERROR', `Recovery failed for ${env.id}: ${e.message}`);
            }
          }
        }
      }
    }
  } catch (e) {
    log('WARN', `Startup recovery sweep failed: ${e.message}`);
  }


  // Start intake polling
  const POLL_MS = CONTRACTS.dispatch?.poll_interval_ms || 3000;
  log('INFO', `Starting intake poll (every ${POLL_MS}ms)`);
  setInterval(async () => {
    await pollIntake();
    await checkWaitingEnvelopes();
    await checkApprovedApprovals();
  }, POLL_MS);

  // Phase 7A: Start Responsibility scheduler
  startResponsibilityScheduler();

  // Phase 7A: Watch responsibility config for hot-reload
  for (const f of [
    CORE_DIR + '/corekit/responsibilities.json',
    CORE_DIR + '/corekit/responsibilities-job.json',
  ]) {
    if (existsSync(f)) {
      watchFile(f, { interval: 10000 }, () => {
        log('INFO', `Responsibility config changed: ${f}`);
        loadResponsibilities();
        if (_scheduler) _scheduler.recalcNextFires();
      });
    }
  }

  // Initial poll
  await pollIntake();
}

// ---- Cron, scheduler, approvals (via scheduler.mjs + approvals.mjs) ----

let _approvalChecker = null;

function _initScheduler() {
  _scheduler = createScheduler({
    processEnvelope,
    generateId,
    writeHistory,
    recallMemory,
    firestoreWrite,
    firestoreQuery,
    ensureProcessesLoaded,
    getProcesses: () => PROCESSES,
    processToCheckpointPlan,
    getDefaultProjectId: () => DEFAULT_PROJECT_ID,
    logger: log,
    config: {
      coreDir: CORE_DIR,
      primeId: PRIME_ID,
      agentId: AGENT_ID,
      agentEmail: AGENT_EMAIL,
      gcpProject: GCP_PROJECT,
    },
  });
}

function _initApprovals() {
  _approvalChecker = createApprovalChecker({
    resumeProcessPlan,
    processEnvelope,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    writeHistory,
    logger: log,
    config: {
      primeId: PRIME_ID,
      gcpProject: GCP_PROJECT,
    },
  });
}

function loadResponsibilities() {
  if (!_scheduler) _initScheduler();
  _scheduler.loadResponsibilities();
  RESPONSIBILITIES = _scheduler.getResponsibilities();
}

function startResponsibilityScheduler() {
  if (!_scheduler) _initScheduler();
  loadResponsibilities(); // Must load before start() — start() exits early if RESPONSIBILITIES is empty
  _scheduler.start();
}

async function checkApprovedApprovals() {
  if (!_approvalChecker) _initApprovals();
  await _approvalChecker.checkPending();
}

async function fireEventResponsibilities(eventType, eventContext) {
  if (!_scheduler) _initScheduler();
  await _scheduler.fireEvent(eventType, eventContext);
}

main().catch(e => {
  log('ERROR', `Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
