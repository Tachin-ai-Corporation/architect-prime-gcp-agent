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
import { randomBytes } from 'crypto';
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
// Bypasses the brain gateway entirely â€” no agent routing, no workspace, no tools.

const VERTEX_LOCATION = CONTRACTS.utility?.location || CONTRACTS.vertex?.location || 'global';

// ---- Initialize utility LLM client (vertex-text.mjs) ----
const _vtx = createVertexText({
  projectId: GCP_PROJECT,
  location: VERTEX_LOCATION,
  model: CONTRACTS.utility?.model || BRAIN_MODEL,
  timeoutMs: CONTRACTS.utility?.timeout_ms || 30_000,
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
 * Create a Câ†’T pair under a parent envelope and return the checkpoint ID.
 * Enforces Mâ†’Câ†’T hierarchy for all terminal outputs.
 */
async function createCT(parentEnvelope, { checkpointTitle, taskTitle, taskOutput, taskIntent = 'execute', taskStatus = 'complete', deliveryStatus = 'internal', deliveryAddress = null }) {
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
    source_channel: 'brain', source_meta: {},
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
    specialty = cfg.specialty || '';
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
    `- ${s.name} (${s.id}): ${s.when_to_use || s.category || ''}`
  );
  return `\n\n[AVAILABLE SKILLS]\nRead the SKILL.md before using any tool: readFile /opt/corekit/skills/<id>/SKILL.md\n${entries.join('\n')}\n[END AVAILABLE SKILLS]`;
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

  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Cortex HTTP error: ${resp.status} ${text.substring(0, 200)}`);
    return { error: `HTTP ${resp.status}`, raw: text };
  }

  const data = await resp.json();

  // Debug: log the response structure to understand the format
  const msg = data.choices?.[0]?.message;
  log('DEBUG', `Cortex response structure: role=${msg?.role}, content_type=${typeof msg?.content}, has_choices=${!!data.choices?.length}`);

  // Extract content â€” handle both string and array-of-objects formats
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

  return enforceSchema(content, mode);
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
  parts.push(`[AGENT REGISTRY â€” available agents and their capabilities]\n${JSON.stringify(REGISTRY.agents, null, 2)}`);

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
      }));
    }
    // Inject Brief from ANALYZE phase when present
    if (payload.brief) {
      decidePayload.brief = payload.brief;
      decidePayload.dispatch_guidance = {
        rule: 'The Brief decomposes the work into parts. Commit one typed step per Brief part using checkpoint_plan. Each task should set step_type and brief_part.',
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

    // Phase 5: Detect semantic failures in agent responses
    // Cerebellum FAIL verdict â€” agent returned successfully but the verification failed
    if (content.includes('"verdict"') && content.includes('"FAIL"')) {
      log('WARN', `Agent ${agentId} returned FAIL verdict â€” treating as failure`);
      return { success: false, output: content, error: 'Verification FAIL verdict', durationMs };
    }

    // Motor tool failure — agent returned successfully but reports an infrastructure/auth error.
    // IMPORTANT: Only catch REAL execution failures (auth, permissions, infra).
    // Do NOT catch investigation findings where motor reports that a test/check returned
    // a negative result — that's motor succeeding at its job, not motor failing.
    const FAILURE_PATTERN_AGENTS = ['motor', 'verifier'];
    if (FAILURE_PATTERN_AGENTS.includes(agentId)) {
      const failurePatterns = [
        // Auth/permission errors — always a real failure
        /\berror\b.*\b(?:DWD|token|auth|permission|denied|unauthorized)\b/i,
        // Non-zero exit only if in the last 500 chars (motor's own status, not quoting logs)
        /exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]/i,
      ];
      // Only test exit code pattern against the tail of output (avoid matching quoted log lines)
      const tail = content.length > 500 ? content.slice(-500) : content;
      if (failurePatterns[0].test(content)) {
        log('WARN', `Agent ${agentId} output contains auth/permission failure — treating as failure`);
        return { success: false, output: content, error: 'Agent reported auth/permission failure', durationMs };
      }
      if (failurePatterns[1].test(tail)) {
        log('WARN', `Agent ${agentId} output ends with non-zero exit code — treating as failure`);
        return { success: false, output: content, error: 'Agent reported tool failure (exit code)', durationMs };
      }
    }

    return { success: true, output: content, error: null, durationMs };
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
async function recallMemory(query, context = {}) {
  try {
    // Build enriched query from multiple sources
    const queryParts = [query];
    if (context.instruction) queryParts.push(`Task: ${context.instruction}`);
    if (context.context_summary) queryParts.push(`Context: ${context.context_summary}`);
    const enrichedQuery = queryParts.join('\n');

    log('INFO', `Memory recall: "${enrichedQuery.substring(0, 120)}"`);
    const result = await callAgent('temporal-memory', {
      instruction: `Recall all relevant context for:\n${enrichedQuery}`,
      accept_criteria: 'Return relevant memory context or "No relevant context found"',
    });
    if (result.success && result.output) {
      const recalled = result.output.substring(0, 3000);
      log('INFO', `Memory recalled: ${recalled.length} chars (${result.durationMs}ms)`);
      return { recalled };
    }
    log('INFO', `Memory recall: no context (${result.durationMs}ms)`);
    return {};
  } catch (e) {
    log('WARN', `Memory recall failed: ${e.message}`);
    return {};
  }
}

// ---- Memory: write completed work deterministically ----
// Deterministic write to both core_memory (Firestore via script) and MEMORY.md (local).
// Previous approach dispatched to temporal-memory LLM which silently dropped the write.
async function writeMemory(envelope) {
  try {
    const instruction = (envelope.instruction || '').substring(0, 200);
    const result = (envelope.output || '').substring(0, 200);
    const fact = `Completed ${envelope.type}: ${instruction}. Result: ${result}`;
    const category = 'operations';
    const tags = `mission,${envelope.type},auto`;

    log('INFO', `Memory write: envelope ${envelope.id} — deterministic`);

    // 1. Write to Firestore core_memory via script
    const scriptPath = `${CORE_DIR}/bin/core-memory-write`;
    if (existsSync(scriptPath)) {
      try {
        execFileSync(scriptPath, [
          '--fact', fact,
          '--category', category,
          '--tags', tags,
          '--source', 'brain-auto',
        ], { timeout: 15000, stdio: 'pipe', env: { ...process.env, CORE_DIR } });
        log('INFO', `Memory write: core_memory OK for ${envelope.id}`);
      } catch (scriptErr) {
        log('WARN', `Memory write: core-memory-write failed for ${envelope.id}: ${scriptErr.message}`);
      }
    } else {
      log('WARN', `Memory write: core-memory-write not found at ${scriptPath}`);
    }

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
        instruction: (env.instruction || '').substring(0, 200),
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
        instruction: (e.instruction || '').substring(0, 120),
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
    const newInst = (decision.instruction || intake.text || '').toLowerCase().substring(0, 120);
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
    const newInstC = (decision.instruction || intake.text || '').toLowerCase().substring(0, 120);
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
    });
    await firestoreWrite('work', envelope.id, envelope);
    log('INFO', `Ack injected as Câ†’T under ${envelopeId}`);
  }

  // Process the envelope (pass memory context to avoid re-recall)
  await processEnvelope(envelope, memoryContext);
}

// ---- Attach handler: follow-up to existing work ----
async function handleAttach(intake, decision, memoryContext, pendingAckText = null) {
  const targetId = decision.attach_to;
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
    await writeHistory(targetId, 'needs_input', 'active', 'brain', `Resumed with: ${intake.text.substring(0, 100)}`);
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
  return processIntakeAsNewTask(intake, decision, memoryContext);
}

// ---- Helper: create new task from intake when attach falls through ----
async function processIntakeAsNewTask(intake, decision, memoryContext, parentId = null) {
  const envelopeId = generateId('w');
  const envelope = {
    id: envelopeId,
    type: 'T',
    parent_id: parentId || null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'pending',
    intent: decision.intent || 'decide',
    title: await generateTitle(decision.instruction || stripChatFraming(intake.text), 'task'),
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
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: memoryContext,
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=T, fallback from attach)`);
  await writeHistory(envelopeId, null, 'pending', 'brain', 'Created from intake ' + intake.id);
  await processEnvelope(envelope, memoryContext);
}

// ---- Continue handler: resume a blocked mission ----
async function handleContinue(intake, decision, memoryContext, pendingAckText = null) {
  const targetId = decision.continue_mission || decision.continue_envelope;
  log('INFO', `Continue: intake ${intake.id} â†’ resuming blocked mission ${targetId}`);

  if (!targetId) {
    log('WARN', `Continue missing continue_mission field, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  const mission = await firestoreRead('work', targetId);
  if (!mission) {
    log('WARN', `Continue target ${targetId} not found, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  // Only reopen blocked or complete missions (not active â€” that's an attach/status check)
  if (!['blocked', 'complete'].includes(mission.status)) {
    log('WARN', `Continue target ${targetId} is ${mission.status}, treating as attach`);
    return handleAttach(intake, decision, memoryContext);
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
  mission._unblock_attempted = false; // Reset retry cap for new attempt
  mission.updated_at = now();

  await firestoreWrite('work', targetId, mission);
  await writeHistory(targetId, prevStatus, 'active', 'brain',
    `Resumed via continue: ${intake.text.substring(0, 100)}`);
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
    `Cancelled: ${(decision.reasoning || '').substring(0, 100)}`);
  log('INFO', `Mission ${targetId} cancelled (was ${prevStatus})`);

  // Cascade cancellation to children
  await cascadeCancelChildren(targetId);

  // Deliver confirmation
  await deliverStatusUpdate(targetId, `✅ Cancelled mission: "${target.instruction.substring(0, 100)}"`);
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

// ---- Envelope processing (Phase 3: memory-enriched Cortex loop) ----
async function processEnvelope(envelope, memoryContext) {
  log('INFO', `Processing envelope: ${envelope.id} (type=${envelope.type}, status=${envelope.status})`);

  // Use passed memory context, or recall fresh if not provided
  const memory = memoryContext || await recallMemory(envelope.instruction);

  // Phase 5: Initialize shared workspace for this envelope
  await initSharedWorkspace(envelope.id);

  // Mark active
  envelope.status = 'active';
  envelope.started_at = now();
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'pending', 'active', 'brain', 'Processing started');

  // Cortex loop
  let priorResults = [];
  let iteration = 0;

  // If resuming from needs_input, inject the human's response
  if (envelope.context_forward) {
    priorResults.push({
      agent: 'human',
      result: envelope.context_forward,
      success: true,
    });
    log('INFO', `Injected human response: ${envelope.context_forward.substring(0, 80)}`);
  }

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
    if (envelope._unblock_attempted && action === 'checkpoint_plan') {
      log('WARN', `Post-unblock guard: blocking checkpoint_plan after self-unblock — forcing blocked`);
      action = 'blocked';
      decision.action = 'blocked';
      // Preserve the synthesis from the synthesize_with_failure that triggered self-unblock
      decision.blocker = decision.failure_summary || envelope._failure_synthesis || 'Could not resolve failure through alternative approach';
      decision.blocker_type = 'task_failure';
      // Use the original failure synthesis as the output so the user gets useful info
      decision.escalation_message = envelope._failure_synthesis || decision.failure_summary || decision.blocker;
    }

    if (action === 'synthesize') {
      // Check for unresolved failures — block premature success synthesis
      // Only count HARD failures (not timeouts) that haven't been superseded by a subsequent success.
      // Timeouts are soft — they indicate the work may have partially completed, not a real error.
      const lastSuccessIdx = priorResults.map((r, i) => r.success === true ? i : -1).filter(i => i >= 0).pop() ?? -1;
      const hasUnresolvedFail = priorResults.some((r, i) => r.success === false && !r.timedOut && i > lastSuccessIdx);
      if (hasUnresolvedFail && iteration < MAX_ITERATIONS - 1) {
        log('WARN', `Blocking premature synthesize — unresolved hard failures in prior_results (iteration ${iteration})`);
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Synthesize blocked: there are unresolved failures in prior_results. You MUST either: (1) dispatch to investigate/fix the failure, or (2) use "synthesize_with_failure" action with explicit failure details. Plain "synthesize" is not allowed when tasks have failed.`,
        });
        continue;
      }

      // Wrap synthesis in C→T under the mission
      await createCT(envelope, {
        checkpointTitle: 'Formulate response',
        taskTitle: 'Synthesize answer',
        taskOutput: decision.synthesis || decision.response || decision.message,
        taskIntent: 'synthesize',
        deliveryStatus: 'internal',
      });

      envelope.output = decision.synthesis || decision.response || decision.message;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) {
        envelope.delivery_status = 'pending';
        envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
      }
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Synthesized response');
      log('INFO', `Envelope ${envelope.id} complete (synthesize)`);

      // Publish artifacts to Drive BEFORE cleanup (so shared/ files are still available)
      if (envelope.type === 'M') {
        const artifactLinks = await publishArtifacts(envelope);
        // Append artifact links to the output for mouth delivery
        if (artifactLinks && artifactLinks.length > 0) {
          const linkText = artifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
          envelope.output = (envelope.output || '') + `\n\n📌 **Artifacts published to Drive:**\n${linkText}`;
          await firestoreWrite('work', envelope.id, envelope);
        }
      }

      // Phase 3: Write completed work to memory
      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);

      // Activate any missions waiting on this one via depends_on
      if (envelope.type === 'M') {
        await activateDependents(envelope.id);
        // Check if mission's project is now fully complete
        if (envelope.project_id) {
          await checkProjectCompletion(envelope.project_id);
        }
        // Fire event-triggered responsibilities
        await fireEventResponsibilities('on_complete', {
          mission_id: envelope.id,
          project_id: envelope.project_id,
        });

        // Delegation result reply: if this mission was delegated from another agent,
        // create an output envelope for Mouth to deliver the DELEGATION-RESULT marker.
        // Note: the actual resume mechanism is Firestore children (checkWaitingEnvelopes),
        // not this message. This is for human readability + summary content.
        if (envelope.source_meta?.delegation_ref) {
          const resultMarker = composeDelegationResultMarker({
            targetEmail: envelope.source_meta.delegated_from || '',
            ref: envelope.source_meta.delegation_ref,
            status: envelope.status, // 'complete'
            missionId: envelope.id,
            body: (envelope.output || '').substring(0, 500),
          });
          try {
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
            log('INFO', `Delegation result envelope created: ${resultOutputId} for ref ${envelope.source_meta.delegation_ref}`);
          } catch (e) {
            log('WARN', `Failed to create delegation result envelope: ${e.message}`);
          }
        }
      }

      // Phase 3C: Context promotion — suggest new context entries for the parent project
      if (envelope.project_id && envelope.type === 'M' && envelope.context) {
        await suggestContextPromotions(envelope);
      }

      return;
    }

    if (action === 'synthesize_with_failure') {
      // Check if the most recent work actually failed — if the last N dispatch results
      // (from the most recent checkpoint plan) are all successful, Cortex is using
      // synthesize_with_failure due to stale old failures in context. Upgrade to synthesize.
      const recentDispatches = priorResults.filter(r => r.agent !== 'system' && r.agent !== 'human');
      const lastPlanStart = priorResults.findLastIndex(r => r.agent === 'system' && r.result?.includes('[SYSTEM] Checkpoint'));
      const recentWork = lastPlanStart >= 0 ? recentDispatches.filter((_, i) => i >= lastPlanStart) : recentDispatches;
      const recentAllSucceeded = recentWork.length > 0 && recentWork.every(r => r.success !== false);
      
      if (recentAllSucceeded) {
        log('INFO', `synthesize_with_failure upgrade: recent checkpoint plan fully succeeded — treating as synthesize`);
        action = 'synthesize';
        decision.action = 'synthesize';
        // Fall through to synthesize handler below
      }
      // Self-unblock attempt: before accepting failure, check if Cortex can find an alternative
      else if (!envelope._unblock_attempted && iteration < MAX_ITERATIONS - 2) {
        log('INFO', `Self-unblock attempt for ${envelope.id} — asking Cortex for alternative approach`);
        envelope._unblock_attempted = true;
        envelope._failure_synthesis = decision.synthesis || decision.failure_summary || decision.message || null;
        await firestoreWrite('work', envelope.id, envelope);

        priorResults.push({
          agent: 'system',
          result: `[SELF-UNBLOCK CHECK] Before accepting this failure, try to find an alternative approach. Can you resolve this yourself using a different method? If YES: use \"checkpoint_plan\" to try the alternative. If NO — this is a genuine external dependency you cannot work around — use \"blocked\" action with a concrete blocker description. Do NOT use synthesize_with_failure; use \"blocked\" instead.`,
        });
        continue;
      }

      // If we already tried self-unblock or we're at max iterations, check if the work actually succeeded despite the failure label
      // Cortex sometimes uses synthesize_with_failure out of habit even when the self-unblock resolved the issue
      const lastSuccessAfterUnblock = priorResults.some((r, i) => r.success === true && i > priorResults.findIndex(x => x.agent === 'system' && x.result?.includes('[SELF-UNBLOCK CHECK]')));
      if (lastSuccessAfterUnblock) {
        log('INFO', `Self-unblock succeeded for ${envelope.id} — treating synthesize_with_failure as complete (successful dispatch found after unblock)`);
        envelope.output = decision.synthesis || decision.response || decision.message;
        envelope.status = 'complete';
        envelope.completed_at = now();
        envelope.updated_at = now();
        if (!envelope.parent_id) {
          envelope.delivery_status = 'pending';
          envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
        }

        // Publish artifacts BEFORE cleanup
        if (envelope.type === 'M') {
          const artifactLinks = await publishArtifacts(envelope);
          if (artifactLinks && artifactLinks.length > 0) {
            const linkText = artifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
            envelope.output = (envelope.output || '') + `\n\n📌 **Artifacts published to Drive:**\n${linkText}`;
          }
        }

        await firestoreWrite('work', envelope.id, envelope);
        await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Completed (self-unblock resolved the failure)');
        log('INFO', `Envelope ${envelope.id} complete (synthesize_with_failure → self-unblock succeeded)`);
        await writeMemory(envelope);
        await cleanupSharedWorkspace(envelope.id);

        // Post-completion lifecycle
        if (envelope.type === 'M') {
          await activateDependents(envelope.id);
          if (envelope.project_id) await checkProjectCompletion(envelope.project_id);
          await fireEventResponsibilities('on_complete', {
            mission_id: envelope.id, project_id: envelope.project_id,
          });
        }
        if (envelope.project_id && envelope.type === 'M' && envelope.context) {
          await suggestContextPromotions(envelope);
        }
        return;
      }

      if (envelope.type === 'M') {
        // Missions get blocked status — they stay alive for resumption
        envelope.output = decision.synthesis || decision.response || decision.message;
        envelope.status = 'blocked';
        envelope.blocker = decision.failure_summary || decision.synthesis || decision.message || 'Unknown blocker';
        envelope.blocker_type = decision.blocker_type || 'other';
        envelope.blocked_at = now();
        envelope.updated_at = now();
        if (!envelope.parent_id) {
          envelope.delivery_status = 'pending';
          envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
        }
        await firestoreWrite('work', envelope.id, envelope);
        await writeHistory(envelope.id, 'active', 'blocked', 'brain',
          `Blocked (self-unblock exhausted): ${(decision.failure_summary || '').substring(0, 200)}`);
        log('INFO', `Envelope ${envelope.id} BLOCKED (synthesize_with_failure → blocked: ${(decision.failure_summary || '').substring(0, 80)})`);
        await writeMemory(envelope);
        // Fire event-triggered responsibilities on failure
        await fireEventResponsibilities('on_failure', {
          mission_id: envelope.id,
          project_id: envelope.project_id,
        });
        return;
      }

      // Non-mission envelopes (tasks) still complete normally with failure
      envelope.output = decision.synthesis || decision.response || decision.message;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) {
        envelope.delivery_status = 'pending';
        envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
      }

      // Publish artifacts BEFORE cleanup (even for non-mission envelopes)
      const taskArtifactLinks = await publishArtifacts(envelope);
      if (taskArtifactLinks && taskArtifactLinks.length > 0) {
        const linkText = taskArtifactLinks.map(a => `- [${a.name}](${a.url})`).join('\n');
        envelope.output = (envelope.output || '') + `\n\n📌 **Artifacts published to Drive:**\n${linkText}`;
      }

      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain',
        `Synthesized with acknowledged failure: ${(decision.failure_summary || '').substring(0, 200)}`);
      log('INFO', `Envelope ${envelope.id} complete (synthesize_with_failure: ${(decision.failure_summary || '').substring(0, 80)})`);

      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);
      return;
    }

    if (action === 'blocked') {
      // Direct blocked action from Cortex — genuine external dependency confirmed
      envelope.output = decision.escalation_message || decision.blocker_description || decision.blocker || decision.synthesis || decision.response || decision.message || 'Blocked on external dependency.';
      envelope.status = 'blocked';
      envelope.blocker = decision.blocker || 'Unknown blocker';
      envelope.blocker_type = decision.blocker_type || 'other';
      envelope.blocked_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) {
        envelope.delivery_status = 'pending';
        envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
      }
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'blocked', 'brain',
        `Blocked: ${(decision.blocker || '').substring(0, 200)}`);
      log('INFO', `Envelope ${envelope.id} BLOCKED (${decision.blocker_type || 'other'}): ${(decision.blocker || '').substring(0, 80)}`);
      await writeMemory(envelope);
      return;
    }

    if (action === 'needs_input') {
      // Phase 3: Block envelope and ask the human for clarification (ambiguous — needs info)
      envelope.output = decision.question || decision.message || 'I need more information to proceed.';
      envelope.status = 'needs_input';
      envelope.updated_at = now();
      if (!envelope.parent_id) {
        envelope.delivery_status = 'pending';
        envelope.delivery_address = addressFromMeta(envelope.source_meta, envelope.source_channel);
      }
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'needs_input', 'brain', `Needs: ${decision.what_is_needed || 'clarification'}`);
      log('INFO', `Envelope ${envelope.id} needs_input (ambiguous)`);
      return;
    }

    if (action === 'follow_process') {
      // Deterministic process execution — redirect to dedicated executor
      const processId = decision.processId || decision.process_id;

      if (!processId) {
        log('ERROR', 'follow_process: missing processId');
        priorResults.push({ agent: 'system', result: '[SYSTEM] follow_process requires a processId.' });
        continue;
      }

      // Guard: prevent re-executing a process that already ran in this envelope
      if (envelope.process_id) {
        log('WARN', `follow_process: process '${envelope.process_id}' already executed on this envelope — forcing synthesize`);
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Process '${envelope.process_id}' has already been executed on this envelope. You MUST now synthesize the results. Use action "synthesize" with a summary of what was accomplished.`,
        });
        continue;
      }

      await ensureProcessesLoaded();
      if (!PROCESSES[processId]) {
        log('ERROR', `follow_process: process '${processId}' not found`);
        priorResults.push({ agent: 'system', result: `[SYSTEM] Process '${processId}' not found. Available processes: ${Object.keys(PROCESSES).join(', ') || 'none'}` });
        continue;
      }

      // Hand off to deterministic executor — exits the Cortex decide loop
      log('INFO', `follow_process: handing off '${processId}' to executeProcess`);
      const processResult = await executeProcess(null, decision, memoryContext || {}, processId, envelope);
      if (processResult === 'fallback_to_decide') {
        log('WARN', `follow_process: process '${processId}' fell back to decide — continuing loop`);
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] follow_process '${processId}' failed: missing required parameters. Use checkpoint_plan instead and include the work steps directly, or re-issue follow_process with all required parameters filled in the "parameters" field.`,
        });
        continue;
      }
      return processResult;
    }

    if (action === 'delegate') {
      // Canon-compliant delegation: Cortex decides to delegate work to a project teammate.
      // Brain creates delegation envelope + output for Mouth delivery. Motor never communicates.
      const targetEmail = decision.target_email;
      const delegateInstruction = decision.instruction || '';
      const delegateCriteria = decision.accept_criteria || '';
      const delegateProjectId = decision.project_id || envelope.project_id || null;

      if (!targetEmail) {
        log('ERROR', 'delegate: missing target_email');
        priorResults.push({ agent: 'system', result: '[SYSTEM] delegate requires a target_email. Check project team members for available agents.' });
        continue;
      }

      log('INFO', `Cortex delegate: target=${targetEmail} project=${delegateProjectId}`);

      // Create Task envelope with status='waiting'
      const delegTaskId = generateId('w');
      const delegTaskEnvelope = {
        id: delegTaskId,
        type: 'T',
        parent_id: envelope.id,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'waiting',
        intent: 'delegation',
        title: await generateTitle(delegateInstruction, 'task'),
        instruction: delegateInstruction,
        accept_criteria: delegateCriteria,
        context_summary: null,
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: 'brain',
        source_meta: {
          step_type: 'delegation',
          delegated_to: targetEmail,
          target_agent_email: targetEmail,
        },
        project_id: delegateProjectId,
        created_at: now(),
        started_at: now(),
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      await firestoreWrite('work', delegTaskId, delegTaskEnvelope);
      await writeHistory(delegTaskId, null, 'waiting', 'brain', `Delegating to ${targetEmail}`);

      // Compose delegation marker as output envelope for Mouth
      const delegMarker = composeDelegationMarker({
        targetEmail,
        ref: delegTaskId,
        from: AGENT_EMAIL || AGENT_ID,
        project: delegateProjectId || 'none',
        body: delegateInstruction,
      });

      const delegOutputId = generateId('w');
      await firestoreWrite('work', delegOutputId, {
        id: delegOutputId,
        type: 'T',
        parent_id: delegTaskId,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'complete',
        intent: 'delegation_send',
        title: `Delegation to ${targetEmail}`,
        instruction: delegateInstruction,
        output: delegMarker,
        delivery_status: 'pending',
        delivery_target: targetEmail,
        delivery_space_id: (delegateProjectId && PROJECTS[delegateProjectId]?.gchat_space_id) || null,
        delivery_address: makeAddress('gchat', {
          space: (delegateProjectId && PROJECTS[delegateProjectId]?.gchat_space_id)
            ? `spaces/${PROJECTS[delegateProjectId].gchat_space_id}`
            : null,
        }),
        project_id: delegateProjectId,
        source_channel: 'brain',
        created_at: now(),
        updated_at: now(),
      });

      log('INFO', `Delegation output envelope created: ${delegOutputId} → ${targetEmail}`);

      // Set mission to waiting
      envelope.children = envelope.children || [];
      envelope.children.push(delegTaskId);
      envelope.status = 'waiting';
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'waiting', 'brain', `Waiting for delegation to ${targetEmail}`);

      log('INFO', `Mission ${envelope.id} waiting for delegation to ${targetEmail}`);
      return;
    }

    if (action === 'checkpoint_plan') {
      // Phase 5: Checkpoint nesting — M → C → T hierarchy
      const checkpoints = decision.checkpoints;
      if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
        log('ERROR', `Checkpoint plan has no checkpoints`);
        priorResults.push({ agent: 'system', result: '[SYSTEM] checkpoint_plan requires a non-empty "checkpoints" array.' });
        continue;
      }

      log('INFO', `Checkpoint plan received: ${checkpoints.length} checkpoints`);

      let allResults = []; // Accumulated results across all checkpoints
      let planFailed = false;

      for (let ci = 0; ci < checkpoints.length; ci++) {
        const cp = checkpoints[ci];
        const cpNum = ci + 1;
        const cpInstruction = cp.instruction || `Checkpoint ${cpNum}`;
        const cpCriteria = cp.accept_criteria || '';
        const cpTasks = cp.tasks || [];

        // Create Checkpoint envelope
        const cpId = generateId('w');
        const cpEnvelope = {
          id: cpId,
          type: 'C',
          parent_id: envelope.id,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'active',
          intent: 'checkpoint',
          title: await generateTitle(cpInstruction, 'checkpoint'),
          instruction: cpInstruction,
          accept_criteria: cpCriteria,
          context_summary: allResults.length > 0
            ? `Prior checkpoints:\n${allResults.map(r => `Step ${r.step} (${r.agent}): ${(r.result || '').substring(0, 200)}`).join('\n')}`
            : envelope.context_summary || null,
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'brain',
          source_meta: { dispatched_by: envelope.id, checkpoint: cpNum, checkpoint_total: checkpoints.length },
          project_id: envelope.project_id || null,
          created_at: now(),
          started_at: now(),
          completed_at: null,
          updated_at: now(),
          iteration: 0,
        };

        await firestoreWrite('work', cpId, cpEnvelope);
        await writeHistory(cpId, null, 'active', 'brain', `Checkpoint ${cpNum}/${checkpoints.length}: ${cpInstruction.substring(0, 60)}`);
        // Note: shared workspace is mission-scoped (shared/{envelope.id}/), initialized in processEnvelope

        // Track checkpoint on parent mission
        envelope.children.push(cpId);
        envelope.updated_at = now();
        await firestoreWrite('work', envelope.id, envelope);

        log('INFO', `Checkpoint ${cpNum}/${checkpoints.length}: ${cpInstruction.substring(0, 60)} (${cpTasks.length} tasks)`);

        // Execute tasks within this checkpoint
        let cpResults = [];
        let cpFailed = false;

        for (let ti = 0; ti < cpTasks.length; ti++) {
          const task = cpTasks[ti];
          const taskNum = ti + 1;
          const taskAgent = task.agent;
          const taskDesc = task.task || task.instruction || '';
          const taskCriteria = task.accept_criteria
            || `Task "${(task.task || task.brief_part || '').substring(0, 60)}" completed with evidence of meaningful work. No unresolved errors in tool output.`;
          const stepType = task._step_type || 'standard';
          const isOptional = task._optional === true;

          if (!taskAgent) {
            log('WARN', `Checkpoint ${cpNum} task ${taskNum} missing agent, skipping`);
            cpResults.push({ step: `${cpNum}.${taskNum}`, agent: 'unknown', result: '[SKIPPED]', success: false });
            continue;
          }

          // ---- Optional step: skip if agent unavailable ----
          if (isOptional) {
            // Check if the target agent is online (for fleet agents)
            let agentAvailable = true;
            try {
              const token = await getAuthToken();
              if (token && PRIME_ID) {
                const fleetUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/fleet/${taskAgent}`;
                const fleetResp = await fetch(fleetUrl, {
                  headers: { 'Authorization': `Bearer ${token}` },
                  signal: AbortSignal.timeout(3000),
                });
                if (fleetResp.ok) {
                  const fleetDoc = await fleetResp.json();
                  const fleetStatus = fleetDoc.fields?.status?.stringValue;
                  agentAvailable = fleetStatus === 'online';
                }
              }
            } catch { /* assume available on error */ }

            if (!agentAvailable) {
              log('INFO', `CP${cpNum} Task ${taskNum}: Optional step skipped — agent '${taskAgent}' unavailable`);
              cpResults.push({
                step: `${cpNum}.${taskNum}`,
                agent: taskAgent,
                result: '[SKIPPED] Optional step — agent unavailable',
                success: true,
                durationMs: 0,
              });
              continue;
            }
          }

          // ---- Approval Gate: pause checkpoint and notify ----
          if (stepType === 'approval_gate') {
            log('INFO', `CP${cpNum} Task ${taskNum}: Approval gate — pausing checkpoint`);

            // Write approval request to Firestore
            const approvalId = generateId('apr');
            try {
              const token = await getAuthToken();
              if (token) {
                const approvalUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/approvals/${approvalId}`;
                await fetch(approvalUrl, {
                  method: 'PATCH',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fields: {
                    envelopeId: { stringValue: envelope.id },
                    checkpointId: { stringValue: cpId },
                    taskIndex: { integerValue: String(ti) },
                    checkpointIndex: { integerValue: String(ci) },
                    title: { stringValue: taskDesc.substring(0, 200) },
                    description: { stringValue: taskCriteria || taskDesc },
                    processId: { stringValue: envelope.process_id || '' },
                    processName: { stringValue: decision.process_name || '' },
                    planId: { stringValue: envelope.plan_id || '' },
                    status: { stringValue: 'pending' },
                    requestedAt: { stringValue: now() },
                  }}),
                });
              }
            } catch (e) { log('WARN', `Failed to write approval doc: ${e.message}`); }

            // Mark checkpoint as awaiting approval
            cpEnvelope.status = 'awaiting_approval';
            cpEnvelope.source_meta = {
              ...cpEnvelope.source_meta,
              approval_id: approvalId,
              approval_task_index: ti,
            };
            cpEnvelope.updated_at = now();
            await firestoreWrite('work', cpId, cpEnvelope);
            await writeHistory(cpId, 'active', 'awaiting_approval', 'brain',
              `Approval gate: ${taskDesc.substring(0, 60)}`);

            // Send notification via mouth (creates a deliverable envelope)
            const rawStepData = cpResults.map(r => ({
              step: r.step, agent: r.agent, success: r.success,
              result: (r.result || '').substring(0, 1500),
            }));
            const fallbackNotif = `🔔 **Approval needed**\n\n**${taskDesc.substring(0, 200)}**\n\n${taskCriteria ? `Criteria: ${taskCriteria}\n\n` : ''}Reply \`approve\` or \`reject\` here, or use the dashboard.`;
            const cleanNotif = await summarizeForDelivery('approval_request', fallbackNotif, {
              steps: rawStepData,
              title: taskDesc.substring(0, 200),
              processName: decision.process_name || '',
              customMessage: taskCriteria || '',
            });
            const notifOutput = `🔔 **Approval needed**\n\n${cleanNotif}\n\nReply \`approve\` or \`reject\` here, or use the dashboard.`;

            const notifId = generateId('w');
            await firestoreWrite('work', notifId, {
              id: notifId,
              type: 'T',
              parent_id: envelope.id,
              owner: AGENT_EMAIL || AGENT_ID,
              status: 'complete',
              intent: 'notification',
              instruction: 'Approval gate notification',
              output: notifOutput,
              source_channel: envelope.source_channel || 'system',
              source_meta: { approval_id: approvalId, notification_type: 'approval_gate' },
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
              delivery_status: envelope.parent_id ? 'internal' : 'pending',
              ...(envelope.parent_id ? {} : { delivery_address: addressFromMeta(envelope.source_meta, envelope.source_channel) }),
            });

            // Record partial results so far
            allResults.push(...cpResults);

            // Store resume state on the envelope so approval handler can continue
            envelope.source_meta = {
              ...envelope.source_meta,
              paused_approval_id: approvalId,
              paused_checkpoint_index: ci,
              paused_task_index: ti,
              paused_checkpoints: checkpoints,
              paused_all_results: allResults,
            };
            envelope.status = 'awaiting_approval';
            envelope.updated_at = now();
            await firestoreWrite('work', envelope.id, envelope);

            log('INFO', `Checkpoint paused at CP${cpNum} task ${taskNum} — awaiting approval ${approvalId}`);

            // Exit the entire checkpoint plan — will be resumed by approval handler
            return;
          }

          // ---- Spawn Responsibility: create a responsibility entry ----
          if (stepType === 'spawn_responsibility') {
            log('INFO', `CP${cpNum} Task ${taskNum}: Spawning responsibility via motor`);

            const respResult = await callAgent('motor', {
              instruction: `Create a new responsibility using the responsibility-manage tool:\n\nresponsibility-manage create --name "${taskDesc.replace(/"/g, '\\"')}" --instruction "${(taskCriteria || taskDesc).replace(/"/g, '\\"')}"\n\nThis is a process step of type 'spawn_responsibility'.${formatSkillCatalog(SKILL_INDEX)}`,
              accept_criteria: 'Responsibility created successfully',
              _missionId: envelope.id,
            });

            cpResults.push({
              step: `${cpNum}.${taskNum}`,
              agent: 'motor',
              task: `[spawn_responsibility] ${taskDesc.substring(0, 150)}`,
              result: respResult.success
                ? await smartSummarize(respResult.output || '', CTX_AGENT_STEP, 'Summarize this responsibility creation result. Keep the responsibility name and config details.')
                : `[FAILED] ${respResult.error}`,
              success: respResult.success,
              durationMs: respResult.durationMs,
            });

            if (!respResult.success && !isOptional) {
              cpFailed = true;
              break;
            }
            continue;
          }

          // ---- Delegation: cross-agent dispatch via GChat ----
          if (stepType === 'delegation') {
            const delegateSpecialty = task._specialty || taskAgent;
            log('INFO', `CP${cpNum} Task ${taskNum}: Cross-agent delegation to '${delegateSpecialty}'`);

            // Resolve target agent email by specialty from fleet docs
            let targetAgentEmail = null;
            try {
              const primesSnap = await firestoreQuery('primes', []);
              for (const prime of primesSnap) {
                const fleetSnap = await firestoreQuery(`primes/${prime.id}/fleet`, [
                  { field: 'specialty', op: 'EQUAL', value: { stringValue: delegateSpecialty } },
                ]);
                const onlineAgent = fleetSnap.find(a => a.status === 'online');
                if (onlineAgent) {
                  targetAgentEmail = onlineAgent.email;
                  break;
                }
              }
            } catch (e) {
              log('WARN', `Delegation: failed to resolve agent for specialty '${delegateSpecialty}': ${e.message}`);
            }

            if (!targetAgentEmail) {
              log('ERROR', `Delegation: no online agent found for specialty '${delegateSpecialty}'`);
              cpResults.push({ step: taskNum, agent: taskAgent, result: `[FAILED] No online agent found for specialty '${delegateSpecialty}'`, success: false });
              continue;
            }

            // Create Task envelope with status='waiting' (not active)
            const taskId = generateId('w');
            const taskEnvelope = {
              id: taskId,
              type: 'T',
              parent_id: cpId,
              owner: AGENT_EMAIL || AGENT_ID,
              status: 'waiting',
              intent: 'delegation',
              title: await generateTitle(taskDesc, 'task'),
              instruction: taskDesc,
              accept_criteria: taskCriteria,
              context_summary: null,
              output: null,
              children: [],
              context_forward: null,
              error: null,
              source_channel: 'brain',
              source_meta: {
                dispatched_by: cpId,
                checkpoint: cpNum,
                task_step: taskNum,
                step_type: 'delegation',
                delegated_to: delegateSpecialty,
                target_agent_email: targetAgentEmail,
              },
              project_id: envelope.project_id || null,
              created_at: now(),
              started_at: now(),
              completed_at: null,
              updated_at: now(),
              iteration: 0,
            };

            await firestoreWrite('work', taskId, taskEnvelope);
            await writeHistory(taskId, null, 'waiting', 'brain', `Delegating to ${delegateSpecialty} (${targetAgentEmail})`);

            cpEnvelope.children.push(taskId);
            cpEnvelope.updated_at = now();
            await firestoreWrite('work', cpId, cpEnvelope);

            // Compose delegation marker as output envelope for Mouth delivery
            // Canon: Brain creates output, Mouth delivers. No direct chat-send.
            const marker = composeDelegationMarker({
              targetEmail: targetAgentEmail,
              ref: taskId,
              from: AGENT_EMAIL || AGENT_ID,
              project: envelope.project_id || 'none',
              body: taskDesc,
            });

            const delegOutputId = generateId('w');
            await firestoreWrite('work', delegOutputId, {
              id: delegOutputId,
              type: 'T',
              parent_id: taskId,
              owner: AGENT_EMAIL || AGENT_ID,
              status: 'complete',
              intent: 'delegation_send',
              title: `Delegation to ${delegateSpecialty}`,
              instruction: taskDesc,
              output: marker,
              delivery_status: 'pending',
              delivery_target: targetAgentEmail,
              delivery_address: makeAddress('gchat', {
                space: (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id)
                  ? `spaces/${PROJECTS[envelope.project_id].gchat_space_id}`
                  : null,
              }),
              source_channel: 'brain',
              created_at: now(),
              updated_at: now(),
            });
            log('INFO', `Delegation output envelope created: ${delegOutputId} → ${targetAgentEmail} for ref ${taskId}`);

            // Set checkpoint to waiting — checkWaitingEnvelopes() will resume when child completes
            cpEnvelope.status = 'waiting';
            cpEnvelope.updated_at = now();
            await firestoreWrite('work', cpId, cpEnvelope);
            await writeHistory(cpId, 'active', 'waiting', 'brain', `Waiting for delegation to ${delegateSpecialty}`);

            log('INFO', `CP${cpNum} Task ${taskNum}: delegation sent, checkpoint waiting`);
            // Don't call callAgent — return and let checkWaitingEnvelopes resume
            return;
          }

          // Create Task envelope under Checkpoint
          const taskId = generateId('w');
          const taskEnvelope = {
            id: taskId,
            type: 'T',
            parent_id: cpId,
            owner: AGENT_EMAIL || AGENT_ID,
            status: 'active',
            intent: stepType === 'delegation' ? 'delegation' : (task.intent || 'execute'),
            title: await generateTitle(taskDesc, 'task'),
            instruction: taskDesc,
            accept_criteria: taskCriteria,
            context_summary: [...allResults, ...cpResults].length > 0
              ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${(r.result || '').substring(0, 300)}`).join('\n')
              : null,
            output: null,
            children: [],
            context_forward: null,
            error: null,
            source_channel: 'brain',
            source_meta: {
              dispatched_by: cpId,
              checkpoint: cpNum,
              task_step: taskNum,
              step_type: stepType,
              ...(stepType === 'delegation' ? { delegated_to: task._specialty || taskAgent } : {}),
            },
            project_id: envelope.project_id || null,
            created_at: now(),
            started_at: now(),
            completed_at: null,
            updated_at: now(),
            iteration: 0,
          };

          await firestoreWrite('work', taskId, taskEnvelope);
          await writeHistory(taskId, null, 'active', 'brain', `CP${cpNum} Task ${taskNum}: ${taskAgent}`);

          cpEnvelope.children.push(taskId);
          cpEnvelope.updated_at = now();
          await firestoreWrite('work', cpId, cpEnvelope);

          log('INFO', `CP${cpNum} Task ${taskNum}/${cpTasks.length}: ${taskAgent} — ${taskDesc.substring(0, 60)}`);

          // Prepend project context for checkpoint tasks (all agent types)
          if (envelope.project_id) {
            const projCtx = buildProjectContext(envelope.project_id, envelope.context);
            if (projCtx) {
              taskEnvelope.instruction = `[PROJECT CONTEXT]\n${projCtx}\n[END PROJECT CONTEXT]\n\n${taskEnvelope.instruction}`;
            }
          }

          // Dispatch to agent — use taskEnvelope.instruction which includes project context
          // Layer A: Inject full skill catalog for execution agents
          const skillCatalog = (taskAgent === 'motor' || taskAgent === 'temporal-research')
            ? formatSkillCatalog(SKILL_INDEX)
            : '';

          let result = await callAgent(taskAgent, {
            instruction: taskEnvelope.instruction + skillCatalog,
            accept_criteria: taskCriteria,
            _missionId: envelope.id,  // mission-scoped shared workspace
            context_summary: [...allResults, ...cpResults].length > 0
              ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n')
              : undefined,
            prior_results_context: [...allResults, ...cpResults].length > 0
              ? [...allResults, ...cpResults].map(r => `## Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n\n')
              : undefined,
            memory_context: envelope.memory_context || null,
          });

          // Retry once on failure
          if (!result.success) {
            log('WARN', `CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
            result = await callAgent(taskAgent, {
              instruction: `${taskEnvelope.instruction}${skillCatalog}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.`,
              accept_criteria: taskCriteria,
              _missionId: envelope.id,
              memory_context: envelope.memory_context || null,
            });
          }

          // ---- Evidence floor: flag suspiciously shallow motor completions ----
          if (result.success && taskAgent === 'motor') {
            const rText = result.output || result.text || '';
            const toolLog = rText.match(/\[TOOL EXECUTION LOG\]([\s\S]*?)\[END TOOL LOG\]/)?.[1] || '';
            const toolCount = (toolLog.match(/\[TOOL\]/g) || []).length;
            const hasWrites = /writeFile|drive-upload|drive-mkdir|git commit/i.test(toolLog);
            const hasErrors = /ERROR:|No such file|command not found|Permission denied/i.test(toolLog);
            const durationMs = result.durationMs || 0;

            if (durationMs < 8000 && toolCount <= 2 && !hasWrites) {
              log('WARN', `Evidence floor: motor CP${cpNum} T${taskNum} completed in ${durationMs}ms with ${toolCount} tools, no writes — flagging`);
              result.output = (result.output || '') + '\n[EVIDENCE WARNING: Task completed very quickly with minimal tool usage and no write operations. Verify that meaningful work was performed.]';
            }
            if (hasErrors && !/\[WARNING: One or more tool calls returned errors/.test(rText)) {
              log('WARN', `Evidence floor: motor CP${cpNum} T${taskNum} reported SUCCESS but tool log contains errors`);
              result.output = (result.output || '') + '\n[EVIDENCE WARNING: Tool execution log contains errors despite SUCCESS status.]';
            }
          }

          // ---- Cerebellum verification ----
          // Verify task output against accept_criteria before marking complete.
          // Skip for: failed tasks, no criteria, cerebellum itself, ack intents.
          if (result.success && taskCriteria && taskAgent !== 'cerebellum' && taskEnvelope.intent !== 'ack') {
            try {
              log('INFO', `CP${cpNum} Task ${taskNum}: dispatching to cerebellum for verification`);
              const verification = await callAgent('cerebellum', {
                instruction: [
                  'Verify the following task output meets the acceptance criteria.',
                  '',
                  '## Accept Criteria',
                  taskCriteria,
                  '',
                  '## Task Output',
                  result.output || '(empty)',
                ].join('\n'),
                _missionId: envelope.id,
              });

              // Note: callAgent auto-converts cerebellum FAIL verdicts to success=false,
              // so we check output regardless of the success flag.
              const verOutput = verification.output || verification.error;
              if (verOutput) {
                try {
                  // Strip markdown fences if present
                  const cleaned = verOutput.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
                  const verdict = JSON.parse(cleaned);
                  if (verdict.verdict === 'FAIL') {
                    const failedChecks = (verdict.checks || []).filter(c => !c.pass);
                    const failSummary = failedChecks.map(c => `- ${c.criteria}: ${c.evidence}`).join('\n');
                    log('WARN', `Cerebellum FAIL on CP${cpNum} Task ${taskNum}: ${failSummary}`);

                    // Retry motor with cerebellum's feedback
                    log('INFO', `CP${cpNum} Task ${taskNum}: retrying ${taskAgent} with cerebellum feedback`);
                    result = await callAgent(taskAgent, {
                      instruction: [
                        taskEnvelope.instruction,
                        '',
                        '[VERIFICATION FAILED] An independent verification found issues with your previous output:',
                        failSummary,
                        verdict.recommendation ? `\nRecommendation: ${verdict.recommendation}` : '',
                        '\nPlease re-execute and address the issues above. Use tools to actually run commands — do NOT simulate or assume results.',
                      ].join('\n'),
                      accept_criteria: taskCriteria,
                      _missionId: envelope.id,
                      memory_context: envelope.memory_context || null,
                    });
                    taskEnvelope.output = result.output || result.error;

                    // Re-verify the retry
                    if (result.success) {
                      log('INFO', `CP${cpNum} Task ${taskNum}: re-verifying retry output with cerebellum`);
                      const reVerification = await callAgent('cerebellum', {
                        instruction: [
                          'Verify the following RETRY task output meets the acceptance criteria.',
                          'This is a second attempt after the first failed verification.',
                          '',
                          '## Accept Criteria',
                          taskCriteria,
                          '',
                          '## Task Output (Retry)',
                          result.output || '(empty)',
                        ].join('\n'),
                        _missionId: envelope.id,
                      });

                      const reVerOutput = reVerification.output || reVerification.error;
                      if (reVerOutput) {
                        try {
                          const cleanedR = reVerOutput.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
                          const reVerdict = JSON.parse(cleanedR);
                          if (reVerdict.verdict === 'FAIL') {
                            const reFailChecks = (reVerdict.checks || []).filter(c => !c.pass);
                            log('WARN', `Cerebellum FAIL on retry CP${cpNum} Task ${taskNum}: ${reFailChecks.map(c => `${c.criteria}: ${c.evidence}`).join('; ')}`);
                            result.success = false;
                            result.error = `Verification failed after retry: ${reFailChecks.map(c => c.evidence).join('; ')}`;
                          } else {
                            log('INFO', `Cerebellum ALL_PASS on retry CP${cpNum} Task ${taskNum}`);
                          }
                        } catch {
                          log('WARN', `Cerebellum returned non-JSON on re-verify CP${cpNum} Task ${taskNum}, accepting result`);
                        }
                      }
                    }
                  } else {
                    log('INFO', `Cerebellum ALL_PASS on CP${cpNum} Task ${taskNum}`);
                  }
                } catch {
                  log('WARN', `Cerebellum returned non-JSON for CP${cpNum} Task ${taskNum}, skipping verification`);
                }
              }
            } catch (verErr) {
              log('WARN', `Cerebellum dispatch failed for CP${cpNum} Task ${taskNum}: ${verErr.message}. Continuing without verification.`);
            }
          }

          // Update task envelope
          taskEnvelope.output = result.output || result.error;
          taskEnvelope.status = result.success ? 'complete' : 'failed';
          taskEnvelope.error = result.error;
          taskEnvelope.completed_at = now();
          taskEnvelope.updated_at = now();
          await firestoreWrite('work', taskId, taskEnvelope);
          await writeHistory(taskId, 'active', taskEnvelope.status, taskAgent,
            result.success ? `Completed (${result.durationMs}ms)` : `Failed: ${result.error}`);

          // Persist task output as file in shared/ for cross-task access
          if (result.success && result.output && result.output.length > 200) {
            try {
              const taskTitle = taskEnvelope.title || `task-${cpNum}-${taskNum}`;
              const slug = taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
              const { writeFileSync: wfs } = await import('fs');
              wfs(`${CORE_DIR}/shared/${envelope.id}/${slug}.md`, result.output);
              log('INFO', `Task output saved to shared/${envelope.id}/${slug}.md (${result.output.length} chars)`);
            } catch (e) {
              log('WARN', `Failed to save task output to shared/: ${e.message}`);
            }
          }

          const stepResult = {
            step: `${cpNum}.${taskNum}`,
            agent: taskAgent,
            task: taskDesc.substring(0, 200),
            result: result.success
              ? smartTruncate(result.output || '', CTX_AGENT_STEP)
              : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_DISPATCH_FAILURE)}`,
            success: result.success,
            durationMs: result.durationMs,
          };
          cpResults.push(stepResult);

          log('INFO', `CP${cpNum} Task ${taskNum} ${result.success ? 'completed' : 'FAILED'} (${result.durationMs}ms)`);

          if (!result.success) {
            cpFailed = true;
            break;
          }
        }

        // Mark checkpoint complete or failed
        cpEnvelope.status = cpFailed ? 'failed' : 'complete';
        cpEnvelope.output = cpFailed ? `Checkpoint failed at task ${cpResults.length}/${cpTasks.length}` : `Checkpoint complete: ${cpResults.length} tasks`;
        cpEnvelope.completed_at = now();
        cpEnvelope.updated_at = now();
        await firestoreWrite('work', cpId, cpEnvelope);
        await writeHistory(cpId, 'active', cpEnvelope.status, 'brain',
          cpFailed ? `Failed at task ${cpResults.length}` : `Complete (${cpResults.length} tasks)`);
        // Note: shared workspace cleanup happens at mission level, not per-checkpoint

        allResults.push(...cpResults);

        log('INFO', `Checkpoint ${cpNum} ${cpFailed ? 'FAILED' : 'complete'} (${cpResults.length} tasks)`);

        if (cpFailed) {
          planFailed = true;
          break;
        }
      }

      // Feed all results back to Cortex for synthesis
      priorResults.push(...allResults.map(r => ({
        agent: r.agent,
        task: r.task,
        result: r.result,
        success: r.success,
        durationMs: r.durationMs,
        checkpoint_step: r.step,
      })));

      if (planFailed) {
        const replanCount = (envelope._replan_count = (envelope._replan_count || 0) + 1);
        const MAX_REPLANS = 3;
        if (replanCount >= MAX_REPLANS) {
          priorResults.push({
            agent: 'system',
            result: `[SYSTEM] Checkpoint plan failed ${replanCount} times. You MUST use "synthesize_with_failure" or "needs_input" to escalate. No more checkpoint_plan allowed.`,
          });
        } else {
          priorResults.push({
            agent: 'system',
            result: `[SYSTEM] Checkpoint failed (attempt ${replanCount}/${MAX_REPLANS}). Return a NEW checkpoint_plan with adjusted approach, or use "needs_input" to escalate a hard blocker.`,
          });
        }
      }

      log('INFO', `Checkpoint plan ${planFailed ? 'FAILED' : 'complete'}: ${checkpoints.length} checkpoints, ${allResults.length} total tasks. Consulting Cortex.`);
      continue; // Loop back to Cortex for synthesize decision
    }

    if (action === 'status_update') {
      const message = decision.message || 'Working on it...';
      await deliverStatusUpdate(envelope.id, message);
      log('INFO', `Status update sent for envelope ${envelope.id}`);
      continue;
    }

    if (action === 'needs_input') {
      envelope.status = 'needs_input';
      envelope.output = decision.question || decision.what_is_needed;
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'needs_input', 'brain', decision.question);
      log('INFO', `Envelope ${envelope.id} needs input: ${decision.question}`);
      return;
    }

    // Unknown action — nudge Cortex to use a valid action
    log('WARN', `Unknown action '${action}' — nudging Cortex`);
    priorResults.push({
      agent: 'system',
      result: `[SYSTEM] Invalid action "${action}". Valid actions: checkpoint_plan, synthesize, synthesize_with_failure, needs_input, blocked, follow_process, status_update.`,
    });
    continue;
  }

  // Max iterations reached
  envelope.status = 'failed';
  envelope.error = `Max iterations (${MAX_ITERATIONS}) reached`;
  envelope.completed_at = now();
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'active', 'failed', 'brain', envelope.error);
  log('ERROR', `Envelope ${envelope.id} failed: max iterations`);
  await cleanupSharedWorkspace(envelope.id);
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
      const resultStr = typeof latest.result === 'string'
        ? latest.result.substring(0, 2000)
        : JSON.stringify(latest.result || '').substring(0, 2000);
      blockParts.push(`Result: ${resultStr}`);
    } else if (latest.agent === 'human') {
      blockParts.push(`Human input: ${(latest.result || '').substring(0, 500)}`);
    }
  }

  // Append memory context summary if available
  if (memoryResults?.recalled && iteration === 1) {
    blockParts.push(`Memory: ${memoryResults.recalled.substring(0, 1000)}`);
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
            task: child.instruction?.substring(0, 200) || '',
            result: child.status === 'complete'
              ? (child.output || '').substring(0, 4000)
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
        `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${r.result.substring(0, 500)}`
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
  // Missions with children were already being worked on â€” reprocessing them
  // from scratch creates duplicate work. Archive stale ones instead.
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
      const orphaned = allDocs.filter(e => e.type === 'M' && (e.owner || '').includes(agentId) &&
        (e.status === 'active' || e.status === 'pending'));
      if (orphaned.length > 0) {
        log('INFO', `Startup recovery: found ${orphaned.length} orphaned M envelope(s)`);
        for (const env of orphaned) {
          const hasChildren = Array.isArray(env.children) && env.children.length > 0;

          if (hasChildren) {
            // Mission was already being worked on before restart â€” do NOT reprocess from scratch.
            // Check if the children are all done (archive the mission) or still active (let them complete).
            const childStatuses = env.children.map(cid => {
              const child = allDocs.find(d => d.id === cid);
              return child?.status || 'unknown';
            });
            const allChildrenDone = childStatuses.every(s => s === 'complete' || s === 'archived' || s === 'failed');

            if (allChildrenDone) {
              log('INFO', `Recovery: archiving completed mission ${env.id}`);
              await firestoreWrite('work', env.id, {
                status: 'archived', archived_reason: 'child_complete',
                delivery_status: 'delivered', updated_at: now(),
              });
              await writeHistory(env.id, env.status, 'archived', 'brain', 'Archived after restart — all children complete');
            } else {
              const activeChildren = childStatuses.filter(s => s === 'active' || s === 'pending');
              if (activeChildren.length > 0) {
                log('INFO', `Recovery: mission ${env.id} has ${activeChildren.length} active children — ensuring parent active`);
                if (env.status !== 'active') {
                  await firestoreWrite('work', env.id, { status: 'active', updated_at: now() });
                }
              } else {
                log('INFO', `Recovery: resuming mission ${env.id} — all children terminal, needs re-planning`);
                try {
                  await firestoreWrite('work', env.id, { status: 'active', updated_at: now() });
                  await writeHistory(env.id, env.status, 'active', 'brain', 'Resumed after restart — children terminal, re-planning');
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
