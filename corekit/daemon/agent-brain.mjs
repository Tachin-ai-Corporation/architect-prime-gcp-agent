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
import { readFileSync, appendFileSync, existsSync, watchFile, readdirSync, writeFileSync, mkdirSync } from 'fs';
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
import { composeDeliverable } from '../corekit/lib/deliverable.mjs';
import { executeCheckpoints } from '../corekit/lib/checkpoint-executor.mjs';
import { assembleConversation } from '../corekit/lib/conversation-context.mjs';
import { toStr } from '../corekit/lib/to-str.mjs';
import { extractCheckpoints } from '../corekit/lib/plan-utils.mjs';
import { extractCues, searchWork, recentWorkDigest } from '../corekit/lib/work-recall.mjs';
import { toContentParts } from '../corekit/lib/prompt-blocks.mjs';
import { shouldCompact, splitIterationBlocks, redactSecrets, validateMissionDigest, missionDigestInstruction, spliceCompacted } from '../corekit/lib/compaction.mjs';
import {
  handleSynthesize,
  handleBlocked,
  handleNeedsInput,
  handleStatusUpdate,
  handleSynthesizeWithFailure,
  handleFollowProcess,
  handleDelegate,
  handleCheckpointPlan,
  handleWait
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
const RESULT_PREVIEW_CHARS = CONTRACTS.dispatch?.result_preview_chars || 700;
const CONTEXT_SLICE_CHARS = CONTRACTS.dispatch?.context_slice_chars || 500;
const LOG_FILE = '/tmp/agent-brain.log';

// Work Queue Discipline: max 1 active M-type mission at a time per agent.
// New missions enter as 'queued'; dequeueAndProcess() promotes one to 'active' when the slot is empty.
let activeMissionId = null;
const CORTEX_ROUTE = CONTRACTS.agents?.gatewayRoute || 'brain/cortex';

// Brain's own LLM â€” used ONLY for simple textâ†’text summarization via direct
// Vertex AI calls (not through gateway). Classify/decide/synthesize always use
// cortex through the gateway. See summarizeViaVertex() below.
const BRAIN_MODEL = CONTRACTS.dispatch?.model || 'gemini-2.5-flash';
const BRAIN_ROUTE = CORTEX_ROUTE;  // classify/decide/synthesize always use cortex

// ---- Project contracts config ----
const PROJECT_PROMOTION_AUTO = CONTRACTS.projects?.promotion_auto || false;

// ---- Artifacts config (loaded from prime Firestore doc at startup) ----
// Drive folder provisioning removed — git substrate is the sole artifact store (C-24)

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

// toStr imported from ../corekit/lib/to-str.mjs (single source of truth)

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
    completeEnvelope,
    onMissionComplete: async (mission) => {
      // Create delegation result envelope for delivery back to the delegator
      if (!mission.source_meta?.delegation_ref) return;
      const resultMarker = composeDelegationResultMarker({
        targetEmail: mission.source_meta.delegated_from || '',
        ref: mission.source_meta.delegation_ref,
        status: mission.status,
        missionId: mission.id,
        body: smartTruncate(toStr(mission.output), RESULT_PREVIEW_CHARS),
        trailer: {
          fullOutputChars: (mission.output || '').length,
          artifactRef: mission.context?.artifact_status === 'ok'
            ? `${mission.project_id || 'repo'}@mission/${mission.id}` : null,
          artifactStatus: mission.context?.artifact_status || null,
        },
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
          space: (mission.project_id && PROJECTS[mission.project_id]?.gchat_space_id) || null,
        }),
        project_id: mission.project_id || null,
        source_channel: 'brain',
        source_meta: { delegation_ref: mission.source_meta.delegation_ref },
        created_at: now(),
        updated_at: now(),
      });
      log('INFO', `Delegation result envelope created: ${resultOutputId} for mission ${mission.id}`);

      // Cross-agent write: complete the delegation T-envelope on the sender's side
      try {
        const delegRef = await firestoreRead('work', mission.source_meta.delegation_ref);
        if (delegRef && delegRef.status === 'waiting') {
          await firestoreWrite('work', delegRef.id, {
            ...delegRef,
            status: 'complete',
            output: toStr(mission.output).substring(0, 4000),
            completed_at: now(),
            updated_at: now(),
          });
          log('INFO', `Delegation ref ${delegRef.id} marked complete (cross-agent write)`);

          // Proactive delegation recovery: check if all checkpoint siblings are now terminal
          if (delegRef.parent_id) {
            try {
              const cpEnv = await firestoreRead('work', delegRef.parent_id);
              if (cpEnv && cpEnv.type === 'C' && cpEnv.status === 'waiting') {
                const siblings = cpEnv.children || [];
                let allDone = true;
                const sibResults = [];
                for (const sibId of siblings) {
                  if (sibId === delegRef.id) {
                    sibResults.push({ agent: delegRef.owner, result: smartTruncate(toStr(mission.output), RESULT_PREVIEW_CHARS), success: true });
                    continue;
                  }
                  const sib = await firestoreRead('work', sibId);
                  if (!sib || ['complete', 'failed', 'archived', 'cancelled', 'blocked'].includes(sib?.status)) {
                    const isOk = sib?.status === 'complete' || sib?.status === 'archived';
                    sibResults.push({ agent: sib?.owner || 'unknown', result: smartTruncate(toStr(sib?.output || sib?.status || ''), RESULT_PREVIEW_CHARS), success: isOk });
                  } else {
                    allDone = false;
                    break;
                  }
                }
                if (allDone && siblings.length > 0) {
                  const summary = sibResults.map((r, i) =>
                    `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${r.result}`
                  ).join('\n\n');
                  cpEnv.status = 'complete';
                  cpEnv.output = summary;
                  cpEnv.updated_at = now();
                  await firestoreWrite('work', cpEnv.id, cpEnv);
                  log('INFO', `Checkpoint ${cpEnv.id} completed proactively (all ${siblings.length} delegation children terminal)`);
                  if (cpEnv.parent_id) {
                    const parentMission = await firestoreRead('work', cpEnv.parent_id);
                    if (parentMission && parentMission.status === 'active') {
                      parentMission.status = 'queued';
                      parentMission.context_forward = `[DELEGATION RESULTS]\n${summary}`;
                      parentMission.updated_at = now();
                      await firestoreWrite('work', parentMission.id, parentMission);
                      log('INFO', `Mission ${parentMission.id} re-queued proactively after delegation completion`);
                    }
                  }
                }
              }
            } catch (cpErr) {
              log('WARN', `Proactive delegation recovery failed: ${cpErr.message}`);
            }
          }
        }
      } catch (e) {
        log('WARN', `Failed to complete delegation ref ${mission.source_meta.delegation_ref}: ${e.message}`);
      }
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
// Work artifacts are deployment-rooted (top-level); actor state stays prime-scoped.
// C-1: Prime is executor, not storage root. Work carries owner + prime_id fields.

const DEPLOYMENT_ROOTED = new Set([
  'work', 'processes', 'plans', 'approvals', 'projects', 'skill-proposals',
]);

function collectionParent(collection) {
  return DEPLOYMENT_ROOTED.has(collection) ? '' : `primes/${PRIME_ID}`;
}

function pathFor(collection, docId) {
  return DEPLOYMENT_ROOTED.has(collection)
    ? `${collection}/${docId}`
    : `primes/${PRIME_ID}/${collection}/${docId}`;
}

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
  // Stamp executor identity on all work writes (C-1: Prime is executor, not owner)
  if (collection === 'work' && data) {
    data.owner = data.owner || AGENT_EMAIL || AGENT_ID;
  }
  // Stamp prime_id on all deployment-rooted writes for dashboard filtering
  if (DEPLOYMENT_ROOTED.has(collection) && data) {
    data.prime_id = data.prime_id || PRIME_ID;
  }
  return _db.write(pathFor(collection, docId), data);
}

// SESSION_CONTEXT_PLAN Phase 3: field-masked partial update — writes ONLY the
// named fields so concurrent whole-doc writers (child-completion propagation,
// waiting sweeps) cannot be clobbered by, or clobber, a compaction splice.
async function firestoreWriteFields(collection, docId, fieldsObj) {
  const fieldPaths = Object.keys(fieldsObj);
  return _db.patch(pathFor(collection, docId), fieldPaths, firestoreEncode(fieldsObj));
}

async function firestoreRead(collection, docId) {
  // Dual-read fallback: try new path first, fall back to old prime-scoped path
  const result = await _db.read(pathFor(collection, docId));
  if (!result && DEPLOYMENT_ROOTED.has(collection)) {
    const fallback = await _db.read(`primes/${PRIME_ID}/${collection}/${docId}`);
    if (fallback) {
      log('DEBUG', `Dual-read fallback: found ${collection}/${docId} at old prime-scoped path`);
    }
    return fallback;
  }
  return result;
}

async function firestoreQuery(collection, filters, opts) {
  return _db.query(collectionParent(collection), collection, filters, opts);
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
  // SESSION_CONTEXT_PLAN Phase 2: two system blocks (stable | MEMORY) and a
  // cache-tiered content-parts user message. The [BRAIN-ORCHESTRATED] header
  // opens the boot-stable bytes; the per-mission Requester line rides the
  // mission tier so it never re-keys the boot block.
  const sysBlocks = buildSystemBlocks(mode, payload);
  const pingerEmail = payload.envelope?.source_meta?.senderEmail || '';
  const userBlocks = [
    { label: '', text: '[BRAIN-ORCHESTRATED]', tier: 'boot' },
    ...(pingerEmail ? [{ label: 'REQUESTER', text: `Use this email for Drive sharing and communication: ${pingerEmail}`, tier: 'mission' }] : []),
    ...buildUserBlocks(mode, payload),
  ];
  const userContent = toContentParts(userBlocks);

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
        { role: 'system', content: sysBlocks.stable },
        ...(sysBlocks.volatile ? [{ role: 'system', content: sysBlocks.volatile }] : []),
        { role: 'user', content: userContent },
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

  // SESSION_CONTEXT_PLAN Phase 0: classify and respond_compose run before an
  // envelope exists, so the envelope-scoped mission_total accumulator never
  // sees them — log their usage intake-scoped here. decide/plan modes are
  // already covered by the decide-loop accumulator.
  if ((mode === 'classify' || mode === 'respond_compose') && data.usage) {
    const u = data.usage;
    log('INFO', `[TELEMETRY] llm_usage organ=cortex mode=${mode} input=${u.promptTokenCount || u.prompt_tokens || 0} output=${u.candidatesTokenCount || u.completion_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${_cortexDuration}ms`);
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

  // Skill catalog — gives prefrontal awareness of available skills for task planning
  if (Object.keys(SKILL_INDEX).length > 0) {
    sysParts.push(`[SKILL INDEX — available capabilities for routing decisions]\n${formatSkillCatalog(SKILL_INDEX)}`);
  }
  const systemPrompt = sysParts.join('\n\n');

  // Build user prompt: instruction + memory + accumulated context
  const pingerEmail = payload.envelope?.source_meta?.senderEmail || '';
  const analyzePayload = {
    mode: 'analyze',
    instruction: payload.envelope?.instruction || '',
    context_summary: payload.envelope?.context_summary || '',
    memory: payload.memory || {},
    prior_results: payload.prior_results || [],
  };
  const userPrompt = [
    `[BRAIN-ORCHESTRATED]`,
    pingerEmail ? `## Requester\nUse this email for Drive sharing and communication: ${pingerEmail}\n` : '',
    JSON.stringify(analyzePayload)
  ].filter(Boolean).join('\n');

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

  // SESSION_CONTEXT_PLAN Phase 0: prefrontal usage was previously discarded.
  if (data.usage) {
    const u = data.usage;
    log('INFO', `[TELEMETRY] llm_usage organ=prefrontal model=${route} input=${u.promptTokenCount || u.prompt_tokens || 0} output=${u.candidatesTokenCount || u.completion_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${durationMs}ms`);
  }

  const brief = await enforceSchema(content, 'analyze');
  if (brief && brief.parts) {
    const owners = brief.parts.reduce((acc, p) => { acc[p.ownership] = (acc[p.ownership] || 0) + 1; return acc; }, {});
    log('INFO', `Brief: ${brief.parts.length} parts (${Object.entries(owners).map(([k, v]) => `${k}=${v}`).join(', ')}), process_match=${brief.process_match || 'none'}`);
  }
  return brief;
}

// SESSION_CONTEXT_PLAN Phase 2: the system prompt splits into two blocks —
// stable [SOUL, IDENTITY, capabilities, registries, constraint] and volatile
// [MEMORY.md]. MEMORY is appended at every envelope completion; carrying it
// last means a memory write re-keys only the small volatile block while the
// large stable prefix keeps its 1h cache entry (gateway places the breakpoint
// on the first system block).
function buildSystemBlocks(mode, payload) {
  const parts = [];
  const volatileParts = [];

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
    volatileParts.push(`[MEMORY â€” baseline knowledge]\n${memoryContent}`);
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
    parts.push(`[PROCESS REGISTRY — reusable playbooks]\nProcesses are stored, versioned playbooks that define step-by-step workflows. Use the "follow_process" action when work matches an existing process. Available:\n${JSON.stringify(processSummary, null, 2)}`);
  }

  // 6. JSON constraint. SESSION_CONTEXT_PLAN Phase 1: the mode marker lives
  // in the user payload (every buildUserPrompt branch sets payload.mode) —
  // keeping it out of the system prompt makes the prompt byte-identical
  // across classify/decide/respond_compose, the prerequisite for cross-mode
  // prompt-cache sharing.
  parts.push(`You MUST respond with exactly one JSON block and nothing else.`);

  return { stable: parts.join('\n\n'), volatile: volatileParts.join('\n\n') };
}

// Build the full mode payload as an OBJECT (SESSION_CONTEXT_PLAN Phase 2:
// renamed from buildUserPrompt — block partitioning needs the object, and
// serialization moved to the call sites).
function buildModePayload(mode, payload) {
  if (mode === 'classify') {
    const classifyPayload = {
      mode: 'classify',
      inbound: payload.inbound,
      conversation_context: payload.conversation || null,
      memory: payload.memory || {},
      core_facts: payload.memory?.recalled || null,
      active_envelopes: payload.active_envelopes || [],
      recent_completed_missions: payload.recent_completed_missions || [],
      respond_reads_available: payload.respond_reads_available || [],
      classification_guidance: {
        blocked_missions: 'If a blocked mission exists and the user message addresses the blocker or asks to retry/fix/continue the work, classify as "continue" with continue_mission set to the mission ID. Do NOT classify as "attach" for blocked missions — use "continue" instead.',
        attach_vs_continue: '"attach" = follow-up info or new instruction for active/waiting work. "continue" = resume blocked/stalled work or retry after failure.',
        dedup_prevention: 'CRITICAL: If a recent_completed_mission has a very similar instruction to the new inbound message (same goal/action), do NOT create a new_mission. Instead classify as "attach" to add follow-up context to the prior mission. Only create new_mission if the inbound is genuinely different work.',
        project_identification: 'If the work matches a known project from the project_registry, set project_id in your response. Not every piece of work belongs to a project.',
        required_processes: 'CRITICAL: Projects may define required_processes — activities that MUST go through a specific process. When classifying, if any part of the instruction matches a required_process description on a project, you MUST set project_id to that project. On the decide step, the required process will be surfaced for you to follow.',
        conversation_grounding: 'When a conversation block is present, resolve pronouns, ellipsis, and references ("yes", "do that", "the second one", "same as before") against it before classifying. The most recent prime turn (last_prime_reply) is what the human is most likely replying to.',
        respond_rules: 'Classify as "respond" ONLY when the turn is conversational or informational and fully answerable from the conversation, memory, active_envelopes, and recent_completed_missions already in this payload, or by triggering at most one whitelisted read tool listed in respond_reads_available. greetings, acknowledgments, status questions about visible work, questions answered by provided memory, clarifying answers. A respond performs NO state-mutating execution. If any whitelisted read tool in respond_reads_available is needed to answer, add its ID to the "reads" array (at most one read tool can be requested; requesting multiple reads is strictly forbidden); default "reads" to empty otherwise. Put the complete reply in "response" — if a read is requested, this response serves as a draft that will be synthesized against the live tool results using respond_compose. If the turn requires running anything else, writing or mutating state, or doing complex work: it is not a respond. When in doubt, new_mission.',
        input_answer_binding: 'If an active envelope is in needs_input or blocked and the new turn plausibly answers its question (check the conversation: the question is usually the last prime turn), classify as "continue" with the answer carried in instruction — never as a new_mission that restates the question.',
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
    return classifyPayload;
  }
  if (mode === 'decide') {
    const decidePayload = {
      mode: 'decide',
      envelope: payload.envelope,
      memory: payload.memory || {},
      envelope_context: payload.envelope_context || null,
      // SESSION_CONTEXT_PLAN Phase 1: the raw REGISTRY.agents duplicate was
      // dropped — the system prompt's [AGENT CAPABILITIES] summary carries
      // names/intents/tools/constraints; routes and gen-params are daemon
      // plumbing cortex must not depend on (B-16).
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
      
      // Inject rendered canon prominently for cortex to see
      const renderedCtx = buildProjectContext(envProjectId, payload.envelope?.context);
      if (renderedCtx) {
        decidePayload.rendered_project_context = renderedCtx;
      }

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
        skill_guidance: 'Write task instructions that describe WHAT should happen, not HOW. Sub-agents are specialists — they know their own tools. Describe the desired outcome, inputs, and acceptance criteria.',
      };
      // Project-scoped process preference
      if (envProjectId && PROJECTS[envProjectId]?.standardProcesses?.length > 0) {
        decidePayload.dispatch_guidance.process_preference = 
          `Project "${PROJECTS[envProjectId].name}" has standard processes: ${PROJECTS[envProjectId].standardProcesses.join(', ')}. Prefer follow_process over checkpoint_plan when a standard process covers the work.`;
      }
    } else {
      // No Brief (non-execution-bound or analysis failed) — fall back to checkpoint_plan guidance
      decidePayload.dispatch_guidance = {
        rule: 'ALL work MUST use checkpoint_plan. One focused task per task entry. Even single-step work is one checkpoint with one task.',
        reasoning: 'Each motor task has a limited step budget. Atomic tasks prevent timeouts and preserve context on failure. The M→C→T hierarchy ensures progress tracking and enables re-planning on failure.',
        skill_guidance: 'Write task instructions that describe WHAT should happen, not HOW. Sub-agents are specialists — they know their own tools. Describe the desired outcome, inputs, and acceptance criteria.',
      };
      // Project-scoped process preference
      if (envProjectId && PROJECTS[envProjectId]?.standardProcesses?.length > 0) {
        decidePayload.dispatch_guidance.process_preference = 
          `Project "${PROJECTS[envProjectId].name}" has standard processes: ${PROJECTS[envProjectId].standardProcesses.join(', ')}. Prefer follow_process over checkpoint_plan when a standard process covers the work.`;
      }
    }
    // CP-5: Inject GOAL STATE block for missions with accept criteria
    if (CONTRACTS.dispatch?.goal_state_enabled !== false && payload.envelope?.accept_criteria) {
      const criteria = payload.envelope.accept_criteria;
      const priorResults = payload.prior_results || [];
      decidePayload.goal_state = {
        accept_criteria: criteria,
        prior_work_count: priorResults.length,
        instruction: 'Include a goal_check object in your decision with criteria_met, criteria_unmet, confidence (high/medium/low), and assessment. Do NOT synthesize while criteria_unmet has items unless all paths have been exhausted.',
      };
    }
    // B-28: Surface premise check from Brief
    if (payload.brief?.premise === 'flawed' && payload.brief?.premise_note) {
      decidePayload.premise_check = {
        status: 'flawed',
        note: payload.brief.premise_note,
        instruction: 'Prefrontal flagged the request\'s premise as flawed. Consider whether to proceed with the original instruction or reframe the work. Do NOT plan inside a false frame.',
      };
    }
    return decidePayload;
  }
  if (mode === 'respond_compose') {
    const composePayload = {
      mode: 'respond_compose',
      inbound: payload.inbound,
      conversation_context: payload.conversation || null,
      memory: payload.memory || {},
      tool_grounding: payload.tool_grounding || '',
      draft_response: payload.draft_response || '',
      guidance: 'Combine the user prompt, conversation history, any retrieved memories, and the live tool results to compose a final, concise, accurate reply. Avoid any placeholder text or hallucinations. The reply should be natural and match the conversational tone.'
    };
    return composePayload;
  }
  return payload;
}

// SESSION_CONTEXT_PLAN Phase 2: partition the mode payload into cache-tiered
// blocks, ordered most-stable-first. The gateway turns tiers into Anthropic
// cache breakpoints; on Gemini the same byte order feeds implicit caching.
// Envelope keys are sorted so serialization is byte-deterministic across
// iterations (Firestore field order is not guaranteed).
const ENVELOPE_MUTABLE_KEYS = new Set([
  'status', 'updated_at', 'iteration', 'started_at', 'completed_at',
  'output', 'error', 'children', 'step_ledger', 'claimed_by', 'claimed_at',
  '_cp_progress', '_lastDecision', '_accumulated_context', 'context_forward',
  'delivery_status', 'delivered_at',
]);

function splitEnvelope(env) {
  const statics = {};
  const state = {};
  for (const k of Object.keys(env || {}).sort()) {
    (ENVELOPE_MUTABLE_KEYS.has(k) ? state : statics)[k] = env[k];
  }
  return { statics, state };
}

function buildUserBlocks(mode, payload) {
  const p = buildModePayload(mode, payload);
  if (mode === 'decide') {
    const { statics, state } = splitEnvelope(p.envelope);
    const boot = {
      skill_index: p.skill_index,
      available_processes: p.available_processes,
    };
    const mission = {
      envelope: statics,
      memory: p.memory,
      project: p.project,
      rendered_project_context: p.rendered_project_context,
      required_processes: p.required_processes,
      brief: p.brief,
      dispatch_guidance: p.dispatch_guidance,
    };
    const working = {
      mode: 'decide',
      iteration: p.iteration,
      envelope_state: state,
      envelope_context: p.envelope_context,
      prior_results: p.prior_results,
      pending_intake_count: p.pending_intake_count,
      pending_queue: p.pending_queue,
      goal_state: p.goal_state,
      premise_check: p.premise_check,
    };
    return [
      { label: 'BOOT-STABLE CONTEXT', text: JSON.stringify(boot), tier: 'boot' },
      { label: 'MISSION CONTEXT', text: JSON.stringify(mission), tier: 'mission' },
      { label: 'WORKING STATE', text: JSON.stringify(working), tier: 'volatile' },
    ];
  }
  if (mode === 'classify') {
    const boot = {
      classification_guidance: p.classification_guidance,
      skill_index: p.skill_index,
      respond_reads_available: p.respond_reads_available,
      process_registry: p.process_registry,
      project_registry: p.project_registry,
    };
    const turn = {
      mode: 'classify',
      inbound: p.inbound,
      conversation_context: p.conversation_context,
      memory: p.memory,
      core_facts: p.core_facts,
      active_envelopes: p.active_envelopes,
      recent_completed_missions: p.recent_completed_missions,
    };
    return [
      { label: 'BOOT-STABLE CONTEXT', text: JSON.stringify(boot), tier: 'boot' },
      { label: 'CURRENT TURN', text: JSON.stringify(turn), tier: 'volatile' },
    ];
  }
  // respond_compose and any other mode: single volatile block.
  return [{ label: '', text: JSON.stringify(p), tier: 'volatile' }];
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
    firestoreRead,
    addressFromMeta,
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

  const pingerEmail = envelope.source_meta?.senderEmail || '';
  // SESSION_CONTEXT_PLAN Phase 2: mission-stable blocks lead, prior work
  // follows, the per-task instruction and criteria come LAST — the stable
  // prefix stays byte-identical across a plan's tasks (Gemini implicit
  // caching keys on it) and instruction-last is the long-context attention
  // position. B-28: probe dispatches remain [header, instruction, criteria]
  // only — no mission bytes exist in a probe's prompt, so exact-prefix
  // caching cannot serve it mission content.
  const userMessage = [
    `[BRAIN-ORCHESTRATED]`,
    // Mission-stable prefix (byte-identical across tasks in one mission)
    ...(envelope._probe ? [] : [
      workspaceDirective,
      pingerEmail ? `\n## Requester\nUse this email for Drive sharing and communication: ${pingerEmail}` : '',
      envelope._projectContext ? `\n## Project Context\n${envelope._projectContext}` : '',
      envelope._sourceText ? `\n## Original User Request\n${envelope._sourceText}` : '',
      envelope.memory_context ? `\n## Relevant Memory\n${envelope.memory_context}` : '',
    ]),
    // Prior work (grows across the plan)
    ...(envelope._probe ? [] : [
      context ? `\n## Context\n${context}` : '',
      envelope.prior_results_context ? `\n## Prior Work\n${envelope.prior_results_context}` : '',
    ]),
    // The task itself — last
    instruction ? `\n## Task\n${instruction}` : '',
    criteria ? `\n## Acceptance Criteria\n${criteria}` : '',
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
    if (context.last_prime_reply) queryParts.push(`Previous Assistant: ${context.last_prime_reply}`);
    if (context.conversation_hint) queryParts.push(`Recent conversation: ${context.conversation_hint.substring(0, 800)}`);
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

    if (context.tier === 'ambient') {
      let ambientBlock = memoryParts.join('\n\n');
      if (ambientBlock.length > 2500) ambientBlock = ambientBlock.substring(0, 2500) + '\n[...trimmed]';
      log('INFO', `[TELEMETRY] recall_layers tier=ambient cues=${cues.length} chars=${ambientBlock.length}`);
      return ambientBlock ? { recalled: ambientBlock } : {};
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
    const instruction = toStr(envelope.instruction).replace(/\s+/g, ' ').trim().substring(0, 120);
    const outputText = envelope.output ? toStr(envelope.output) : (envelope.context_summary ? toStr(envelope.context_summary) : '');
    const texture = outputText ? ` -> ${outputText.replace(/\s+/g, ' ').trim().substring(0, 120)}` : '';

    // 2. Append one-line summary to MEMORY.md (working memory accumulates during the day)
    const memoryPath = `${CORE_DIR}/workspace/MEMORY.md`;
    if (existsSync(memoryPath)) {
      const currentSize = readFileSync(memoryPath, 'utf8').length;
      if (currentSize < 3000) { // Size guard — prevent unbounded growth
        const datestamp = new Date().toISOString().substring(0, 10);
        const oneLiner = `- [${datestamp}] ${envelope.type}: ${instruction}${texture}\n`;
        appendFileSync(memoryPath, oneLiner);
        log('INFO', `Memory write: MEMORY.md appended (${currentSize + oneLiner.length} chars)`);
      } else {
        log('INFO', `Memory write: MEMORY.md at ${currentSize} chars, skipping append (await consolidation)`);
      }
    }

    // 3. Mark envelope as memory-written (for archival)
    const token = await getAuthToken();
    if (token) {
      const url = `${FIRESTORE_BASE}/work/${envelope.id}?updateMask.fieldPaths=memory_written`;
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
    priorResults = null,
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

  // Step 1: Set envelope fields.
  // Compose a guaranteed-non-empty deliverable summary (B-14, B-30): a real
  // synthesis is used verbatim; an empty/artifact-only body is replaced with a
  // deterministic summary built from mission state. Done BEFORE the mission
  // record and artifact footer so both capture the summary, never a bare body.
  const _deliverable = composeDeliverable(envelope, {
    synthesis: output,
    priorResults,
    minChars: CONTRACTS.dispatch?.min_deliverable_chars,
  });
  if (_deliverable.composed) {
    log('WARN', `[deliverable] Empty synthesis on ${envelope.id} (${status}) — composed summary from mission state`);
  }
  envelope.output = _deliverable.body;
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

  // Step 3a: Write mission record (before publish, so commit captures it)
  if (envelope.type === 'M' && envelope.project_id && status === 'complete') {
    try {
      const { writeMissionRecord } = await import('../corekit/lib/mission-record.mjs');
      const sharedDir = `${CORE_DIR}/shared/${envelope.id}`;
      const recordResult = writeMissionRecord(envelope, sharedDir, log);
      if (recordResult.written) {
        envelope.context = envelope.context || {};
        envelope.context.mission_record = recordResult.files;
      }
    } catch (e) {
      log('WARN', `Mission record write failed: ${e.message}`);
      envelope.context = envelope.context || {};
      envelope.context.artifact_status = `degraded: mission record failed`;
    }
  }

  // Step 3: Publish artifacts (before cleanup, so shared/ files exist)
  if (!skipArtifacts && envelope.type === 'M') {
    try {
      const manifest = await publishArtifacts(envelope);
      // publish() returns a git manifest object, not an array of links
      if (manifest && manifest.kind === 'artifact_manifest') {
        const fileCount = manifest.files?.length || 0;
        const commitShort = manifest.commit?.slice(0, 8) || 'unknown';
        envelope.output = (envelope.output || '') +
          `\n\n📎 Artifacts: ${manifest.repo || 'repo'}@${manifest.branch || 'main'} ${commitShort} — ${fileCount} file(s)`;
        envelope.context = envelope.context || {};
        envelope.context.artifact_status = 'ok';
      }
    } catch (e) {
      log('WARN', `Artifact publishing failed: ${e.message}`);
      envelope.context = envelope.context || {};
      envelope.context.artifact_status = `degraded: ${e.message.slice(0, 100)}`;
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
    log('INFO', `[TELEMETRY] mission_total mission=${envelope.id} calls=${u.callCount} input=${u.totalInput} output=${u.totalOutput} cached=${u.totalCached} cache_writes=${u.totalCacheWrites || 0}`);
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

    // Delegation result reply (on complete, blocked, or failed — delegator must know)
    if (['complete', 'blocked', 'failed'].includes(status) && envelope.source_meta?.delegation_ref) {
      try {
        const resultMarker = composeDelegationResultMarker({
          targetEmail: envelope.source_meta.delegated_from || '',
          ref: envelope.source_meta.delegation_ref,
          status: envelope.status,
          missionId: envelope.id,
          body: smartTruncate(toStr(envelope.output), RESULT_PREVIEW_CHARS),
          trailer: {
            fullOutputChars: (envelope.output || '').length,
            artifactRef: envelope.context?.artifact_status === 'ok'
              ? `${envelope.project_id || 'repo'}@mission/${envelope.id}` : null,
            artifactStatus: envelope.context?.artifact_status || null,
          },
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
            space: (envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id) || null,
          }),
          project_id: envelope.project_id || null,
          source_channel: 'brain',
          source_meta: { delegation_ref: envelope.source_meta.delegation_ref },
          created_at: now(),
          updated_at: now(),
        });
        log('INFO', `Delegation result envelope created: ${resultOutputId}`);

        // Cross-agent write: complete the delegation T-envelope on the sender's side
        try {
          const delegRef = await firestoreRead('work', envelope.source_meta.delegation_ref);
          if (delegRef && delegRef.status === 'waiting') {
            await firestoreWrite('work', delegRef.id, {
              ...delegRef,
              status: 'complete',
              output: toStr(envelope.output).substring(0, 4000),
              completed_at: now(),
              updated_at: now(),
            });
            log('INFO', `Delegation ref ${delegRef.id} marked complete (cross-agent write)`);
          }
        } catch (e2) {
          log('WARN', `Failed to complete delegation ref ${envelope.source_meta.delegation_ref}: ${e2.message}`);
        }
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
    // Query all live statuses — active, queued, waiting, needs_input, blocked, awaiting_approval
    const statuses = ['active', 'queued', 'waiting', 'needs_input', 'blocked', 'awaiting_approval'];
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
      blockedTimeoutHours: CONTRACTS.dispatch?.blocked_timeout_hours || 6,
      waitingTimeoutHours: CONTRACTS.dispatch?.waiting_timeout_hours || 8,
      activeTimeoutHours: CONTRACTS.dispatch?.active_timeout_hours || 12,
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

// ---- Deterministic approval pre-check ----
// Matches approval/reject keywords and resolves pending approval gates
// without LLM classification. Returns a string (action taken) or null
// (not an approval — fall through to normal classify).
const APPROVE_PATTERN = /^(approve|approved|lgtm|go ahead|proceed|yes|ship it|better|land it)\b/i;
const REJECT_PATTERN = /^(reject|rejected|deny|denied|no(?:\s|$)|stop|needs?\s*changes?|worse|revert|not yet)\b/i;

async function handleApprovalResponse(intake) {
  const rawText = (intake.text || '').trim();

  // Extract the actual user message from composite text (strip context lines)
  const lines = rawText.split('\n');
  const currentMsgLine = lines.find(l => l.startsWith('User: ')) || lines[lines.length - 1];
  const userText = currentMsgLine.replace(/^User:\s*/, '').trim();
  const userTextLower = userText.toLowerCase();

  // Determine action from text
  let action = null;
  if (APPROVE_PATTERN.test(userTextLower)) action = 'approved';
  else if (REJECT_PATTERN.test(userTextLower)) action = 'rejected';

  if (!action) return null; // Not an approval message — fall through

  // Query for pending approvals
  let pendingApprovals;
  try {
    // Simple equality filter — no orderBy, no composite index required
    const allApprovals = await firestoreQuery('approvals', [
      { field: 'prime_id', op: 'EQUAL', value: { stringValue: PRIME_ID } },
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ], { noOrderBy: true });
    pendingApprovals = allApprovals;
  } catch (e) {
    log('DEBUG', `Approval pre-check query failed: ${e.message}`);
    return null; // Query failed — fall through to normal classify
  }

  if (!pendingApprovals || pendingApprovals.length === 0) {
    log('DEBUG', `Approval pre-check: "${userTextLower}" matched pattern but no pending approvals exist — falling through to classify`);
    return null; // No pending approvals — "yes" or "approve" is genuine new input
  }

  log('INFO', `Approval pre-check: "${userTextLower}" matches ${action}, ${pendingApprovals.length} pending approval(s)`);

  // Claim the intake so it's not reprocessed
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'claimed',
    claimed_at: now(),
  });

  // Determine the target approval
  let target = null;

  // Extract all numbers that appear after the approve/reject keyword
  const afterKeywordMatch = userText.match(/(?:approve|reject)\s+(.+)/i);
  let numbers = null;
  if (afterKeywordMatch) {
    numbers = afterKeywordMatch[1].match(/\b\d+\b/g);
  }
  // Check for "approve all"
  const approveAll = /^approve\s+all\b/i.test(userText);

  if (pendingApprovals.length === 1) {
    target = [pendingApprovals[0]];
  } else if (approveAll && action === 'approved') {
    target = pendingApprovals;
  } else if (numbers) {
    const matched = [];
    for (const numStr of numbers) {
      const idx = parseInt(numStr, 10) - 1;
      if (idx >= 0 && idx < pendingApprovals.length) {
        matched.push(pendingApprovals[idx]);
      }
    }
    if (matched.length > 0) {
      target = matched;
    }
  }

  // Multi-pending disambiguation: ask which one
  if (!target) {
    const listing = pendingApprovals.map((a, i) => {
      const title = a.title || a.description || a.envelopeId || 'Untitled';
      const processId = a.processId || '';
      return `${i + 1}. **${title}**${processId ? ` (${processId})` : ''}`;
    }).join('\n');

    const disambigText = `You have ${pendingApprovals.length} pending approvals:\n\n${listing}\n\nReply with the number (e.g. \`approve 1\`), a name, or \`approve all\`.`;

    // Send disambiguation reply via a standalone deliverable T envelope
    const replyId = generateId('w');
    await firestoreWrite('work', replyId, {
      id: replyId,
      type: 'T',
      parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'complete',
      intent: 'notification',
      title: 'Approval disambiguation',
      instruction: 'Approval disambiguation',
      output: disambigText,
      source_channel: intake.source,
      source_meta: intake.source_meta || {},
      created_at: now(), started_at: now(),
      completed_at: now(), updated_at: now(),
      children: [], accept_criteria: null,
      context_summary: null, context_forward: null,
      error: null, iteration: 0,
      delivery_status: 'pending',
      delivery_address: addressFromMeta(intake.source_meta, intake.source),
    });

    await firestoreWrite('intake', intake.id, {
      ...intake, status: 'resolved_approval',
      resolved_at: now(), resolution: 'disambiguation',
    });

    log('INFO', `Approval pre-check: ${pendingApprovals.length} pending — sent disambiguation reply`);
    return 'disambiguation';
  }

  // Flip each target approval doc
  const reason = action === 'rejected' && userText.length > 20 ? userText : undefined;
  for (const approval of target) {
    const approvalId = approval.id;
    try {
      const updateFields = {
        status: action,
        resolvedAt: now(),
        resolvedBy: `brain:intake:${intake.source}`,
        ...(reason ? { reason } : {}),
      };
      await firestoreWrite('approvals', approvalId, {
        ...approval,
        ...updateFields,
      });
      log('INFO', `Approval pre-check: flipped ${approvalId} to ${action} (envelope=${approval.envelopeId})`);
    } catch (e) {
      log('WARN', `Approval pre-check: failed to flip ${approvalId}: ${e.message}`);
    }
  }

  // Trigger the existing approval checker to pick up the flipped docs
  // and call resumeProcessPlan (approved) or fail the envelope (rejected).
  // Force immediate check by resetting the throttle counter.
  if (!_approvalChecker) _initApprovals();
  // The checker normally only runs every 5th call. We need it to run NOW.
  // Call it 5 times to guarantee it fires on the 5th.
  for (let i = 0; i < 5; i++) {
    await _approvalChecker.checkPending();
  }

  // Send confirmation reply
  const targetTitles = target.map(a => a.title || a.envelopeId).join(', ');
  const confirmText = action === 'approved'
    ? `✅ Approved: ${targetTitles}. Resuming work.`
    : `❌ Rejected: ${targetTitles}. ${reason || 'Work stopped at this gate.'}`;

  const confirmId = generateId('w');
  await firestoreWrite('work', confirmId, {
    id: confirmId,
    type: 'T',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'notification',
    title: `Approval ${action}`,
    instruction: `Approval ${action}`,
    output: confirmText,
    source_channel: intake.source,
    source_meta: intake.source_meta || {},
    created_at: now(), started_at: now(),
    completed_at: now(), updated_at: now(),
    children: [], accept_criteria: null,
    context_summary: null, context_forward: null,
    error: null, iteration: 0,
    delivery_status: 'pending',
    delivery_address: addressFromMeta(intake.source_meta, intake.source),
  });

  await firestoreWrite('intake', intake.id, {
    ...intake, status: 'resolved_approval',
    resolved_at: now(), resolution: action,
    approval_ids: target.map(a => a.id),
  });

  return action;
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

    // Dedup: check for existing non-terminal mission with same delegation_ref (proceed anyway per user directive)
    try {
      const existing = await firestoreQuery('work', [
        { field: 'source_meta.delegation_ref', op: 'EQUAL', value: { stringValue: delegationRef } },
      ]);
      const active = existing.filter(e => e.status !== 'complete' && e.status !== 'failed' && e.status !== 'cancelled');
      if (active.length > 0) {
        log('INFO', `Delegation dedup: active mission ${active[0].id} already exists for ref ${delegationRef}, proceeding per user directive (no skip)`);
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

      // Inject ack as first C→T under the mission so the delegator knows we picked it up
      await createCT(envelope, {
        checkpointTitle: 'Acknowledge receipt',
        taskTitle: 'Write acknowledgment',
        taskOutput: 'Delegation received and queued for processing.',
        taskIntent: 'ack',
        deliveryStatus: 'pending',
        deliveryAddress: addressFromMeta(intake.source_meta, intake.source),
        ctKey: `ack-${envelopeId}`,
      });

      // Queue the delegation mission (work queue discipline: don't process immediately)
      envelope.status = 'queued';
      await firestoreWrite('work', envelopeId, envelope);
      await writeHistory(envelopeId, 'pending', 'queued', 'brain', 'Queued delegation mission (work queue)');
      log('INFO', `Delegation mission ${envelopeId} queued for processing`);
      return;
    }
  }

  // ---- Deterministic approval pre-check (before LLM classify) ----
  // Detects "approve"/"reject" messages and routes them to the existing
  // approval machinery (approvals.mjs → resumeProcessPlan), bypassing
  // LLM classification entirely. This prevents approval messages from
  // being mis-classified as new_mission and spawning phantom work.
  const approvalResult = await handleApprovalResponse(intake);
  if (approvalResult) {
    log('INFO', `Approval pre-check handled intake ${intake.id} (${approvalResult})`);
    return; // Early return — never reaches LLM classify or new_mission
  }

  // ---- CP1: Assemble Conversation Context (B-32) ----
  let convoContext = null;
  if (intake.conversation_ctx && CONTRACTS.conversation?.enabled !== false) {
    try {
      convoContext = JSON.parse(intake.conversation_ctx);
      log('INFO', 'Using intake-provided conversation context');
    } catch (e) {
      log('WARN', `Failed to parse intake-provided conversation context: ${e.message}`);
    }
  }

  if (!convoContext && intake.source === 'dashboard' && CONTRACTS.conversation?.enabled !== false) {
    convoContext = await assembleConversation({
      projectId: GCP_PROJECT,
      primeId: PRIME_ID,
      getToken: getGceToken,
      config: CONTRACTS.conversation,
      log,
    });
  }

  // conversation-context.mjs emits roles 'admin' | 'prime' and pre-computes the
  // last prime turn — use it; never re-derive against role names that don't exist.
  const lastPrimeReply = convoContext ? (convoContext.last_prime_text || null) : null;

  // Phase 3: Active envelope scan (moved before ACK for mission-aware acknowledgments)
  const activeEnvelopes = await scanActiveEnvelopes();

  // (Quick ack moved to after classify — see below)

  // Phase 3+: Dual memory recall
  // First recall: ambient context from raw inbound text (helps classify)
  // B-15: Ambient (pre-classify) recall is deterministic-only (Layers A+B, no LLM)
  const ambientMemory = await recallMemory(intake.text, {
    tier: 'ambient',
    last_prime_reply: lastPrimeReply,
    cues: extractCues([intake.text, convoContext?.cue_text || ''].filter(Boolean).join(' ')),
  });

  // Construct whitelisted respond reads available information
  const respondReadsAvailable = [];
  if (CONTRACTS.dispatch?.respond_reads_enabled && CONTRACTS.dispatch?.respond_reads) {
    const whitelisted = CONTRACTS.dispatch.respond_reads;
    if (whitelisted.includes('fleet_status')) {
      respondReadsAvailable.push({ id: 'fleet_status', description: 'Query Firestore and return a formatted snapshot of live registered fleet members and their specialties. Use to answer who is currently active in the fleet.' });
    }
    if (whitelisted.includes('recent_work')) {
      respondReadsAvailable.push({ id: 'recent_work', description: 'Query Firestore for completed work envelopes assigned to this agent over the last 7 days. Use to answer what I have recently accomplished or worked on.' });
    }
  }

  // Call Cortex in classify mode (with ambient memory + recent missions for dedup)
  const recentMissionsForClassify = await scanRecentMissions(5);
  const decision = await callCortex('classify', {
    inbound: {
      text: intake.text,
      source: intake.source,
      source_meta: intake.source_meta || {},
    },
    conversation: convoContext ? convoContext.block : null,
    last_prime_reply: lastPrimeReply,
    memory: ambientMemory,
    active_envelopes: activeEnvelopes,
    recent_completed_missions: recentMissionsForClassify,
    respond_reads_available: respondReadsAvailable,
  });

  if (decision.error) {
    log('ERROR', `Classify failed for intake ${intake.id}: ${JSON.stringify(decision)}`);
    // Revert to pending for retry on next poll
    await firestoreWrite('intake', intake.id, { ...intake, status: 'pending', claimed_at: null });
    log('INFO', `Intake ${intake.id} reverted to pending for retry`);
    return;
  }

  log('INFO', `Classify result: ${decision.classification || decision.action}`);

  // Normalize classification
  let classification = decision.classification || 'new_mission';

  // Second recall: enriched with classify results (instruction, context_summary)
  // This gives processEnvelope much better memory context for the decide loop
  // B-15: Full 4-layer + temporal-memory recall runs post-classify ONLY for mission-bound classifications
  let memoryContext = ambientMemory;
  const isMissionBound = ['new_mission', 'attach', 'continue'].includes(classification);

  if (isMissionBound && (decision.instruction || decision.context_summary)) {
    const enrichedMemory = await recallMemory(intake.text, {
      instruction: decision.instruction,
      context_summary: decision.context_summary,
      cues: extractCues([intake.text, decision.instruction || '', convoContext?.cue_text || ''].filter(Boolean).join(' ')),
      conversation_hint: convoContext?.cue_text || null,
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

  // Phase 3: Handle attach classification (follow-up to existing work)
  if (classification === 'attach') {
    await handleAttach(intake, decision, memoryContext, pendingAckText, convoContext);
    return;
  }

  // Handle continue classification (resume a blocked mission)
  if (classification === 'continue') {
    await handleContinue(intake, decision, memoryContext, pendingAckText, convoContext);
    return;
  }

  // Handle cancel classification (explicitly abandon work)
  if (classification === 'cancel') {
    await handleCancel(intake, decision);
    return;
  }

  // Handle respond classification (conversational fast-path)
  if (classification === 'respond') {
    let finalResponse = toStr(decision.response || '').trim();
    const readsRequested = Array.isArray(decision.reads) ? decision.reads : [];

    try {
      if (CONTRACTS.dispatch?.respond_reads_enabled !== false && readsRequested.length > 0) {
        const whitelist = CONTRACTS.dispatch?.respond_reads || [];
        // Locked decision: exactly ONE read per respond. Execute the first
        // whitelisted entry; anything further is ignored with a WARN.
        const readId = readsRequested.find(r => whitelist.includes(r)) || null;
        if (readsRequested.length > 1) {
          log('WARN', `respond requested ${readsRequested.length} reads — executing at most one ('${readId || 'none'}')`);
        }

        if (!readId) {
          // Reads were requested but none is whitelisted. The draft was written
          // expecting grounding — never deliver it ungrounded (B-15).
          log('WARN', `respond reads ${JSON.stringify(readsRequested)} not whitelisted — demoting to new_mission`);
          finalResponse = '';
        } else {
          log('INFO', `Executing whitelisted respond-read: ${readId}`);
          const readFn = readId === 'fleet_status' ? executeFleetStatus : executeRecentWork;
          const readResult = toStr(await Promise.race([
            readFn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('respond read timed out (10s)')), 10000)),
          ])).substring(0, 4000);

          log('INFO', `respond read '${readId}': ${readResult.length} chars — composing`);
          const composeDecision = await callCortex('respond_compose', {
            inbound: { text: intake.text, source: intake.source, source_meta: intake.source_meta || {} },
            conversation: convoContext ? convoContext.block : null,
            memory: ambientMemory,
            tool_grounding: `[TOOL RESULT: ${readId}]\n${readResult}`,
            draft_response: finalResponse,
          });
          const composedText = toStr(composeDecision?.response || '').trim();
          if (composeDecision?.error || !composedText) {
            throw new Error(`respond_compose failed: ${JSON.stringify(composeDecision?.error || 'empty response')}`);
          }
          finalResponse = composedText;
          log('INFO', `respond_compose grounded reply: "${finalResponse.substring(0, 100)}"`);
        }
      }

      if (finalResponse && CONTRACTS.dispatch?.respond_enabled !== false) {
        await handleRespond(intake, decision, finalResponse, convoContext);
        return;
      }
      log('WARN', `respond ${finalResponse ? 'disabled by dispatch.respond_enabled' : 'without deliverable text'} — demoting to new_mission`);
      classification = 'new_mission';
    } catch (err) {
      log('WARN', `Respond-reads execution or synthesis failed: ${err.message} — demoting to new_mission`);
      classification = 'new_mission';
    }
  }

  const envelopeId = generateId('w');

  const envelope = {
    id: envelopeId,
    type: 'M',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'queued',
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
    source_text: sourceText || null, // Raw user message — preserved verbatim for child dispatches
    stakes: decision.stakes || 'routine', // B-29: epistemic stakes from classify
    job_to_be_done: decision.job_to_be_done || null, // B-30: the job behind the deliverable
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: memoryContext, // Phase 3: pass memory to processEnvelope
    conversation_context: convoContext ? convoContext.block : null,
    delivery_status: 'internal', // Not deliverable until synthesized
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=${envelope.type}, status=queued)`);

  // Write history entry
  await writeHistory(envelopeId, null, 'queued', 'brain', 'Created from intake ' + intake.id);

  // Inject ack as first C→T under the mission
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
    log('INFO', `Ack injected as C→T under ${envelopeId}`);
  }

  // Work queue discipline: do NOT call processEnvelope() here.
  // dequeueAndProcess() will pick it up when the active slot is empty.
  log('INFO', `Mission ${envelopeId} queued for processing (work queue discipline)`);
}

// ---- Attach handler: follow-up to existing work ----
async function handleAttach(intake, decision, memoryContext, pendingAckText = null, convoContext = null) {
  let targetId = decision.attach_to || decision.attach_to_mission || decision.continue_mission;
  log('INFO', `Attach: intake ${intake.id} → target ${targetId || 'NONE'}`);

  if (!targetId) {
    log('WARN', `Attach missing attach_to field, reverting to new_mission fallback`);
    return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
  }

  const targetEnv = await firestoreRead('work', targetId);
  if (!targetEnv) {
    log('WARN', `Attach target ${targetId} not found, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
  }

  if (targetEnv.status === 'needs_input') {
    // Re-queue the envelope with the human's response (work queue discipline)
    log('INFO', `Re-queuing needs_input envelope ${targetId} with human response`);
    targetEnv.status = 'queued';
    targetEnv.context_forward = intake.text;
    targetEnv.delivered_at = null;
    targetEnv.delivered_channel = null;
    targetEnv.updated_at = now();
    if (decision.project_id && decision.project_id !== DEFAULT_PROJECT_ID) {
      targetEnv.project_id = decision.project_id;
    }
    if (convoContext) {
      targetEnv.conversation_context = convoContext.block;
    }
    await firestoreWrite('work', targetId, targetEnv);
    await writeHistory(targetId, 'needs_input', 'queued', 'brain', `Re-queued with human response: ${toStr(intake.text).substring(0, 100)}`);
    return;
  }

  if (targetEnv.status === 'active' || targetEnv.status === 'waiting') {
    // Check if this is truly a status query or a new instruction to act on
    const isStatusQuery = /\b(?:status|progress|how.{0,10}going|where.{0,10}at|what.{0,10}happening|any.{0,10}update|how.{0,10}coming)\b/i.test(intake.text);
    if (isStatusQuery) {
      log('INFO', `Status query detected for ${targetId}: "${intake.text.substring(0, 60)}"`);
      // Status check — deliver current status
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
    // New instruction for active/waiting mission — create linked child task
    log('INFO', `New instruction for ${targetEnv.status} mission ${targetId}, creating child task`);
    return processIntakeAsNewTask(intake, decision, memoryContext, targetId, convoContext);
  }

  // For blocked envelopes, delegate to handleContinue (which knows how to reopen)
  if (targetEnv.status === 'blocked') {
    log('INFO', `Attach target ${targetId} is blocked — routing to handleContinue`);
    decision.continue_mission = targetId;
    return handleContinue(intake, decision, memoryContext, pendingAckText, convoContext);
  }

  // For failed missions, create a child task linked to the mission
  if (targetEnv.status === 'failed') {
    log('INFO', `Attach target ${targetId} is failed — creating linked follow-up task`);
    return processIntakeAsNewTask(intake, decision, memoryContext, targetId, convoContext);
  }

  // For complete or other statuses, treat as a new follow-up task
  log('INFO', `Attach target ${targetId} is ${targetEnv.status}, creating follow-up task`);
  log('WARN', `[TELEMETRY] classify_cascade: attach→complete_fallback→new_mission (${targetId})`);
  return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
}

// ---- Helper: create new task from intake when attach falls through ----
async function processIntakeAsNewTask(intake, decision, memoryContext, parentId = null, convoContext = null) {
  const envelopeId = generateId('w');
  const _titleInput = (decision.instruction && decision.instruction.length > 100)
    ? decision.instruction
    : stripChatFraming(intake.text) || decision.instruction || 'Untitled';

  const envelope = {
    id: envelopeId,
    type: parentId ? 'C' : 'M',
    parent_id: parentId || null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'queued',
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
    conversation_context: convoContext ? convoContext.block : null,
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=${envelope.type}, fallback from intake, status=queued)`);
  await writeHistory(envelopeId, null, 'queued', 'brain', 'Created from intake ' + intake.id);
}

// ---- Continue handler: resume a blocked mission ----
async function handleContinue(intake, decision, memoryContext, pendingAckText = null, convoContext = null) {
  let targetId = decision.continue_mission || decision.continue_envelope || decision.mission_id;
  log('INFO', `Continue: intake ${intake.id} → resuming blocked mission ${targetId || 'NONE'}`);

  if (!targetId) {
    log('WARN', `Continue missing continue_mission field, reverting to new_mission fallback`);
    log('WARN', `[TELEMETRY] classify_cascade: continue→missing_target→new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
  }

  const mission = await firestoreRead('work', targetId);
  if (!mission) {
    log('WARN', `Continue target ${targetId} not found, treating as new_mission`);
    log('WARN', `[TELEMETRY] classify_cascade: continue→not_found→new_mission (${targetId})`);
    return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
  }

  // Only M-type envelopes are valid continue targets — T/C notifications must not be re-queued
  if (mission.type !== 'M') {
    log('WARN', `Continue target ${targetId} is type=${mission.type} (not M) — skipping, treating as new_mission`);
    log('WARN', `[TELEMETRY] classify_cascade: continue→wrong_type_${mission.type}→new_mission (${targetId})`);
    return processIntakeAsNewTask(intake, decision, memoryContext, null, convoContext);
  }

  // Only reopen blocked or complete missions (not active — that's an attach/status check)
  if (!['blocked', 'complete'].includes(mission.status)) {
    // Active target — check for stale claim and resume instead of cascading
    const claimAge = mission.claimed_at ? (Date.now() - mission.claimed_at) : Infinity;
    if (claimAge > CLAIM_STALE_MS) {
      log('INFO', `Reclaiming stale active envelope ${targetId} (claim age: ${claimAge}ms)`);
      mission.claimed_by = AGENT_ID;
      mission.claimed_at = Date.now();
      mission.context_forward = toStr(intake.text);
      mission.updated_at = now();
      if (decision.project_id && decision.project_id !== DEFAULT_PROJECT_ID) {
        mission.project_id = decision.project_id;
      }
      // B-32: refresh the conversation on the resumed mission — the user's new
      // turn (often a needs_input answer) is exactly what the decide loop must see.
      if (convoContext) {
        mission.conversation_context = convoContext.block;
      }
      await firestoreWrite('work', targetId, mission);
      return processEnvelope(mission, memoryContext);
    }
    log('WARN', `[TELEMETRY] classify_cascade: continue→active_busy→attach (${targetId}, status=${mission.status})`);
    return handleAttach(intake, { ...decision, attach_to: targetId }, memoryContext, null, convoContext);
  }

  const prevStatus = mission.status;

  // Re-queue the mission (work queue discipline: don't process immediately)
  mission.status = 'queued';
  mission.context_forward = [
    mission.context_forward || '',
    `[UNBLOCKED] ${intake.text}`,
    `[REVISED INSTRUCTION] ${decision.instruction || intake.text}`,
  ].filter(Boolean).join('\n\n');
  mission.blocker = null;
  mission.blocker_type = null;
  mission.delivered_at = null;
  mission.delivered_channel = null;
  mission.delivery_status = 'internal'; // Reset — will become 'pending' when re-completed
  mission._swf_state = null; // Reset retry cap for new attempt
  mission.process_id = null; // Clear so Cortex can restart processes if needed
  mission.process_version = null;
  mission._follow_process_force_count = 0;
  mission.updated_at = now();
  if (decision.project_id && decision.project_id !== DEFAULT_PROJECT_ID) {
    mission.project_id = decision.project_id;
  }
  if (convoContext) {
    mission.conversation_context = convoContext.block;
  }

  await firestoreWrite('work', targetId, mission);
  await writeHistory(targetId, prevStatus, 'queued', 'brain',
    `Re-queued via continue: ${toStr(intake.text).substring(0, 100)}`);
  log('INFO', `Mission ${targetId} re-queued from ${prevStatus} → queued (work queue discipline)`);

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

  // Work queue discipline: do NOT call processEnvelope() here.
  // dequeueAndProcess() will pick it up when the active slot is empty.
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

  if (!['active', 'blocked', 'needs_input', 'waiting', 'pending', 'queued'].includes(target.status)) {
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
  const parentPath = `${FIRESTORE_BASE}`;
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
      if (child.parent_id === parentId && ['active', 'pending', 'waiting', 'needs_input', 'queued'].includes(child.status)) {
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

// ---- Whitelisted respond reads (CP3) ----
// In-process, read-only, deterministic. No shell, no skills, no motor.
async function executeFleetStatus() {
  try {
    const agents = await firestoreQuery('fleet', []);
    const live = (agents || []).filter(a => !['removed', 'deleted', 'decommissioned'].includes(a.status));
    if (live.length === 0) return 'No fleet agents registered.';
    const lines = ['=== Fleet Status Snapshot ==='];
    for (const a of live) {
      lines.push(`- ${a.name || a.id}: status=${a.status || 'unknown'}${a.specialty ? ` specialty=${a.specialty}` : ''}${a.email ? ` email=${a.email}` : ''}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `Error retrieving fleet status: ${e.message}`;
  }
}

async function executeRecentWork() {
  try {
    const digest = await recentWorkDigest({
      firestoreQuery,
      owner: AGENT_EMAIL || AGENT_ID,
      sinceDays: 7,
      limit: 50,
    });
    return digest || 'No completed work in the last 7 days.';
  } catch (e) {
    return `Error retrieving recent work: ${e.message}`;
  }
}

// ---- Respond handler: fast-path conversational turns ----
async function handleRespond(intake, decision, responseText, convoContext) {
  const envelopeId = generateId('w');

  // Canonical address: routes the reply to the originating channel/thread.
  // (addressFromMeta handles dashboard, gchat space/thread, and legacy metas.)
  const deliveryAddress = addressFromMeta(intake.source_meta, intake.source);

  // Deterministic title — respond stays at one model call (classify).
  const missionTitle = `Chat reply: ${stripChatFraming(intake.text || '').substring(0, 60)}`;

  const envelope = {
    id: envelopeId,
    type: 'M',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'respond',
    title: missionTitle,
    instruction: decision.instruction || intake.text,
    accept_criteria: null,
    context_summary: null,
    output: responseText,
    children: [],
    context_forward: null,
    error: null,
    source_channel: intake.source,
    source_meta: intake.source_meta || {},
    project_id: DEFAULT_PROJECT_ID,
    context: null,
    source_text: intake.text || null,
    stakes: 'routine',
    job_to_be_done: 'respond',
    created_at: now(),
    started_at: now(),
    completed_at: now(),
    updated_at: now(),
    iteration: 1,
    memory_context: null, // Omit ambient from DB to save space on turns
    conversation_context: convoContext?.block || null,
    delivery_status: 'pending',
    delivery_address: deliveryAddress,
  };

  await firestoreWrite('work', envelopeId, envelope);
  await writeHistory(envelopeId, null, 'complete', 'brain', 'Created complete-on-creation respond envelope (fast-path)');
  log('INFO', `Created complete-on-creation respond envelope: ${envelopeId} with response: "${responseText.substring(0, 80)}..."`);

  // Write to working memory so conversational texture is retained
  try { await writeMemory(envelope); } catch (e) {
    log('WARN', `Memory write failed for respond envelope: ${e.message}`);
  }

  // Update intake status so it doesn't get processed again
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'consumed',
    consumed_by: envelopeId,
    consumed_at: now(),
  });
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
  const _tokenUsage = { totalInput: 0, totalOutput: 0, totalCached: 0, totalCacheWrites: 0, callCount: 0 };

  const dispatchAgent = async (agentId, payload) => {
    const res = await callAgent(agentId, payload);
    if (res?.usage) {
      const u = res.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.totalCacheWrites += (u.cacheCreationTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=${agentId} model=${REGISTRY.agents?.[agentId]?.route || agentId} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${res.durationMs || 0}ms`);
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
    publishArtifacts,
    gitCommitAndSync,
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
  // Wait, let's just make sure this is accurate
  envelope.context_forward = `[CHECKPOINT PLAN RESULTS (resumed after crash)]\n${
    allResults.map(r => 
        `${r.step || r.checkpoint_step || '?'} (${r.agent || '?'}): ${r.success ? 'OK' : 'FAIL'} — ${toStr(r.result).substring(0, 200)}`
    ).join('\n')
  }`;
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
        const childSummary = `[CHILD RESULT] ${envelope.id} (${envelope.status}): ${smartTruncate(toStr(envelope.output), RESULT_PREVIEW_CHARS)}`;
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

  // Phase 5: Initialize shared workspace for this envelope (+ git clone if project)
  await initSharedWorkspace(envelope.id, { projectId: envelope.project_id });

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
  await writeHistory(envelope.id, 'queued', 'active', 'brain', 'Processing started');

  // Cortex loop. SESSION_CONTEXT_PLAN Phase 3: iteration numbering is
  // mission-lifetime (resumes from the persisted counter) so '--- Iteration N ---'
  // markers stay unique across daemon restarts and compaction bookkeeping
  // stays unambiguous. Suspensions never consumed iterations (B-27) — resumed
  // counts reflect real work.
  let priorResults = [];
  let iteration = envelope.iteration || 0;
  let _lastPromptTokens = 0; // real prompt size of the newest decide call (Phase 0 telemetry)

  // Phase 4.3: LLM cost telemetry — per-mission token accumulator
  const _tokenUsage = { totalInput: 0, totalOutput: 0, totalCached: 0, totalCacheWrites: 0, callCount: 0 };

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

  // SESSION_CONTEXT_PLAN Phase 0: action handlers (synthesize's cerebellum
  // verification chain, probes) previously dispatched through raw callAgent,
  // bypassing the mission token accumulator — wrap it like every other path.
  const trackedDispatchAgent = async (agentId, payload) => {
    const res = await callAgent(agentId, payload);
    if (res?.usage) {
      const u = res.usage;
      _tokenUsage.totalInput += (u.promptTokenCount || u.input_tokens || 0);
      _tokenUsage.totalOutput += (u.candidatesTokenCount || u.output_tokens || 0);
      _tokenUsage.totalCached += (u.cachedContentTokenCount || 0);
      _tokenUsage.totalCacheWrites += (u.cacheCreationTokenCount || 0);
      _tokenUsage.callCount++;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=${agentId} model=${REGISTRY.agents?.[agentId]?.route || agentId} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${res.durationMs || 0}ms`);
    }
    return res;
  };

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
    summarizeViaVertex,
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
    handleWait,
    dispatchAgent: trackedDispatchAgent,
    extractVerdict: (await import('../lib/verdict.mjs')).extractVerdict,
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
    wait: handleWait,
  };

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    envelope.iteration = iteration;

    // Phase 3.3 / SESSION_CONTEXT_PLAN Phase 0b: priorResults budget — prevent
    // unbounded growth. Previously this check sat after the action-dispatch
    // `continue`, making it unreachable on every handled action; it now runs
    // at the top of every iteration, before the decide payload is built.
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

    // SESSION_CONTEXT_PLAN Phase 3: rolling compaction — at the token
    // threshold, fold the middle iterations into a validated digest and
    // tell the model it rolled (the roll notice below).
    try {
      const compactSeq = await compactMissionContext(envelope, { lastPromptTokens: _lastPromptTokens });
      if (compactSeq > 0) {
        priorResults.push({
          agent: 'system',
          success: true,
          result: `[SYSTEM] Context compacted (seq ${compactSeq}): older iterations are summarized in the [CONTEXT COMPACTED] block above. Digest claims carry epistemic bins — treat 'assumed' as unverified. Full task outputs remain recoverable from the mission work tree.`,
        });
      }
    } catch (e) {
      log('WARN', `compaction check failed (non-fatal): ${e.message}`);
    }

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
        conversation_context: envelope.conversation_context || null,
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
      _tokenUsage.totalCacheWrites += (u.cacheCreationTokenCount || 0);
      _tokenUsage.callCount++;
      // Phase 3: the newest decide call's full prompt size is the compaction signal
      _lastPromptTokens = u.last_step_input_tokens || u.promptTokenCount || _lastPromptTokens;
      log('INFO', `[TELEMETRY] llm_usage mission=${envelope.id} organ=cortex model=${CORTEX_ROUTE} input=${u.promptTokenCount || u.input_tokens || 0} output=${u.candidatesTokenCount || u.output_tokens || 0} cached=${u.cachedContentTokenCount || 0} cache_write=${u.cacheCreationTokenCount || 0} duration=${decision.durationMs || 0}ms`);
    }

    // B-29: Stash decision for mission record epistemic state
    if (decision && !decision.error) {
      envelope._lastDecision = decision;
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
      await completeEnvelope(envelope, {
        status: 'failed',
        output: `Cortex error: ${JSON.stringify(decision)}`,
        historyDetail: `Cortex parse failure: ${JSON.stringify(decision).substring(0, 200)}`,
        skipArtifacts: true,
        skipMemory: true,
      });
      log('ERROR', `Envelope ${envelope.id} failed: Cortex error`);
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
        const fallback = _activeGuard.fallback;
        // CP2: Before forcing a terminal synthesis, give cortex exactly one
        // dedicated turn to author the final answer if its current decision
        // carries no summary — otherwise the forced synthesize runs on a stale
        // plan decision and closes empty (B-1: the model owns the judgment; the
        // daemon owns the loop). The CP1 deliverable floor is the safety net if
        // it still returns empty after this grace turn.
        const forcingSynthesis = fallback === 'synthesize' || fallback === 'synthesize_with_failure';
        const hasSummary = !!(decision.synthesis || decision.summary || decision.answer || decision.content || decision.message);
        if (forcingSynthesis && !hasSummary && !envelope._synth_grace_used) {
          envelope._synth_grace_used = true;
          log('WARN', `Guard: cortex chose forbidden '${action}' with no summary — granting one synthesis turn before forcing '${fallback}'`);
          priorResults.push({
            agent: 'system',
            result: `[SYSTEM] Finish now: return action "${fallback}" with a written outcome summary for the requester in the "synthesis" field — what was accomplished, or why it could not be. Do NOT plan more work.`,
          });
          _activeGuard = { ..._activeGuard, injectedAt: iteration }; // re-arm: force next turn if still no synthesis
          continue;
        }
        log('WARN', `Guard override: cortex chose forbidden '${action}', forcing '${fallback}'`);
        action = fallback;
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

      if (actionResult?.exit) {
        // SESSION_CONTEXT_PLAN Phase 3: compact-on-suspend — a mission pausing
        // above half its working budget resumes from a digest instead of
        // re-sending the whole accumulated string after a possibly days-long
        // pause. The envelope is already persisted in its suspended state;
        // the field-masked splice touches only the context fields.
        if (['waiting', 'needs_input', 'blocked', 'awaiting_approval'].includes(envelope.status)) {
          try {
            await compactMissionContext(envelope, { lastPromptTokens: _lastPromptTokens, trigger: 'suspend', triggerPctOverride: 0.5 });
          } catch (e) {
            log('WARN', `compact-on-suspend failed (non-fatal): ${e.message}`);
          }
        }
        return;
      }
      if (actionResult?.activeGuard) _activeGuard = actionResult.activeGuard;
      if (actionResult?.priorResultsAppend) priorResults.push(...actionResult.priorResultsAppend);
      continue;
    }

    // Unknown action — nudge Cortex. Table-dispatched actions (synthesize, blocked, needs_input, status_update)
    // are handled above by ACTION_HANDLERS and never reach here.
    log('WARN', `Unknown action '${action}' — nudging Cortex`);
    priorResults.push({
      agent: 'system',
      result: `[SYSTEM] Invalid action "${action}". Valid actions: checkpoint_plan, delegate, synthesize, synthesize_with_failure, needs_input, blocked, follow_process, status_update, wait.`,
    });
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

// SESSION_CONTEXT_PLAN Phase 3: token-triggered rolling compaction — the
// canon-native "roll to a new session at N%". Everything here is daemon code
// (C-4): the trigger is arithmetic, the splice is deterministic, criteria are
// copied verbatim (B-25), and only the digest prose comes from the stateless
// utility path (C-6) with its shape hard-validated (B-29 bins mandatory).
// Crash-safety: seq is monotonic from the Firestore-persisted _compaction;
// a replayed transaction recomputes against the already-compacted context
// and simply declines (below_threshold). Returns the new seq, or 0.
async function compactMissionContext(envelope, { lastPromptTokens = 0, trigger = 'tokens', triggerPctOverride = null } = {}) {
  const cfg = { ...(CONTRACTS.compaction || {}) };
  if (triggerPctOverride) cfg.trigger_pct = triggerPctOverride;
  const acc = envelope._accumulated_context || '';
  const check = shouldCompact({
    lastRealPromptTokens: lastPromptTokens,
    accumulatedChars: acc.length,
    compactionsSoFar: envelope._compaction?.seq || 0,
    cfg,
  });
  if (!check.compact) return 0;

  const keepRecent = cfg.keep_recent_iterations || 5;
  const { head, blocks } = splitIterationBlocks(acc);
  if (blocks.length <= keepRecent + 2) return 0; // too little middle to fold

  const seq = (envelope._compaction?.seq || 0) + 1;
  const kept = blocks.slice(-keepRecent);
  const middle = blocks.slice(0, blocks.length - keepRecent);
  const windowText = middle.join('\n\n');

  // Optional durable raw-window log (contracts-gated, DEFAULT FALSE — C-8
  // names transcripts a leak surface and the shared ether is permanent).
  // Durability-before-destruction: the splice aborts if the commit fails.
  let sessionLogPath = '';
  if (cfg.session_log_to_git === true) {
    try {
      const dir = `${CORE_DIR}/shared/${envelope.id}/missions`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/session-log-${seq}.md`, redactSecrets(windowText));
      const sync = await gitCommitAndSync(envelope.id, envelope.project_id, `session-log ${seq} for ${envelope.id}`);
      if (!sync?.committed) throw new Error('git commit did not land');
      sessionLogPath = `shared/${envelope.id}/missions/session-log-${seq}.md`;
    } catch (e) {
      log('WARN', `compaction: session-log persist failed (${e.message}) — splice aborted this round`);
      return 0;
    }
  }

  // Two-step digest: stateless utility generation, then hard shape validation.
  // The utility path's wrap-as-synthesize repair fallback can never pass
  // validateMissionDigest, so garbage is never spliced into mission context.
  let digest = null;
  for (let attempt = 1; attempt <= 2 && !digest; attempt++) {
    const rawText = await _vtx.transform(
      windowText.substring(0, 120_000),
      missionDigestInstruction(),
      { maxTokens: 4096, temperature: 0.1, timeoutMs: 60_000 },
    );
    if (!rawText) continue;
    try {
      const parsed = parseJsonResponse(rawText);
      const shape = validateMissionDigest(parsed);
      if (shape.valid) digest = parsed;
      else log('WARN', `compaction digest invalid (attempt ${attempt}): ${shape.reason}`);
    } catch (e) {
      log('WARN', `compaction digest parse failed (attempt ${attempt}): ${e.message}`);
    }
  }
  if (!digest) {
    log('WARN', `[TELEMETRY] compaction_fallback mission=${envelope.id} seq=${seq} trigger=${trigger} — digest failed; deterministic prune remains the bound`);
    return 0;
  }

  envelope._accumulated_context = spliceCompacted({
    head,
    keptBlocks: kept,
    digest,
    seq,
    instruction: envelope.instruction,
    acceptCriteria: envelope.accept_criteria,
    coveredLabel: digest.covered_iterations || '',
    sessionLogPath,
    capChars: cfg.digest_max_chars || 6000,
  });
  envelope._compaction = {
    seq,
    at_iteration: envelope.iteration || 0,
    covered: digest.covered_iterations || '',
    dropped_chars: windowText.length,
    session_log: sessionLogPath || null,
    trigger,
    at: now(),
    durable_learnings: (digest.durable_learnings || []).slice(0, 5),
  };
  // Field-masked write: concurrent whole-doc writers (child propagation,
  // waiting sweeps) can neither clobber nor be clobbered by the splice.
  await firestoreWriteFields('work', envelope.id, {
    _accumulated_context: envelope._accumulated_context,
    _compaction: envelope._compaction,
    updated_at: now(),
  });
  await writeHistory(envelope.id, 'active', 'active', 'brain',
    `Context compacted (seq ${seq}): iterations ${digest.covered_iterations || '?'} folded (${windowText.length} chars → digest)`,
    `compact-${envelope.id}-${seq}`);
  log('INFO', `[TELEMETRY] compaction mission=${envelope.id} seq=${seq} trigger=${trigger} dropped_chars=${windowText.length} kept_blocks=${kept.length} chars_after=${envelope._accumulated_context.length}`);
  return seq;
}

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
      blockParts.push(`Human input: ${smartTruncate(toStr(latest.result), CONTEXT_SLICE_CHARS)}`);
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
      // Keep first 10% (mission framing) + last 50% (recent work), drop the
      // true middle. SESSION_CONTEXT_PLAN Phase 0b: the previous 10%/90%
      // split summed to >= N-1 blocks — the prune was a no-op.
      const keepFirst = Math.max(1, Math.floor(blocks.length * 0.1));
      const keepLast = Math.max(1, Math.floor(blocks.length * 0.5));
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

async function initSharedWorkspace(envelopeId, opts = {}) {
  if (!_artifacts) _initArtifacts();
  await _artifacts.initWorkspace(envelopeId, opts);
}

async function gitCommitAndSync(envelopeId, projectId, message) {
  if (!_artifacts) _initArtifacts();
  return _artifacts.commitAndSync(envelopeId, projectId, message);
}

async function cleanupSharedWorkspace(envelopeId) {
  if (!_artifacts) _initArtifacts();
  await _artifacts.cleanupWorkspace(envelopeId);
}

async function publishArtifacts(envelope) {
  if (!_artifacts) _initArtifacts();
  return _artifacts.publish(envelope);
}

// ---- History (via history.mjs, Phase 3 extraction) ----
let _history = null;

function _initHistory() {
  _history = createHistoryWriter({
    firestoreWrite,
    logger: log,
  });
}

async function writeHistory(envelopeId, prevStatus, newStatus, agent, detail, logicalKey) {
  if (!_history) _initHistory();
  await _history.write(envelopeId, prevStatus, newStatus, agent, detail, logicalKey);
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
      if (waiting.status === 'waiting' && waiting.intent === 'delegation') {
        const ageMs = Date.now() - new Date(waiting.started_at).getTime();
        const timeoutMs = (CONTRACTS.dispatch?.delegation_timeout_hours || 4) * 3600_000;
        if (ageMs > timeoutMs) {
          log('WARN', `Delegation timeout: ${waiting.id} waiting for ${Math.round(ageMs / 3600_000)}h`);
          waiting.status = 'failed';
          waiting.error = `Delegation timed out after ${Math.round(ageMs / 3600_000)} hours. Delegate may be offline or stuck.`;
          waiting.completed_at = now();
          await firestoreWrite('work', waiting.id, waiting);
          await writeHistory(waiting.id, 'waiting', 'failed', 'brain', 'Delegation timeout');

          // Escalate: fail the parent M-type mission with a user-facing notification
          if (waiting.parent_id) {
            try {
              const parent = await firestoreRead('work', waiting.parent_id);
              if (parent && (parent.status === 'waiting' || parent.status === 'active')) {
                const delegateEmail = waiting.source_meta?.delegated_to || waiting.source_meta?.target_agent_email || 'the delegate';
                const agentName = typeof delegateEmail === 'string' ? delegateEmail.split('@')[0].replace(/-/g, ' ') : 'the delegate';
                parent.status = 'failed';
                parent.error = waiting.error;
                parent.completed_at = now();
                parent.updated_at = now();
                // Top-level M envelopes get delivery so user sees the timeout
                if (!parent.parent_id) {
                  parent.delivery_status = 'pending';
                  parent.delivery_address = addressFromMeta(parent.source_meta, parent.source_channel);
                  parent.output = `I delegated this task to ${agentName}, but they didn't respond within ${Math.round(ageMs / 3600_000)} hours. The delegation timed out — you may want to try again or reach out directly.`;
                }
                await firestoreWrite('work', parent.id, parent);
                await writeHistory(parent.id, parent.status === 'waiting' ? 'waiting' : 'active', 'failed', 'brain', `Delegation to ${delegateEmail} timed out`);
                log('INFO', `Parent mission ${parent.id} failed due to delegation timeout`);
              }
            } catch (e) {
              log('WARN', `Failed to escalate delegation timeout to parent ${waiting.parent_id}: ${e.message}`);
            }
          }
          continue;
        }
      }

      // ---- Phase A.2: Temporal wait resumption ----
      if (waiting.status === 'waiting' && waiting.wait_resume_at) {
        if (new Date() >= new Date(waiting.wait_resume_at)) {
          log('INFO', `Wait expired: re-queuing mission ${waiting.id}`);
          waiting.status = 'queued';
          waiting.context_forward = `[RESUMED AFTER WAIT]\n${waiting.resume_instruction || 'Continue mission'}`;
          waiting.wait_resume_at = null;
          waiting.resume_instruction = null;
          waiting.updated_at = now();
          await firestoreWrite('work', waiting.id, waiting);
          await writeHistory(waiting.id, 'waiting', 'queued', 'brain', 'Wait duration expired, re-queued');
          continue;
        }
        continue; // Still waiting
      }

      // Check if any delegated children have completed or failed
      const children = waiting.children || [];
      if (children.length === 0) continue;

      let allChildrenDone = true;
      let childResults = [];

      for (const childId of children) {
        const child = await firestoreRead('work', childId);

        // Null child = deleted from Firestore (treat as failed)
        if (!child) {
          childResults.push({ agent: 'unknown', task: childId, result: '[FAILED] Envelope deleted from Firestore', success: false });
          continue;
        }

        // Terminal states: complete, failed, archived, cancelled, blocked, needs_input
        if (child.status === 'complete' || child.status === 'failed' || child.status === 'archived' || child.status === 'cancelled' || child.status === 'blocked' || child.status === 'needs_input') {
          const isSuccess = child.status === 'complete' || child.status === 'archived';
          childResults.push({
            agent: child.owner,
            task: toStr(child.instruction).substring(0, 200),
            result: isSuccess
              ? toStr(child.output).substring(0, 4000)
              : `[FAILED] ${child.error || child.status}`,
            success: isSuccess,
          });
        } else {
          allChildrenDone = false;
        }
      }

      if (!allChildrenDone || childResults.length === 0) continue;

      // All delegated children are done — re-queue the waiting envelope
      log('INFO', `Re-queuing waiting envelope ${waiting.id}: ${childResults.length} delegation(s) complete`);

      // Inject delegation results as context_forward
      const delegationSummary = childResults.map((r, i) =>
        `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result), RESULT_PREVIEW_CHARS)}`
      ).join('\n\n');

      // C-type checkpoint: complete it and re-queue the parent M-type mission
      // (dequeueAndProcess only handles M-type, so a queued C-type is a dead end)
      if (waiting.type === 'C' && waiting.parent_id) {
        waiting.status = 'complete';
        waiting.output = delegationSummary;
        waiting.updated_at = now();
        await firestoreWrite('work', waiting.id, waiting);
        await writeHistory(waiting.id, 'waiting', 'complete', 'brain',
          `C-type delegation(s) complete, marking checkpoint done`);

        const parent = await firestoreRead('work', waiting.parent_id);
        if (parent && parent.status === 'active') {
          parent.status = 'queued';
          parent.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
          parent.updated_at = now();
          await firestoreWrite('work', parent.id, parent);
          await writeHistory(parent.id, 'active', 'queued', 'brain',
            `Checkpoint delegation(s) complete, re-queued (work queue)`);
          log('INFO', `Re-queuing parent mission ${parent.id} after C-type checkpoint delegation`);
        }
        continue;
      }

      // T-type delegation task under a C checkpoint: mark complete so the parent
      // C can detect all children are terminal. Re-queuing to 'queued' would be a
      // dead end since dequeueAndProcess only handles M-type envelopes.
      if (waiting.type === 'T' && waiting.parent_id && waiting.intent === 'delegation') {
        waiting.status = 'complete';
        waiting.output = delegationSummary;
        waiting.completed_at = now();
        waiting.updated_at = now();
        await firestoreWrite('work', waiting.id, waiting);
        await writeHistory(waiting.id, 'waiting', 'complete', 'brain',
          `T-type delegation complete, marking done for parent checkpoint`);
        log('INFO', `Marking delegation task ${waiting.id} complete (parent checkpoint ${waiting.parent_id})`);
        continue;
      }

      waiting.status = 'queued';
      waiting.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
      waiting.updated_at = now();
      await firestoreWrite('work', waiting.id, waiting);
      await writeHistory(waiting.id, 'waiting', 'queued', 'brain', `Delegation(s) complete, re-queued (work queue)`);
    }
    // ---- Phase B: Active M envelopes with waiting C children (delegation via checkpoint_plan) ----
    // These are missions where checkpoint-executor created delegation tasks inside checkpoints.
    // The M envelope stays 'active' but the C child is 'waiting' for delegation results.
    if (waitingCheckCount % 9 === 0) {  // Less frequent: every ~27s
      const activeEnvelopes = await firestoreQuery('work', [
        { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
        { field: 'type', op: 'EQUAL', value: { stringValue: 'M' } },
        { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
      ]);

      for (const active of activeEnvelopes) {
        const children = active.children || [];
        if (children.length === 0) continue;

        for (const childId of children) {
          const child = await firestoreRead('work', childId);
          if (!child || child.type !== 'C' || child.status !== 'waiting') continue;

          const cpChildren = child.children || [];
          if (cpChildren.length === 0) continue;

          let allDone = true;
          let cpResults = [];
          for (const tcId of cpChildren) {
            const tc = await firestoreRead('work', tcId);
            if (!tc) {
              cpResults.push({ agent: 'unknown', task: tcId, result: '[FAILED] Envelope deleted', success: false });
              continue;
            }
            if (tc.status === 'complete' || tc.status === 'failed' || tc.status === 'archived' || tc.status === 'cancelled' || tc.status === 'blocked') {
              const isSuccess = tc.status === 'complete' || tc.status === 'archived';
              cpResults.push({
                agent: tc.owner,
                task: toStr(tc.instruction).substring(0, 200),
                result: isSuccess ? toStr(tc.output).substring(0, 4000) : `[FAILED] ${tc.error || tc.status}`,
                success: isSuccess,
              });
            } else {
              allDone = false;
            }
          }

          if (!allDone || cpResults.length === 0) continue;

          log('INFO', `Re-queuing active mission ${active.id}: checkpoint ${childId} delegations complete (${cpResults.length} results)`);

          const delegationSummary = cpResults.map((r, i) =>
            `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result), RESULT_PREVIEW_CHARS)}`
          ).join('\n\n');

          child.status = 'complete';
          child.output = delegationSummary;
          child.updated_at = now();
          await firestoreWrite('work', childId, child);

          active.status = 'queued';
          active.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
          active.updated_at = now();
          await firestoreWrite('work', active.id, active);
          await writeHistory(active.id, 'active', 'queued', 'brain', `Checkpoint delegation(s) complete, re-queued (work queue)`);
          break;
        }
      }
    }
  } catch (e) {
    log('WARN', `Waiting envelope check error: ${e.message}`);
  }
}

// ---- Work Queue: Dequeue-and-Process ----
// Promotes exactly one 'queued' M-type mission to 'active' and processes it.
// Called every poll tick; short-circuits if the active slot is occupied.
async function dequeueAndProcess() {
  // If there's already an active mission, verify it's still active in Firestore
  if (activeMissionId) {
    const env = await firestoreRead('work', activeMissionId);
    if (env && env.status === 'active') return; // Slot occupied — skip
    log('INFO', `Active slot cleared: ${activeMissionId} → ${env?.status || 'deleted'}`);
    activeMissionId = null;
  }

  // Query for next queued mission — single-field query to avoid composite index requirement.
  // Owner and type filters applied client-side.
  try {
    const agentOwner = AGENT_EMAIL || AGENT_ID;
    const allQueued = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'queued' } },
    ], { noOrderBy: true });
    const queued = allQueued.filter(e => e.type === 'M' && (e.owner || '').includes(agentOwner.split('@')[0]));
    if (queued.length === 0) return;

    // Sort: missions with context_forward (resumed/unblocked) first, then by created_at FIFO
    queued.sort((a, b) => {
      const aPriority = a.context_forward ? 0 : 1;
      const bPriority = b.context_forward ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return (a.created_at || '').localeCompare(b.created_at || '');
    });

    const next = queued[0];
    activeMissionId = next.id;
    log('INFO', `[WORK QUEUE] Dequeuing mission ${next.id}: "${(next.title || next.instruction || '').substring(0, 60)}" (${queued.length} total queued)`);

    try {
      const memory = await recallMemory(next.instruction);
      await processEnvelope(next, memory);
    } catch (e) {
      log('ERROR', `Failed to process dequeued mission ${next.id}: ${e.message}`);
    }

    // After processEnvelope returns, check if mission is still active
    const final = await firestoreRead('work', next.id);
    if (!final || final.status !== 'active') {
      activeMissionId = null; // Slot freed — next tick will dequeue another
    }
  } catch (e) {
    log('WARN', `Dequeue error: ${e.message}`);
    activeMissionId = null; // Reset on error
  }
}

// ---- Main ----
async function main() {
  log('INFO', '=== Brain v3 starting ===');
  log('INFO', `Agent: ${AGENT_ID} | Project: ${GCP_PROJECT} | Prime: ${PRIME_ID}`);
  log('INFO', `Gateway: ${GATEWAY_URL} | Cortex route: ${CORTEX_ROUTE}`);
  log('INFO', `Brain summarizer: ${BRAIN_MODEL} (direct Vertex, bypasses gateway)`);
  log('INFO', `Registry agents: ${Object.keys(REGISTRY.agents).join(', ') || 'none loaded'}`);

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
      const parentPath = `${FIRESTORE_BASE}`;
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

      // Cancel stale blocked envelopes owned by this agent on restart (keep 'waiting' for active delegations)
      const staleBlocked = allDocs.filter(e =>
        (e.owner || '').includes(agentId) &&
        (e.status === 'blocked')
      );
      if (staleBlocked.length > 0) {
        log('INFO', `Startup recovery: cancelling ${staleBlocked.length} stale blocked envelope(s)`);
        for (const env of staleBlocked) {
          await firestoreWrite('work', env.id, {
            ...env,
            status: 'cancelled',
            cancelled_at: now(),
            cancelled_reason: `startup_recovery_${env.status}`,
            updated_at: now(),
            completed_at: now(),
          });
          await writeHistory(env.id, env.status, 'cancelled', 'brain', `Cancelled stale ${env.status} envelope on restart`);
        }
      }

      const orphaned = allDocs.filter(e => (e.type === 'M' || (e.type === 'C' && e.parent_id && e.intent !== 'checkpoint')) &&
        (e.owner || '').includes(agentId) &&
        (e.status === 'active' || e.status === 'pending' || e.status === 'queued'));
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
                ...env, status: 'archived', archived_reason: 'child_complete',
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
                  await firestoreWrite('work', env.id, { ...env, status: 'active', updated_at: now() });
                }
              } else {
                // Work queue discipline: queue for processing, don't process immediately
                log('INFO', `Recovery: queuing mission ${env.id} — checkpoints active/pending or children terminal`);
                await firestoreWrite('work', env.id, { ...env, status: 'queued', updated_at: now() });
                await writeHistory(env.id, env.status, 'queued', 'brain', 'Queued after restart (work queue discipline)');
              }
            }
          } else {
            // Truly orphaned: no children, was created but processing never started
            log('INFO', `Recovering orphaned envelope: ${env.id} (status=${env.status}, title=${(env.title || '').substring(0, 60)})`);
            env.status = 'queued';
            env.iteration = 0;
            await firestoreWrite('work', env.id, { ...env, status: 'queued', iteration: 0, updated_at: now() });
            await writeHistory(env.id, 'active', 'queued', 'brain', 'Recovered after brain restart (work queue discipline)');
          }
        }
      }
    }
  } catch (e) {
    log('WARN', `Startup recovery sweep failed: ${e.message}`);
  }


  // Start intake polling — recursive setTimeout prevents concurrent ticks
  const POLL_MS = CONTRACTS.dispatch?.poll_interval_ms || 3000;
  log('INFO', `Starting intake poll (every ${POLL_MS}ms)`);
  async function pollLoop() {
    try {
      await pollIntake();
      await checkWaitingEnvelopes();
      await checkApprovedApprovals();
      await dequeueAndProcess();
    } catch (e) {
      log('ERROR', `Poll loop error: ${e.message}`);
    }
    setTimeout(pollLoop, POLL_MS);
  }
  setTimeout(pollLoop, POLL_MS);

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
