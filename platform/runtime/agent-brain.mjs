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
import { readFileSync, appendFileSync, existsSync, watchFile, readdirSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { hostname } from 'os';

// ---- Shared library imports (Phase 0 extraction) ----
import { getGceToken } from '../security/gce-auth.mjs';
import { createClient as createFirestoreClient, firestoreEncode, firestoreDecode } from '../persistence/firestore.mjs';
import { parseJsonResponse } from '../providers/json-repair.mjs';
import { createVertexText, CORTEX_SCHEMAS, smartTruncate } from '../providers/vertex-text.mjs';
import { createProjectRegistry } from '../control-plane/projects.mjs';
import { createProcessRegistry } from '../work/process-registry.mjs';
import { createScheduler } from '../work/scheduler.mjs';
import { createApprovalChecker, scopeApprovalsToAgent } from '../work/approvals.mjs';
import { createArchivalSweeper } from '../persistence/archival.mjs';
import { createArtifactManager } from '../persistence/artifacts.mjs';
import { createNotifier } from '../providers/notifications.mjs';
import { createHistoryWriter } from '../context/history.mjs';
import { composeDelegationMarker, composeDelegationResultMarker, summarizeDelegationResult, delegationResultAgent, bumpRedelegation, redelegationKey, composeRedelegationEscalation } from '../work/delegation.mjs';
import { makeAddress } from '../providers/channel.mjs';
import { extractVerdict, extractFailSummary, extractFailRecommendation } from '../work/verdict.mjs';
import { composeDeliverable } from '../work/deliverable.mjs';
import { executeCheckpoints } from '../work/checkpoint-executor.mjs';
import { rebuildFromSpine } from '../work/checkpoint-spine.mjs';
import { shouldMaintainContext, buildMaintenancePrompt, parseMaintenanceResponse, shouldMaintainProcesses, buildProcessMaintenancePrompt } from '../context/context-maintenance.mjs';
import { handoffModelEnabled, decideHop, missionOriginator, effectiveAssignee } from '../work/baton.mjs';
import { projectBootstrapEnabled, missionOriginSpace } from '../control-plane/project-bootstrap.mjs';
import { renderBlackboard } from '../work/blackboard.mjs';
import { canTransition } from '../contracts/work-transitions.mjs';
import { assembleConversation } from '../context/conversation-context.mjs';
import { toStr } from '../providers/to-str.mjs';
import { extractCheckpoints } from '../work/plan-utils.mjs';
import { extractCues, searchWork, recentWorkDigest } from '../work/work-recall.mjs';
import { renderResources, resourceKey } from '../work/resource-ledger.mjs';
import { toContentParts } from '../context/prompt-blocks.mjs';
import { shouldCompact, splitIterationBlocks, redactSecrets, validateMissionDigest, missionDigestInstruction, spliceCompacted } from '../context/compaction.mjs';
import { threadKeyFor, appendTurn as ledgerAppendTurn, compactThread } from '../work/thread-ledger.mjs';
import {
  handleSynthesize,
  handleBlocked,
  handleNeedsInput,
  handleStatusUpdate,
  handleSynthesizeWithFailure,
  handleDelegate,
  handleCheckpointPlan,
  handleWait,
  handleTriggerResponsibility,
  handleProjectBootstrap
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
// Per-VM override for the delegation model — canary enablement WITHOUT a global contracts flip.
// `AGENT_DELEGATION_MODEL=handoff` on one agent's VM turns on the baton model for that agent only;
// it mutates the in-memory contracts so both the daemon and the executor (which receives
// `contracts`) observe it. Unset (default) leaves the committed model in place (child-mission).
if (process.env.AGENT_DELEGATION_MODEL) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.delegation = { ...(CONTRACTS.dispatch.delegation || {}), model: process.env.AGENT_DELEGATION_MODEL };
  console.log(`[brain] delegation model override from env: ${process.env.AGENT_DELEGATION_MODEL}`);
}
// Per-VM override for the project_bootstrap action — canary enablement WITHOUT a global flip.
// `AGENT_PROJECT_BOOTSTRAP=on` on a PM/lead agent's VM lets it stand up projects from a chat ask.
if (process.env.AGENT_PROJECT_BOOTSTRAP) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.project_bootstrap = { ...(CONTRACTS.dispatch.project_bootstrap || {}), enabled: process.env.AGENT_PROJECT_BOOTSTRAP === 'on' };
  console.log(`[brain] project_bootstrap override from env: ${process.env.AGENT_PROJECT_BOOTSTRAP}`);
}
// Per-VM overrides for the delivery-robustness guards (FC-A/FC-B) — canary WITHOUT a global flip.
// `AGENT_FINALIZE_SPINE_GUARD=on` forbids a false-complete while the deliverable checkpoint is unmet;
// `AGENT_REDELEG_CAP=on` bounds re-delegation of a repeatedly-failing checkpoint → operator escalation.
if (process.env.AGENT_FINALIZE_SPINE_GUARD) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.finalize_requires_spine_complete = process.env.AGENT_FINALIZE_SPINE_GUARD === 'on';
  console.log(`[brain] finalize_requires_spine_complete override from env: ${process.env.AGENT_FINALIZE_SPINE_GUARD}`);
}
if (process.env.AGENT_REDELEG_CAP) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.redelegation_cap_enabled = process.env.AGENT_REDELEG_CAP === 'on';
  console.log(`[brain] redelegation_cap_enabled override from env: ${process.env.AGENT_REDELEG_CAP}`);
}
// Per-VM override for temporal-memory context auto-maintenance — canary WITHOUT a global flip.
// `AGENT_CONTEXT_MAINTENANCE=1|on` makes a completed project-touching mission refresh that project's
// context via the temporal-memory organ (RFC PROCESS_AS_NARRATIVE.md §6b).
if (process.env.AGENT_CONTEXT_MAINTENANCE) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.context_maintenance = process.env.AGENT_CONTEXT_MAINTENANCE === '1' || process.env.AGENT_CONTEXT_MAINTENANCE === 'on';
  console.log(`[brain] context_maintenance override from env: ${process.env.AGENT_CONTEXT_MAINTENANCE}`);
}
// Per-VM override for approval SCOPING — canary WITHOUT a global flip.
// `AGENT_APPROVAL_SCOPE=on` scopes an "approve"/"reject" reply to the resolving
// agent's OWN, in-conversation pending approvals (instead of the whole prime's
// accumulated set) and lets the brain be the single resolver (ears defers).
if (process.env.AGENT_APPROVAL_SCOPE) {
  CONTRACTS.dispatch = CONTRACTS.dispatch || {};
  CONTRACTS.dispatch.approval_scope_enabled = process.env.AGENT_APPROVAL_SCOPE === 'on';
  console.log(`[brain] approval_scope_enabled override from env: ${process.env.AGENT_APPROVAL_SCOPE}`);
}

// ---- Config ----
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';
// An unrendered provisioning placeholder (a chat-config.json copied verbatim so
// AGENT_USER_EMAIL is the literal "${AGENT_USER_EMAIL}") must NEVER become an envelope
// owner — it did on a mis-provisioned Prime, stamping 500+ envelopes with a literal that
// archival then auto-cancelled. Treat a `${`-bearing value as unset → owner falls back to
// AGENT_ID (a stable, real identifier). The real identity is fixed at provisioning.
const _rawAgentEmail = process.env.AGENT_USER_EMAIL || '';
const AGENT_EMAIL = _rawAgentEmail.includes('${') ? '' : _rawAgentEmail;
if (_rawAgentEmail.includes('${')) {
  console.warn(`[brain] AGENT_USER_EMAIL is an unrendered placeholder (${_rawAgentEmail}); treating as unset — owners fall back to AGENT_ID. Fix provisioning (chat-config.json / .identity-lock).`);
}
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
const BRAIN_MODEL = CONTRACTS.dispatch?.model || 'gemini-3.6-flash';
const BRAIN_ROUTE = CORTEX_ROUTE;  // classify/decide/synthesize always use cortex

// ---- Project contracts config ----
const PROJECT_PROMOTION_AUTO = CONTRACTS.projects?.promotion_auto || false;

// ---- Artifacts config (loaded from prime Firestore doc at startup) ----
// Drive folder provisioning removed — git substrate is the sole artifact store (C-24)

// ---- Context forwarding budgets (chars per prior step) ----
const CTX_DISPATCH_SUCCESS = CONTRACTS.dispatch?.ctx_dispatch_success || 4000;
const CTX_DISPATCH_FAILURE = CONTRACTS.dispatch?.ctx_dispatch_failure || 3000;
const CTX_AGENT_STEP = CONTRACTS.dispatch?.ctx_agent_step || 8000;
const CTX_VERIFY_INPUT = CONTRACTS.dispatch?.ctx_verify_input || 24000;
const RESOURCE_LEDGER_ENABLED = CONTRACTS.memory?.resource_ledger?.enabled !== false;
const RESOURCE_LEDGER_RECALL_LIMIT = CONTRACTS.memory?.resource_ledger?.recall_limit ?? 40;
const CTX_CORTEX_STEP = CONTRACTS.dispatch?.ctx_cortex_step || 4000;

// ---- ORGAN_CONTEXT_SHARING_PLAN Phase 2: hydrate-on-demand ----
const HYDRATE_ENABLED = CONTRACTS.organ_context?.hydrate_enabled !== false;
const HYDRATE_MAX_CHARS = CONTRACTS.organ_context?.hydrate_max_chars || 12000;
const HYDRATE_MAX_REFS = CONTRACTS.organ_context?.hydrate_max_refs_per_mission || 6;
const BLACKBOARD_ENABLED = CONTRACTS.organ_context?.blackboard_enabled !== false;
const BLACKBOARD_MAX_CHARS = CONTRACTS.organ_context?.blackboard_max_chars || 12000;

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

// toStr imported from ../platform/providers/to-str.mjs (single source of truth)

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
// Agent role (prime|fleet) from STATE.json — skills can scope themselves to
// roles via skill.json "roles"; role-mismatched skills never enter the index,
// even if a stale directory survives from an earlier install (installs copy
// but never prune).
let AGENT_ROLE = '';
try {
  AGENT_ROLE = JSON.parse(readFileSync(CORE_DIR + '/corekit/STATE.json', 'utf8')).role || '';
} catch {}

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

  // One entry per skill id, first directory wins.
  //
  // The three scan roots OVERLAP by construction: skill-setup symlinks every
  // specialty and custom skill into skills/<id>, so the same skill is reached
  // twice — once through the link and once at its source. Without this, a live
  // fleet agent derived a capability map listing "Calendar Operations" twice,
  // which is both noise in cortex's context and a miscount of what the agent has.
  //
  // The out-of-process generator this replaced deduped (`if sid in seen:
  // continue`) and dropping that was a real regression — caught by running the
  // derivation against a live VM rather than by any test here, because the
  // duplicate only exists where the symlinks do.
  const seen = new Set();
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
        // Role scoping: skill.json "roles": ["fleet"] excludes the skill from
        // agents of other roles (e.g. delegation never surfaces on a Prime).
        const skillRoles = Array.isArray(manifest.roles) ? manifest.roles : null;
        if (skillRoles && AGENT_ROLE && !skillRoles.includes(AGENT_ROLE)) continue;
        const skillId = manifest.id || name;
        if (seen.has(skillId)) continue;
        seen.add(skillId);
        index.push({
          id: skillId,
          name: manifest.name || name,
          agent_parts: Array.isArray(manifest.agent_part) ? manifest.agent_part : [manifest.agent_part || 'motor'],
          when_to_use: manifest.when_to_use || '',
          category: manifest.category || '',
          // `summary` is the field skill-setup's generator preferred when it built
          // the capability map out-of-process. Carrying it here is what lets that
          // generator be deleted without losing fidelity — only two shipped
          // skill.json files set it, but a silently different summary would be a
          // hard difference to notice.
          summary: manifest.summary || '',
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

// ---- Brain capability map (path-free, high-level; for planning organs) ----
// The HIGH-LEVEL view of what each organ can do — names + one-line purpose, NO
// paths, NO how-to. Cortex/Prefrontal plan against THIS, never a skill catalog:
// they see WHICH organ can do WHAT, not HOW — the executing organ chooses its own
// skills.
//
// DERIVED from the live skill index. It used to prefer a file, skill-capability-map.md,
// which skill-setup generated ON DEPLOY — so the map that decides what work is even
// possible refreshed only at a PLATFORM UPGRADE. A skill added by a Fleet release was
// invisible to planning until an unrelated platform event, and a brain restart did not
// help because the restart re-read the same stale file.
//
// The derivation is also strictly more correct than the file was. That generator
// globbed skills/*/skill.json only, so it missed specialty skills and
// workspace/custom-skills entirely, and it ignored skill.json `roles` — it could
// advertise to cortex a capability this agent's role excludes.
function formatCapabilityMapFromIndex(skillIndex) {
  if (!skillIndex?.length) return '';
  const byOrgan = {};
  for (const s of skillIndex) {
    // summary → when_to_use → category, matching the precedence the deleted
    // out-of-process generator used, so the map does not silently change wording.
    const brief = (s.summary || s.when_to_use || s.category || '').split('. ')[0].slice(0, 120);
    for (const o of (s.agent_parts || ['motor'])) {
      (byOrgan[o] ||= []).push(`- ${s.name}${brief ? ` — ${brief}` : ''}`);
    }
  }
  const order = ['cortex', 'prefrontal', 'motor', 'cerebellum', 'temporal-memory', 'temporal-research', 'all'];
  const organs = Object.keys(byOrgan).sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
  return organs.map(o => `## ${o}\n${byOrgan[o].sort().join('\n')}`).join('\n\n');
}
let CAPABILITY_MAP = formatCapabilityMapFromIndex(SKILL_INDEX);

/**
 * Re-derive what this agent can do, at a mission boundary.
 *
 * Both of these were built once at module load and never rebuilt, and content-sync
 * restarts nothing — so an APPLIED release was not a LIVE release. Every other
 * correctness property in the release path sits upstream of this step.
 *
 * A BOUNDARY, deliberately, not a watcher. Responsibilities hot-reload on a
 * watchFile because the scheduler only starts new work with them; these two are read
 * throughout a mission, and swapping an agent's capabilities underneath running work
 * is what C-32 forbids. Refreshing between missions gives a mission one stable answer
 * to "what can I do" for its whole life, which is the same guarantee content-sync's
 * idle boundary gives its files.
 *
 * Refuses an empty result. buildSkillIndex() swallows every error it meets — an
 * unreadable directory, a half-written skill.json — and returns a SHORTER list rather
 * than failing. A shorter list is legitimate (a release can retire a skill); an EMPTY
 * one never is, because an agent always has base skills. Adopting it would silently
 * strip the agent of every capability at the moment a scan glitched.
 */
function refreshCapabilities(reason) {
  const next = buildSkillIndex();
  if (!next.length) {
    log('WARN', `skill index rebuild came back empty (${reason}) — keeping the previous `
      + `${SKILL_INDEX.length}. An agent with zero skills is a failed scan, not a valid state.`);
    return;
  }

  const before = SKILL_INDEX.map((s) => s.id).sort();
  const after = next.map((s) => s.id).sort();
  SKILL_INDEX = next;
  CAPABILITY_MAP = formatCapabilityMapFromIndex(next);

  // Quiet unless something actually moved: this runs before every mission, and a
  // line per mission saying "nothing changed" is how a real change gets missed.
  if (before.join(',') !== after.join(',')) {
    const added = after.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !after.includes(id));
    log('INFO', `capabilities changed at ${reason}: `
      + `${added.length ? `+[${added.join(', ')}] ` : ''}`
      + `${removed.length ? `-[${removed.join(', ')}] ` : ''}`
      + `(${after.length} skills)`);
  }
}

// ---- Project registry (via platform/control-plane/projects.mjs, Phase 1A extraction) ----
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

// ---- Process registry (via platform/work/process-registry.mjs) ----
// A process is a remembered PLAYBOOK (name + description + narrative) an agent RECALLS into
// its own checkpoint_plan — never an executable step-machine. The registry only LOADS them
// (local CoreKit files + the tenant-global Firestore `processes` collection); the former step
// executor (executeProcess / plan lifecycle / processToCheckpointPlan / resumeProcessPlan) was
// removed in the process-as-narrative migration (RFC docs/proposals/PROCESS_AS_NARRATIVE.md).
// _registry is initialized lazily (needs GCP_PROJECT/CORE_DIR resolved earlier in this file).
let _registry = null;
let PROCESSES = {}; // synced from the registry for the playbook-injection sites below

function _initProcessRegistry() {
  _registry = createProcessRegistry({
    logger: log,
    config: { coreDir: CORE_DIR, gcpProject: GCP_PROJECT },
  });
}

function _ensureRegistry() {
  if (!_registry) _initProcessRegistry();
}

// Thin wrappers preserving existing call signatures
async function loadProcesses() {
  _ensureRegistry();
  await _registry.loadProcesses();
  PROCESSES = _registry.getAllProcesses();
}

async function ensureProcessesLoaded() {
  _ensureRegistry();
  await _registry.ensureLoaded();
  PROCESSES = _registry.getAllProcesses();
}

// Resume a NON-process (cortex checkpoint_plan) mission after an approval gate is APPROVED.
// CONTINUE the pinned checkpoint plan from the task AFTER the gate — deterministically, via
// executeCheckpointPlanResume — instead of re-entering the Cortex decide loop. Re-deciding
// re-plans the gate's checkpoint and re-inserts the SAME approval gate, so a checkpoint that
// bundles a gate + the gated action ("obtain approval", then "promote to prod") re-gates
// forever (observed: a prod-promote looping iter 1->2->3, a fresh apr- each approve). Works for
// both non-prestamped (checkpoints in paused_checkpoints) and prestamped/spine missions
// (paused_checkpoints=null -> rebuild from the pinned _cp_spine). Falls back to the legacy
// decide-loop resume if the plan can't be reconstructed or checkpoint-resume is disabled.
async function resumeCheckpointPlan(mission, memory) {
  const meta = mission.source_meta || {};
  const ci = meta.paused_checkpoint_index;
  const ti = meta.paused_task_index;
  const savedResults = meta.paused_all_results || [];
  let checkpoints = meta.paused_checkpoints;
  if ((!checkpoints || checkpoints.length === 0) && Array.isArray(mission._cp_spine) && mission._cp_spine.length) {
    try { checkpoints = rebuildFromSpine(mission._cp_spine).checkpoints; } catch (e) { log('WARN', `resumeCheckpointPlan: rebuildFromSpine failed: ${e.message}`); }
  }
  const cleanPaused = (e) => {
    if (!e.source_meta) return;
    delete e.source_meta.paused_approval_id;
    delete e.source_meta.paused_checkpoints;
    delete e.source_meta.paused_checkpoint_index;
    delete e.source_meta.paused_task_index;
    delete e.source_meta.paused_all_results;
  };
  const canContinue = CHECKPOINT_RESUME_ENABLED && checkpoints && checkpoints.length > 0
    && ci !== undefined && ci !== null && ti !== undefined && ti !== null;
  if (!canContinue) {
    log('WARN', `Approval resume: cannot continue plan for ${mission.id} (ci=${ci} ti=${ti} cps=${checkpoints ? checkpoints.length : 0} resume=${CHECKPOINT_RESUME_ENABLED}); falling back to decide loop`);
    mission.status = 'active'; mission.updated_at = now();
    cleanPaused(mission);
    await firestoreWrite('work', mission.id, mission);
    return processEnvelope(mission, memory);
  }
  mission.status = 'active'; mission.updated_at = now();
  cleanPaused(mission);
  await firestoreWrite('work', mission.id, mission);
  log('INFO', `Approval resume: CONTINUING checkpoint plan at CP${ci + 1} task ${ti + 2} (the task AFTER the approved gate) — no re-plan`);
  return executeCheckpointPlanResume(mission, {
    checkpointIndex: ci,
    taskIndex: ti + 1,
    allResults: savedResults,
    checkpoints,
  }, memory);
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

// ---- Firestore REST client (via platform/persistence/firestore.mjs) ----
// FIRESTORE_BASE: still used by 27 direct REST call sites in un-extracted code
// (projects, processes, approvals, etc.). Will be removed when those are extracted.
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const _db = createFirestoreClient({ projectId: GCP_PROJECT, logger: log });

// Thin wrappers preserving existing (collection, docId) call signature.
// Work artifacts are deployment-rooted (top-level); actor state stays prime-scoped.
// C-1: Prime is executor, not storage root. Work carries owner + prime_id fields.

const DEPLOYMENT_ROOTED = new Set([
  'work', 'processes', 'plans', 'approvals', 'projects', 'skill-proposals',
  // On-demand responsibility triggers are a top-level, agent-addressed control
  // channel (like `work`): the introspect daemon writes them at the documents
  // root and the brain's checkResponsibilityTriggers reads/claims them there.
  'responsibility_triggers',
]);

function collectionParent(collection) {
  return DEPLOYMENT_ROOTED.has(collection) ? '' : `primes/${PRIME_ID}`;
}

function pathFor(collection, docId) {
  return DEPLOYMENT_ROOTED.has(collection)
    ? `${collection}/${docId}`
    : `primes/${PRIME_ID}/${collection}/${docId}`;
}

// ---- C-32 version coordinates ----
//
// `platform_version` comes from the installed platform release; `fleet_release`
// and `agent_spec_digest` from CONTENT.json, which content-sync rewrites when it
// applies a bundle. Cached with an mtime check rather than read per write: a
// mission-heavy minute would otherwise stat the same file hundreds of times, and
// a stale coordinate would misattribute every envelope written after an apply.
let _coordCache = { at: 0, mtime: 0, value: { platform_version: null, fleet_release: null, agent_spec_digest: null } };

function versionCoordinates() {
  const contentPath = CORE_DIR + '/corekit/CONTENT.json';
  let mtime = 0;
  try { mtime = statSync(contentPath).mtimeMs; } catch { /* no content release applied yet */ }

  if (mtime === _coordCache.mtime && Date.now() - _coordCache.at < 60_000) return _coordCache.value;

  let platformVersion = null;
  try {
    const state = JSON.parse(readFileSync(CORE_DIR + '/corekit/STATE.json', 'utf8'));
    platformVersion = String(state.coreRef || state.version || '') || null;
  } catch { /* pre-STATE install */ }

  let fleetRelease = null;
  let specDigest = null;
  try {
    const content = JSON.parse(readFileSync(contentPath, 'utf8'));
    fleetRelease = content.release || null;
    specDigest = content.spec_digest || null;
  } catch { /* this agent is not yet running from a fleet release */ }

  _coordCache = {
    at: Date.now(), mtime,
    value: { platform_version: platformVersion, fleet_release: fleetRelease, agent_spec_digest: specDigest },
  };
  return _coordCache.value;
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
  // C-32: stamp the exact spec that produced this work, once, at creation.
  // Every envelope carries its version coordinates for its whole life, so a
  // behavior can be attributed to the content that caused it and replayed. The
  // `||` keeps it idempotent — a later write never re-stamps a running mission
  // with content that arrived after it started.
  if (collection === 'work' && data) {
    const coords = versionCoordinates();
    data.platform_version = data.platform_version || coords.platform_version;
    data.fleet_release = data.fleet_release || coords.fleet_release;
    data.agent_spec_digest = data.agent_spec_digest || coords.agent_spec_digest;
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

/**
 * Read and query that REFUSE TO ANSWER when the store is unreachable.
 *
 * The permissive pair above returns null / [] on any failure, which is correct
 * for the ~100 call sites where "nothing there" and "could not look" lead to the
 * same harmless no-op. It is catastrophic at the handful of sites that read the
 * absence as a FACT and act on it — those are the ones that use these.
 *
 * Opt-in rather than default for the reason the client itself is opt-in: about
 * forty caller catch sites already convert exceptions back into null/[], so
 * flipping the default would relocate the defect rather than remove it.
 *
 * The dual-read fallback also becomes correct here for free. It fires on `!result`,
 * so with the permissive read an OUTAGE triggered a second read against the legacy
 * path for every deployment-rooted collection — doubling load at the moment the
 * backend was already degraded. Under strict, only a genuine 404 gets that far.
 */
async function firestoreReadStrict(collection, docId) {
  const result = await _db.read(pathFor(collection, docId), { strict: true });
  if (!result && DEPLOYMENT_ROOTED.has(collection)) {
    return _db.read(`primes/${PRIME_ID}/${collection}/${docId}`, { strict: true });
  }
  return result;
}

async function firestoreQueryStrict(collection, filters, opts) {
  return _db.query(collectionParent(collection), collection, filters, { ...opts, strict: true });
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
    // Strict: a 404 means the envelope genuinely is not there yet (the normal
    // path for a new one), and claiming freely is right. Any OTHER failure means
    // we could not tell — and the permissive read returned null for both, so a
    // flaky store made every processor claim freely and the durable cross-restart
    // lock evaporated exactly when it was most needed.
    const env = await firestoreReadStrict('work', envelopeId);
    if (!env) return claimId; // Genuinely absent — claim freely
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
    // A STORAGE failure is the one error that must not proceed, and this catch
    // used to swallow every error and claim anyway — which would have made the
    // strict read above completely inert. A guard one line below can disarm is
    // not a guard.
    //
    // The distinction: if we could not READ the envelope we cannot know whether
    // another processor already holds the claim, and claiming regardless is how
    // two agents run the same mission. The local guard the old comment relied on
    // does not span instances or restarts, which is the whole reason this claim
    // is durable. Declining costs one poll interval; proceeding costs a duplicate.
    if (e?.name === 'StoreUnavailable') {
      log('WARN', `Claim declined for ${envelopeId}: the store is unreachable (${e.message}), so `
        + `whether another processor holds this claim is unknown`);
      return null;
    }
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
async function callCortex(mode, payload, sessionCtl = null) {
  // SESSION_CONTEXT_PLAN Phase 2: two system blocks (stable | MEMORY) and a
  // cache-tiered content-parts user message. The [BRAIN-ORCHESTRATED] header
  // opens the boot-stable bytes; the per-mission Requester line rides the
  // mission tier so it never re-keys the boot block.
  // Phase 5: with an active session, a 'continue' turn ships ONLY the
  // volatile tier — the static prefix lives in the gateway-held history
  // (the Phase 2 tier partition IS the session's static/delta split).
  const sysBlocks = buildSystemBlocks(mode, payload);

  // Phase 5: a 'continue' is DAEMON-AUTHORED — it prepends the previous
  // decision (coerced JSON) as an assistant turn and sends ONLY a slim
  // "WORKING STATE (delta)" user turn (new since the last decision). The
  // static prefix (header, boot, mission, and the open turn's full working
  // state) lives in the gateway-held transcript and is cache-read at ~0.1x.
  // A continue without a prior decision is impossible by construction (the
  // controller nulls the session), but guard defensively: fall back to the
  // full open-shape rather than emit consecutive user turns.
  const isContinue = !!(sessionCtl && sessionCtl.op === 'continue' && sessionCtl.priorDecision);
  let userContent;
  if (isContinue) {
    userContent = toContentParts(buildDecideDeltaBlock(payload, sessionCtl.sentUpto || 0));
  } else {
    const pingerEmail = payload.envelope?.source_meta?.senderEmail || '';
    const userBlocks = [
      { label: '', text: '[BRAIN-ORCHESTRATED]', tier: 'boot' },
      ...(pingerEmail ? [{ label: 'REQUESTER', text: `Use this email for Drive sharing and communication: ${pingerEmail}`, tier: 'mission' }] : []),
      ...buildUserBlocks(mode, payload),
    ];
    userContent = toContentParts(userBlocks);
  }

  // Only ids/counters cross the wire — priorDecision/sentUpto are daemon-side.
  const sessionField = sessionCtl
    ? { id: sessionCtl.id, op: (sessionCtl.op === 'continue' && !isContinue) ? 'open' : sessionCtl.op, seq: sessionCtl.seq }
    : null;

  // Per-agent generation parameters from registry
  const cortexConfig = REGISTRY.agents?.cortex || {};
  const maxTokens = cortexConfig.max_tokens || 32768;
  const temperature = cortexConfig.temperature ?? 0.4;
  const topP = cortexConfig.top_p ?? 0.95;

  log('INFO', `Calling Cortex: mode=${mode}${sessionField ? ` session=${sessionField.op}` : ''} (max_tokens=${maxTokens}, temp=${temperature}, top_p=${topP})`);
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
        ...(isContinue ? [{ role: 'assistant', content: sessionCtl.priorDecision }] : []),
        { role: 'user', content: userContent },
      ],
      ...(sessionField ? { session: sessionField } : {}),
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

  // Phase 5 fail-closed protocol: a 'continue' turn shipped only the delta —
  // a completion without the session echo (fast miss, old gateway, excluded
  // agent) must NEVER be acted on. 'open' turns carry full context and stay
  // valid either way; they just don't get a session. Keyed on isContinue, not
  // the requested op, so a missing-priorDecision reopen (sent as open-shape) is
  // never mistaken for a delta miss.
  if (isContinue && data.session?.present !== true) {
    log('INFO', `[TELEMETRY] session_miss id=${sessionCtl.id} reason=${data.session?.reason || 'no_echo'}`);
    return { _session_miss: true, reason: data.session?.reason || 'no_echo' };
  }

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

  const parsed = await enforceSchema(content, mode);
  // Phase 5: capture the COERCED decision JSON BEFORE daemon-only fields are
  // attached — this exact string becomes the assistant turn on the next
  // continue (the plan's "coerced JSON, never raw garbage"). A parse failure
  // yields no _coercedDecision, so the controller resets the session.
  if (parsed && typeof parsed === 'object') {
    const coerced = !parsed.error ? JSON.stringify(parsed) : null;
    // Phase 4.3: Attach usage metadata to the parsed result for telemetry
    parsed.usage = data.usage || null;
    parsed.durationMs = _cortexDuration;
    parsed._session = data.session || null; // Phase 5: seq echo for the controller
    parsed._coercedDecision = coerced;
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
    sysParts.push(`[PROCESS PLAYBOOKS — how we've done this well before]\n${JSON.stringify(
      Object.values(PROCESSES).map(p => ({ id: p.id, name: p.name, description: (p.description || '').substring(0, 200), narrative: p.narrative || null })),
      null, 2
    )}`);
  }
  const envProjectId = payload.project_id || payload.envelope?.project_id;
  if (envProjectId && PROJECTS[envProjectId]) {
    const proj = PROJECTS[envProjectId];
    sysParts.push(`[PROJECT CONTEXT]\n${JSON.stringify({
      id: proj.id, name: proj.name, description: proj.description,
      context: proj.context || {},
      // Deploy target (unambiguous site vs gcp project) so the planner names the right
      // site for a deploy checkpoint instead of inferring it from the project name.
      deploy: proj.deploy || null,
      team: (proj.team || []).map(m => ({ email: m.email, role: m.role, name: m.name, type: m.type })),
    }, null, 2)}`);
  }
  sysParts.push('You MUST respond with exactly one JSON block and nothing else.');

  // Capability map — high-level awareness of what each organ can do, for outcome
  // decomposition and ownership routing. Prefrontal plans by OUTCOME; it never sees
  // how a skill works and never names a skill/tool — the executing organ owns the how.
  if (CAPABILITY_MAP) {
    sysParts.push(`[BRAIN CAPABILITY MAP — what each organ can do, high level]\nDecompose by outcome and route by ownership. You see WHICH organ can do WHAT, never HOW. Never name a skill, command, or tool for another organ — the executing organ chooses its own.\n\nOWNERSHIP: mark a part \`local\` (this agent does it) whenever your OWN capabilities below can accomplish it — your specialty's work is yours and is never delegated. Mark a part \`teammate\` ONLY when it needs a capability no organ of yours has. A devops agent deploys its own releases, an engineer writes its own code, a designer makes its own designs — delegate outward only what your specialty genuinely cannot do. Do not hand a teammate work you are the one equipped for.\n\n${CAPABILITY_MAP}`);
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

  // 6. Process playbooks (if any exist) — a process is a remembered narrative, not a program.
  if (Object.keys(PROCESSES).length > 0) {
    const playbooks = Object.values(PROCESSES).map(p => ({
      id: p.id, name: p.name, description: p.description, narrative: p.narrative || null,
    }));
    parts.push(`[PROCESS PLAYBOOKS — how we've done this well before]
A process is a remembered narrative, not a program. When your work resembles one, treat its narrative as guidance and plan your OWN checkpoints with it (checkpoint_plan) — adapt it, keep full control; do NOT hand execution to a rigid template. Available:
${JSON.stringify(playbooks, null, 2)}`);
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
    classifyPayload.capability_map = CAPABILITY_MAP;
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
    decidePayload.capability_map = CAPABILITY_MAP;
    // Inject project context if envelope is scoped to a project.
    // The trimmed decide envelope (decideArgs) omits project_id and passes it TOP-LEVEL
    // (commit c686809) — so read the top-level first, then fall back to the nested field.
    // Without this fallback the canon-bearing rendered_project_context (now incl. the
    // Deployment block) never reached cortex at decide, only the canon-less registry.
    const envProjectId = payload.project_id || payload.envelope?.project_id;
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
    // ---- Known identifiers, as they stand RIGHT NOW ----
    // Layer E already offers the ledger to memory, but recallMemory runs once per
    // mission before any task, so every id resolved *during* the mission is invisible
    // to the decider. A mission that had just captured three doc ids in its own step 1.1
    // reached the next decision unable to name them, invented an action called
    // `request_context` to go and fetch what it already had, was nudged, and blocked.
    // Deciding is exactly when knowing the ids matters, so hand over the live ledger.
    if (RESOURCE_LEDGER_ENABLED) {
      try {
        const block = renderResources(payload.envelope?.context?.resources, {
          limit: RESOURCE_LEDGER_RECALL_LIMIT,
          cues: String(payload.envelope?.instruction || '')
            .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3),
        });
        if (block) decidePayload.known_resources = block;
      } catch { /* a bookkeeping miss must never cost a decision */ }
    }
    // Inject available process PLAYBOOKS so Cortex can recall a relevant narrative into its own plan.
    if (Object.keys(PROCESSES).length > 0) {
      decidePayload.available_processes = Object.values(PROCESSES).map(p => ({
        id: p.id, name: p.name, description: (p.description || '').substring(0, 200),
        narrative: p.narrative || null,
        intent_keywords: p.intent_keywords || [],
      }));
    }
    // Inject user-triggerable responsibilities so Cortex can honor an explicit
    // "run this now / out of turn" request by firing the scheduled cycle instead
    // of re-planning its internal steps. Mechanism-awareness lives here (injected
    // context), never in SOUL — C-28 layer purity.
    const triggerableResps = getTriggerableResponsibilities();
    if (triggerableResps.length > 0) {
      decidePayload.available_responsibilities = triggerableResps;
      decidePayload.responsibility_trigger_guidance =
        'These are scheduled background cycles. If — and only if — the user explicitly asks you to RUN one of them now / out of turn, '
        + 'respond with { "action": "trigger_responsibility", "responsibilityId": "<id from available_responsibilities>" }. '
        + 'That starts the cycle in the background; you then confirm to the user. Do NOT use trigger_responsibility for anything not in this list, '
        + 'and do NOT plan a cycle\'s internal steps yourself — firing the responsibility runs its own process.';
    }
    // Fleet project bootstrap: when a PM/lead is asked to STAND UP a new project and the ask
    // arrived on a chat space not yet linked to a project, surface the space + the action. The
    // action binds a new project to THIS space and re-scopes the mission so delivery can then
    // delegate through it. Gated on the flag + the project-ops skill (PM/lead role only).
    if (projectBootstrapEnabled(CONTRACTS) && (SKILL_INDEX || []).some(s => s.id === 'project-ops')) {
      // The decide envelope projection is trimmed (no source_meta/project_id), so the origin
      // space is passed in explicitly by the caller (computed from the FULL envelope). Fall
      // back to the projection for any path that still carries source_meta.
      const _originSpace = payload.origin_space || missionOriginSpace(payload.envelope);
      const _pid = payload.project_id || envProjectId;
      const _curSpace = _pid && PROJECTS[_pid]?.gchat_space_id;
      if (_originSpace && !_curSpace) {
        decidePayload.project_bootstrap_available = {
          origin_space: _originSpace,
          note: `This request arrived on GChat space "${_originSpace}", which is NOT yet linked to a project — this mission fell back to a default project with no comms space, so you cannot delegate or plan project work from it yet.`,
          when: 'If the ask is to SET UP / CREATE / BOOTSTRAP a new project (its own team + this chat as its channel), respond with project_bootstrap. It binds a new project to THIS space, seeds the team, and re-scopes this mission to it — then you plan and delegate the real work normally.',
          precedence: 'This OVERRIDES the "use checkpoint_plan" guidance for a project-setup ask: do NOT checkpoint_plan or delegate work into a project that does not exist yet — that is exactly what fails here (no space → delegation cannot deliver, and you loop into needs_input). Bootstrap FIRST with project_bootstrap; the mission then auto-continues and you checkpoint_plan the delivery in the now-created project. Do not ask the operator to create the project or to pick a space — creating it from THIS space is your job now.',
          form: '{ "action": "project_bootstrap", "project": { "name": "...", "description": "...", "goal": "...", "team": [ {"role":"engineer","specialty":"engineer","responsibilities":"..."}, {"role":"devops","specialty":"devops","responsibilities":"..."} ], "canon": [ {"key":"deploy-flow","text":"..."} ], "context": [ {"key":"source","kind":"drive","ref":"<id>","summary":"..."} ] } }',
          boundary: 'Name teammates by role/specialty — the system resolves their real fleet emails; never invent one. You CANNOT add teammates to the chat space (operator only). After bootstrap, if a delegation reports it was not delivered, use needs_input to ask the operator to add that teammate to this space.',
        };
        log('INFO', `[TELEMETRY] project_bootstrap_offered mission=${payload.envelope?.id} space=${_originSpace}`);
      }
    }
    // Inject Brief from ANALYZE phase when present
    if (payload.brief) {
      decidePayload.brief = payload.brief;
      decidePayload.dispatch_guidance = {
        rule: 'To commit work from the Brief, use checkpoint_plan. You may provide a full checkpoints array OR just a goal + constraints — prefrontal will structure the detailed plan if you omit checkpoints.',
        minimal_form: '{ action: "checkpoint_plan", goal: "...", constraints: "..." } — prefrontal structures the plan',
        full_form: '{ action: "checkpoint_plan", checkpoints: [...] } — you provide the full structure',
        preference: 'Use the minimal form unless you have specific structural requirements.',
        step_types: (SKILL_INDEX || []).some(s => s.id === 'delegation')
          ? 'standard (local work via motor/research), delegation (project teammate — set target_email), approval_gate (destructive_or_public risk — operator gate), ask (unresolvable unknowns — use needs_input)'
          : 'standard (local work via motor/research), approval_gate (destructive_or_public risk — operator gate), ask (unresolvable unknowns — use needs_input)',
        sequencing: 'Independent parts fan out within a checkpoint. Dependent parts serialize via checkpoint boundaries.',
        skill_guidance: 'Write task instructions that describe WHAT should happen, not HOW. Sub-agents are specialists — they know their own tools. Describe the desired outcome, inputs, and acceptance criteria.',
        // Without this, the hatch is unreachable: it is read off `decision` and named
        // nowhere else. A real mission diagnosed its own plan as mis-shaped ("the docs
        // already exist; the remaining work is to populate them"), had no key to say
        // so, invented an action that does not exist, and blocked.
        replan_scope: 'A checkpoint that fails is re-tasked against its pinned outcome — the mission keeps its shape. If the SHAPE itself is wrong (a phase is missing, or the outcomes describe work that is already done or was never needed), send { action: "checkpoint_plan", replan_scope: "mission", replan_reason: "..." } to discard the pinned skeleton and re-shape. Use it when re-tasking cannot fix the problem, not when a task merely failed.',
        // Cortex has invented `retask` and `request_context` when it wanted behaviour nobody
        // told it already exists by default. Naming the defaults is cheaper than nudging it
        // back from an action that was never in the schema.
        after_a_failed_checkpoint: 'Returning { action: "checkpoint_plan" } is enough — the failed checkpoint is re-tasked automatically against its pinned outcome, and checkpoints that already PASSED keep their verdicts and are not re-run. There is no separate "retask" action; do not invent one. There is also no action for fetching more context: the identifiers already resolved this mission are handed to you in known_resources on every decision, and full step outputs are retrievable by the ref on each result — so ask for a re-task, not for a lookup.',
      };
      // Project-scoped process preference
      if (envProjectId && PROJECTS[envProjectId]?.standardProcesses?.length > 0) {
        decidePayload.dispatch_guidance.process_preference = 
          `Project "${PROJECTS[envProjectId].name}" has relevant process playbooks: ${PROJECTS[envProjectId].standardProcesses.join(', ')}. Treat their narrative as guidance and plan your OWN checkpoints (checkpoint_plan).`;
      }
    } else {
      // No Brief (non-execution-bound or analysis failed) — fall back to checkpoint_plan guidance
      decidePayload.dispatch_guidance = {
        rule: 'ALL work MUST use checkpoint_plan. One focused task per task entry. Even single-step work is one checkpoint with one task.',
        reasoning: 'Each motor task has a limited step budget. Atomic tasks prevent timeouts and preserve context on failure. The M→C→T hierarchy ensures progress tracking and enables re-planning on failure.',
        skill_guidance: 'Write task instructions that describe WHAT should happen, not HOW. Sub-agents are specialists — they know their own tools. Describe the desired outcome, inputs, and acceptance criteria.',
        // Without this, the hatch is unreachable: it is read off `decision` and named
        // nowhere else. A real mission diagnosed its own plan as mis-shaped ("the docs
        // already exist; the remaining work is to populate them"), had no key to say
        // so, invented an action that does not exist, and blocked.
        replan_scope: 'A checkpoint that fails is re-tasked against its pinned outcome — the mission keeps its shape. If the SHAPE itself is wrong (a phase is missing, or the outcomes describe work that is already done or was never needed), send { action: "checkpoint_plan", replan_scope: "mission", replan_reason: "..." } to discard the pinned skeleton and re-shape. Use it when re-tasking cannot fix the problem, not when a task merely failed.',
        // Cortex has invented `retask` and `request_context` when it wanted behaviour nobody
        // told it already exists by default. Naming the defaults is cheaper than nudging it
        // back from an action that was never in the schema.
        after_a_failed_checkpoint: 'Returning { action: "checkpoint_plan" } is enough — the failed checkpoint is re-tasked automatically against its pinned outcome, and checkpoints that already PASSED keep their verdicts and are not re-run. There is no separate "retask" action; do not invent one. There is also no action for fetching more context: the identifiers already resolved this mission are handed to you in known_resources on every decision, and full step outputs are retrievable by the ref on each result — so ask for a re-task, not for a lookup.',
      };
      // Project-scoped process preference
      if (envProjectId && PROJECTS[envProjectId]?.standardProcesses?.length > 0) {
        decidePayload.dispatch_guidance.process_preference =
          `Project "${PROJECTS[envProjectId].name}" has relevant process playbooks: ${PROJECTS[envProjectId].standardProcesses.join(', ')}. Treat their narrative as guidance and plan your OWN checkpoints (checkpoint_plan).`;
      }
    }
    // When project_bootstrap is the required first step (mission on an unlinked space), REPLACE
    // the "use checkpoint_plan" mandate above with a bootstrap-first directive — otherwise the two
    // conflict and cortex loops on checkpoint_plan (whose delegations cannot deliver with no space).
    if (decidePayload.project_bootstrap_available) {
      decidePayload.dispatch_guidance = {
        rule: 'This request arrived on a chat space that has NO project yet, so your FIRST action MUST be project_bootstrap (see project_bootstrap_available). Do NOT use checkpoint_plan or delegate now — with no project there is no delivery route, they cannot succeed, and you will loop. project_bootstrap creates the project bound to THIS space and re-scopes the mission.',
        form: decidePayload.project_bootstrap_available.form,
        then: 'Only AFTER project_bootstrap returns do you plan the real work (edit, deploy, etc.) with checkpoint_plan in the now-created project.',
      };
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
  'delivery_status', 'delivered_at', '_session', '_compaction',
]);

// Per-result cap for the session delta (SESSION_CONTEXT_PLAN Phase 5). The
// delta is appended verbatim into the gateway transcript, so an uncapped
// dispatch result would inflate one turn AND persist cache-read on every
// later continue and count toward the compaction trigger — the exact B-4
// "unbounded transcript" hazard. Matches buildEnvelopeContext's own budget.
const DELTA_RESULT_CHARS = 2000;

// SESSION_CONTEXT_PLAN Phase 5: the slim continue delta — ONLY what is new
// since the model's last decision. The cumulative envelope_context and the
// full prior_results array are deliberately OMITTED: the model already read
// them as earlier turns in the session transcript (that IS the accumulated
// context). new_results is the tail past the watermark, each result capped.
function buildDecideDeltaBlock(payload, sentUpto = 0) {
  const p = buildModePayload('decide', payload);
  const tail = (p.prior_results || []).slice(sentUpto).map(r => {
    // ORGAN_CONTEXT_SHARING_PLAN Phase 1: when a shape-aware packet is present, show the
    // `summary` (+ ref/bytes/shape riding along) instead of a blind head+tail clip of the
    // full result — the clip drops the middle, exactly where list rows / tool data live.
    // Cortex requests the full content by `ref` only when the summary is insufficient (Phase 2).
    if (r.summary) {
      const { summary, result, ...rest } = r;
      return { ...rest, result: summary };
    }
    return {
      ...r,
      result: typeof r.result === 'string' ? smartTruncate(r.result, DELTA_RESULT_CHARS) : r.result,
    };
  });
  return [{
    label: 'WORKING STATE (delta) — new since your last decision',
    text: JSON.stringify({
      mode: 'decide',
      iteration: p.iteration,
      new_results: tail,
      pending_intake_count: p.pending_intake_count,
      pending_queue: p.pending_queue,
      goal_state: p.goal_state,
      premise_check: p.premise_check,
    }),
    tier: 'volatile',
  }];
}

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
      capability_map: p.capability_map,
      available_processes: p.available_processes,
      available_responsibilities: p.available_responsibilities,
      responsibility_trigger_guidance: p.responsibility_trigger_guidance,
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
      capability_map: p.capability_map,
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
// are now imported from platform/providers/json-repair.mjs (Phase 0C extraction)

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
        // TEMPORAL_MEMORY_AUTHORITY_PLAN P2: task dispatches (dispatchAgent) opt into tool
        // execution; the recall path calls callAgent without _exec, so it stays toolless.
        exec: envelope._exec === true,
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
    // #4B: surface the gateway's finish_reason so the caller can detect a
    // token-limit truncation ('length') deterministically and retry with a
    // "write to a file, return a concise summary" nudge (B-1/B-3).
    const finishReason = data.choices?.[0]?.finish_reason || 'stop';
    return { success: true, output: content, error: null, durationMs, usage: data.usage || null, finishReason };
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

    // No raw fast-path. ALL recall — including ambient/pre-classify — is synthesized
    // by temporal-memory into a context packet below. Brain organs never receive raw
    // memory layers: temporal is the SOLE consumer of raw memory and the SOLE producer
    // of the packet the other organs see (that is why temporal exists). The raw layers
    // gathered above (MEMORY.md, core memory, work ledger, episodic) are candidates for
    // temporal only.

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

    // ---- Layer E: Resource Ledger (name → id, already resolved) ----
    // The highest-value, most-deterministic recall content: an external id costs
    // an API search to re-derive, and re-deriving is how a mission burned its
    // whole dispatch budget re-finding a folder it already had. Two sources: this
    // mission's captured ledger (envelope.context.resources — survives the resume
    // that destroys the working tree) and durable core memory.
    //
    // UNSHIFTED, not pushed: the candidate block is trimmed from the tail, so
    // anything appended last is what gets cut. These lines are tiny and must
    // never be the thing dropped for budget.
    let layerEHits = 0;
    if (RESOURCE_LEDGER_ENABLED) {
      try {
        let ledger = { ...(context.resources || {}) };

        // Durable half: core memory's `resources` category, cue-filtered.
        if (existsSync(coreMemScript)) {
          try {
            const resOut = execFileSync(coreMemScript, [
              '--category', 'resources', '--status', 'active', '--limit', '25',
              ...(cues.length > 0 ? ['--query', cues.slice(0, 4).join(' ')] : []),
            ], { timeout: 10000, stdio: 'pipe', env: { ...process.env, CORE_DIR } }).toString();
            // Promoted facts are stored as `kind: "name" = id` — parse them back
            // into ledger shape so both halves render identically.
            for (const m of resOut.matchAll(/([a-z]+):\s*"([^"]+)"\s*=\s*([A-Za-z0-9_\-/]{10,})/g)) {
              const key = resourceKey(m[1], m[2]);
              if (!ledger[key]) ledger[key] = { kind: m[1], name: m[2], id: m[3], source: 'core-memory' };
            }
          } catch (e) {
            log('DEBUG', `Memory recall: core-memory resources read failed: ${e.message}`);
          }
        }

        const block = renderResources(ledger, { limit: RESOURCE_LEDGER_RECALL_LIMIT, cues });
        if (block) {
          memoryParts.unshift(block);
          layerEHits = Object.keys(ledger).length;
        }
      } catch (e) {
        log('WARN', `Memory recall: resource ledger failed: ${e.message}`);
      }
    }

    log('INFO', `[TELEMETRY] recall_layers scope=${scope} cues=${cues.length} coreIds=${seenCoreIds.size} digestHits=${layerCHits} workHits=${layerDHits} resourceHits=${layerEHits}`);

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
    // TEMPORAL_MEMORY_AUTHORITY_PLAN P2: the nightly consolidation mission must NOT append
    // its own entry to the working memory it just pruned (self-pollution). Skip it — the
    // consolidation report is the record, not a MEMORY.md line.
    const _cons = `${envelope.processId || envelope.processRef || envelope.process_ref || ''} ${envelope.responsibility_id || envelope.responsibilityId || envelope._responsibility || ''}`.toLowerCase();
    if (_cons.includes('memory-consolidate') || _cons.includes('memory-consolidation') ||
        /\bmemory consolidation\b|\bnightly memory\b/i.test(toStr(envelope.instruction))) {
      log('INFO', 'Memory write: skipping consolidation-born envelope (avoid self-pollution)');
      return;
    }
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

// ---- Context auto-maintenance: temporal-memory refreshes a touched project's context ----
// (RFC PROCESS_AS_NARRATIVE.md §6b) Best-effort, flag-gated, never throws. The organ PRODUCES the
// note (C-5); the daemon writes it to the root `projects/<id>` doc's context.auto_maintenance.
// Bounded (only the touched project), conservative (skips when nothing durable was learned), and
// it never ships or touches production — it only curates context.
async function maintainContext(mission) {
  // Two independent, best-effort refreshes after a mission completes: the touched PROJECT's context,
  // and any PLAYBOOK narratives the mission drew on. Each self-gates on the flag and never throws; one
  // failing never blocks the other, and neither ever blocks mission completion.
  await maintainProjectContext(mission);
  await maintainPlaybookNarratives(mission);
}

async function maintainProjectContext(mission) {
  try {
    const plan = shouldMaintainContext(mission, CONTRACTS);
    if (!plan.run) return;
    let proj = null;
    try { proj = await firestoreRead('projects', plan.projectId); } catch { /* fall back to cache */ }
    proj = proj || PROJECTS[plan.projectId];
    if (!proj) { log('INFO', `[context-maintenance] project ${plan.projectId} not found — skip`); return; }
    const result = await callAgent('temporal-memory', {
      instruction: buildMaintenancePrompt(mission, proj),
      accept_criteria: 'Return exactly one JSON object {"update":"<durable note, or empty string if nothing durable was learned>"}.',
    });
    if (!result || !result.success) { log('INFO', `[context-maintenance] no organ result for project ${plan.projectId}`); return; }
    const { update } = parseMaintenanceResponse(toStr(result.output));
    if (!update) { log('INFO', `[context-maintenance] nothing durable learned for project ${plan.projectId}`); return; }
    const ctx = (proj.context && typeof proj.context === 'object' && !Array.isArray(proj.context)) ? proj.context : {};
    ctx.auto_maintenance = { note: update, from_mission: mission.id, at: now() };
    await firestoreWrite('projects', plan.projectId, { ...proj, context: ctx });
    log('INFO', `[context-maintenance] refreshed project ${plan.projectId} context from ${mission.id} (${update.length} chars)`);
  } catch (e) {
    log('WARN', `[context-maintenance] project failed (non-fatal): ${e.message}`);
  }
}

// Refine the narrative of any PLAYBOOK the mission drew on (recalled_processes, stamped by checkpoint_plan
// when a playbook's intent_keywords matched the mission goal). Bounded (≤3), conservative (the organ
// leaves it as-is unless the run revealed something durable), additive (writes to the living Firestore
// store + bumps version). Never touches production; only curates the shared library.
async function maintainPlaybookNarratives(mission) {
  try {
    const pplan = shouldMaintainProcesses(mission, CONTRACTS);
    if (!pplan.run) return;
    await ensureProcessesLoaded();
    for (const pid of pplan.processIds) {
      try {
        let proc = PROCESSES[pid];
        if (!proc) { try { proc = await firestoreRead('processes', pid); } catch { proc = null; } }
        if (!proc || proc.status === 'deprecated') continue;
        const r = await callAgent('temporal-memory', {
          instruction: buildProcessMaintenancePrompt(proc, mission),
          accept_criteria: 'Return exactly one JSON object {"update":"<the refined narrative, or empty string to leave it as-is>"}.',
        });
        if (!r || !r.success) continue;
        const { update } = parseMaintenanceResponse(toStr(r.output), 700);
        if (!update || update === String(proc.narrative || '').trim()) continue;
        await firestoreWrite('processes', pid, {
          ...proc, narrative: update, version: (Number(proc.version) || 1) + 1,
          updated_at: now(), updated_by: 'temporal-memory', last_refined_from: mission.id,
        });
        log('INFO', `[context-maintenance] refined playbook ${pid} narrative from ${mission.id} (${update.length} chars)`);
      } catch (e) {
        log('WARN', `[context-maintenance] playbook ${pid} refresh failed (non-fatal): ${e.message}`);
      }
    }
  } catch (e) {
    log('WARN', `[context-maintenance] playbook maintenance failed (non-fatal): ${e.message}`);
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

  // ---- Transition guard (platform/contracts/work-transitions.mjs) ----
  // Which moves are legal used to be implicit across ~40 assignment sites. The
  // table is now one authority; this is where terminal transitions consult it.
  //
  // Three modes, because a table asserted over live missions before it has been
  // observed is a way to break work rather than protect it:
  //   observe (default) — record a disagreement, change nothing
  //   enforce           — refuse the write
  //   off               — skip entirely
  // A per-VM override, because the contract's own guidance is "move a canary to
  // enforce once observe is clean" and there was no way to move ONE agent. The
  // contract is fleet-wide, so canarying it meant hand-editing contracts.json on
  // a VM — which the next upgrade overwrites, silently reverting the canary
  // mid-experiment. Same shape as the other canary flags in this system.
  const _tg = process.env.AGENT_TRANSITION_GUARD || CONTRACTS.dispatch?.transition_guard || 'observe';
  if (_tg !== 'off' && envelope.status !== status) {
    const verdict = canTransition(envelope.status, status);
    if (!verdict.allowed) {
      log('WARN', `[TELEMETRY] illegal_transition envelope=${envelope.id} type=${envelope.type} from=${envelope.status} to=${status} reason="${verdict.reason}"`);
      if (_tg === 'enforce') {
        return { ok: false, error: `illegal transition ${envelope.status} → ${status}: ${verdict.reason}` };
      }
    }
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
      const { writeMissionRecord } = await import('../work/mission-record.mjs');
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

  // Step 5b: Context auto-maintenance (RFC §6b) — after a completed mission that touched a project,
  // temporal-memory refreshes that project's context from what just happened. Flag-gated + best-effort
  // (maintainContext self-gates on dispatch.context_maintenance and never throws); never blocks completion.
  if (status === 'complete' && envelope.type === 'M') {
    try { await maintainContext(envelope); } catch (e) {
      log('WARN', `[context-maintenance] hook failed (non-fatal): ${e.message}`);
    }
  }

  // SESSION_CONTEXT_PLAN Phase 3b: responsibility learning feed — durable
  // learnings distilled by mission compaction flow to a Firestore overlay
  // (primes/{id}/responsibility_state/{respId}) that the scheduler merges
  // into the next firing's PRIOR LEARNINGS. The on-disk responsibilities
  // JSON is manifest-managed (upgrades overwrite it), so learnings must
  // never be written there. FIFO-capped; never blocks completion.
  const _respId = envelope.source_meta?.responsibility_id;
  if (_respId && status === 'complete' && envelope._compaction?.durable_learnings?.length) {
    try {
      const overlay = await firestoreRead('responsibility_state', _respId) || {};
      const maxEntries = CONTRACTS.compaction?.learnings_max_entries || 5;
      const existing = (overlay.prior_learnings || '').split('\n').filter(Boolean);
      const today = now().substring(0, 10);
      const additions = envelope._compaction.durable_learnings.slice(0, 2)
        .map(l => `- [${today}] ${toStr(l).substring(0, 300)}`);
      const merged = [...existing, ...additions].slice(-maxEntries);
      await firestoreWrite('responsibility_state', _respId, {
        id: _respId,
        prior_learnings: merged.join('\n'),
        updated_at: now(),
      });
      log('INFO', `[TELEMETRY] learnings_feed responsibility=${_respId} added=${additions.length} total=${merged.length}`);
    } catch (e) {
      log('WARN', `Responsibility learnings feed failed (non-fatal): ${e.message}`);
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

    // Delegation result reply (on complete, blocked, failed, or needs_input — the delegator
    // must know so its checkpoint gate + cortex can react, instead of hanging on a 'waiting' T)
    if (['complete', 'blocked', 'failed', 'needs_input'].includes(status) && envelope.source_meta?.delegation_ref) {
      try {
        // B-2 (C-27): conversational result prose (mouth voices it + appends the tag);
        // trailer dropped from the wire, recovery data stays in Firestore fields (C-5).
        const resultBody = smartTruncate(toStr(envelope.output || envelope.error || envelope.status), RESULT_PREVIEW_CHARS);
        const resultOutputId = generateId('w');
        await firestoreWrite('work', resultOutputId, {
          id: resultOutputId,
          type: 'T',
          parent_id: envelope.id,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'delegation_result',
          title: `Delegation result for ${envelope.source_meta.delegation_ref}`,
          instruction: 'Deliver delegation result (conversational)',
          output: resultBody,
          delegation_ref: envelope.source_meta.delegation_ref,
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
          // C-27/ME-5 (audit HIGH fix): reconcile the T from the delegate's ACTUAL terminal
          // status (`status` is guarded to complete|blocked|failed|needs_input above) — never
          // hardcode 'complete'. Also recover a T the delegator fast-failed on a transient
          // delivery-ping failure (delivery_fast_failed), so a delegate that did the work
          // still completes it (closes the residual post-guard race). Status-accuracy also
          // fixes the pre-existing mislabel where a blocked/failed delegate was written
          // back as a phantom 'complete'. Clear the fail residue on a genuine success.
          const delegSucceeded = (status === 'complete');
          if (delegRef && (delegRef.status === 'waiting' || delegRef.delivery_fast_failed === true)) {
            await firestoreWrite('work', delegRef.id, {
              ...delegRef,
              status: delegSucceeded ? 'complete' : 'failed',
              output: toStr(envelope.output).substring(0, 4000),
              error: delegSucceeded ? null : (envelope.error || (status === 'needs_input' ? 'Delegate needs additional input to proceed' : 'Delegate reported failure')),
              delivery_fast_failed: false,
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

  // SESSION_CONTEXT_PLAN Phase 4: thread-turn retention rides the archival
  // cadence. Digest-before-prune — only turns already folded into a thread
  // summary AND past the retention horizon are deleted.
  if (CONTRACTS.conversation?.thread_ledger_enabled !== false) {
    try {
      const { sweepThreadTurns } = await import('../work/thread-ledger.mjs');
      await sweepThreadTurns({
        projectId: GCP_PROJECT,
        primeId: PRIME_ID,
        getToken: getGceToken,
        config: CONTRACTS.conversation,
        log,
      });
    } catch (e) {
      log('WARN', `thread-turn sweep failed (non-fatal): ${e.message}`);
    }
  }
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

  // ---- Scope to THIS agent's own, in-conversation approvals (leakage fix) ----
  // The query above is prime-wide (every fleet agent's approvals share prime_id).
  // Without scoping, one agent's "approve" pulls the whole fleet's accumulated
  // pending approvals into a disambiguation — or, with "approve all", bulk-resolves
  // unrelated cross-mission/cross-agent gates. When approval_scope_enabled, narrow
  // to the resolving agent's OWN gates (by owner, refined to the same conversation),
  // and void any of MY own gates whose mission is no longer awaiting approval so
  // stale residue stops piling up. Flag OFF ⇒ prior prime-wide behavior, unchanged.
  if (CONTRACTS?.dispatch?.approval_scope_enabled && Array.isArray(pendingApprovals) && pendingApprovals.length > 0) {
    const beforeN = pendingApprovals.length;
    const ctxScope = {
      agentEmail: AGENT_EMAIL || AGENT_ID || undefined,
      space: intake.source_meta?.space || intake.source_meta?.spaceName || undefined,
      channel: intake.source || undefined,
    };
    let scoped = scopeApprovalsToAgent(pendingApprovals, ctxScope);

    // Opportunistic orphan hygiene: void my own pending gates whose envelope is
    // no longer awaiting_approval (superseded / cancelled / already resolved).
    // Best-effort and bounded (the owner-scoped set is small); never throws, and
    // a read/write hiccup keeps the approval (fail-open, never strands a reply).
    const live = [];
    for (const a of scoped) {
      try {
        const env = a.envelopeId ? await firestoreRead('work', a.envelopeId) : null;
        if (env && env.status && env.status !== 'awaiting_approval') {
          await firestoreWrite('approvals', a.id, {
            ...a, status: 'voided', resolvedAt: now(),
            resolvedBy: `brain:scope-gc:${AGENT_ID}`,
            reason: `Auto-voided: envelope ${a.envelopeId} is ${env.status}, not awaiting_approval`,
          });
          log('INFO', `Approval scope-gc: voided orphan ${a.id} (envelope ${a.envelopeId} = ${env.status})`);
        } else {
          live.push(a);
        }
      } catch { live.push(a); }
    }
    scoped = live;

    log('INFO', `Approval scope: ${beforeN} prime-wide → ${scoped.length} own/in-context for ${ctxScope.agentEmail || 'agent'} (space=${ctxScope.space || '-'})`);
    pendingApprovals = scoped;
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
  // and resume the approved checkpoint plan (approvals.mjs) or fail the envelope (rejected).
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

    // Dedup (delegation_ref + owner + type M) is handled inside
    // materializeDelegationMission — single source of truth, shared with the
    // envelope reconciler.

    // Ref validation: verify parent envelope exists
    let parentEnvelope = null;
    try {
      parentEnvelope = await firestoreRead('work', delegationRef);
    } catch { /* ignore */ }
    if (!parentEnvelope) {
      log('WARN', `Delegation ref ${delegationRef} not found in work collection, treating as normal intake`);
      // Fall through to normal classify path
    } else {
      // Materialize the mission from the shared work T. The creation logic is
      // shared with the envelope reconciler (reconcileIncomingDelegations); the
      // authoritative delegation_ref dedup lives inside the helper, so the two
      // pickup paths (this chat-marker path + the envelope poll) never double-create.
      const delegationBody = intake.source_meta.delegation_body || intake.text;
      await materializeDelegationMission({
        ref: delegationRef,
        parentEnvelope,
        delegatedFrom: intake.source_meta.delegated_from || null,
        instruction: delegationBody,
        acceptCriteria: null,
        projectId: intake.source_meta.delegation_project || null,
        sourceChannel: intake.source,
        sourceMeta: intake.source_meta,
        sourceText: sourceText || null,
        ackAddress: addressFromMeta(intake.source_meta, intake.source),
      });
      return;
    }
  }

  // ---- Deterministic approval pre-check (before LLM classify) ----
  // Detects "approve"/"reject" messages and routes them to the existing
  // approval machinery (approvals.mjs → resumeCheckpointPlan), bypassing
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

  // SESSION_CONTEXT_PLAN Phase 4: ledger fill-in — when the channel provided
  // no context (e.g. a GChat thread resumed after the poll window scrolled,
  // or a needs_input reply routed by envelope), the accumulated thread ledger
  // supplies it. Existing paths stay primary: intake-serialized context for
  // GChat (B-32 poll-time serialization), assembleConversation for dashboard.
  if (!convoContext && intake._thread_key && CONTRACTS.conversation?.enabled !== false
      && CONTRACTS.conversation?.thread_ledger_enabled !== false) {
    const { readThread } = await import('../work/thread-ledger.mjs');
    convoContext = await readThread({
      projectId: GCP_PROJECT,
      primeId: PRIME_ID,
      getToken: getGceToken,
      threadKey: intake._thread_key,
      config: CONTRACTS.conversation,
      log,
    });
    if (convoContext) log('INFO', `[TELEMETRY] convo_assembled thread=${intake._thread_key} source=ledger turns=${convoContext.turns?.length || 0}`);
  }

  // conversation-context.mjs emits roles 'admin' | 'prime' and pre-computes the
  // last prime turn — use it; never re-derive against role names that don't exist.
  const lastPrimeReply = convoContext ? (convoContext.last_prime_text || null) : null;

  // Phase 3: Active envelope scan (moved before ACK for mission-aware acknowledgments)
  const activeEnvelopes = await scanActiveEnvelopes();

  // (Quick ack moved to after classify — see below)

  // Memory recall — temporal-memory synthesizes ALL recall into a context packet;
  // organs never receive raw memory layers (temporal is the sole raw-memory consumer).
  // First recall: ambient/pre-classify packet (helps classify route + dedup).
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
    thread_key: intake._thread_key || null, // SESSION_CONTEXT_PLAN Phase 4: thread address rides the envelope
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
    thread_key: intake._thread_key || null, // SESSION_CONTEXT_PLAN Phase 4
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
    thread_key: intake._thread_key || null, // SESSION_CONTEXT_PLAN Phase 4
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
    const res = await callAgent(agentId, { ...payload, _exec: true });
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
    CTX_VERIFY_INPUT,
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

  // Re-enter the normal cortex loop for synthesis/escalation. Pass _skipBatonResume:
  // this re-entry carries the just-run checkpoint RESULTS to cortex — a failed checkpoint
  // must reach cortex (scoped re-plan / synthesize_with_failure / blocked), NOT be
  // re-intercepted by the baton execute-gate and re-run forever (the CP2 resume loop).
  await _processEnvelopeInner(envelope, memory, null, true);
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

  // The mission boundary. A release applied since the last mission takes effect
  // here, and then stays fixed for this mission's whole life (C-32).
  refreshCapabilities(`mission ${envelope.id}`);

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

async function _processEnvelopeInner(envelope, memoryContext, _claimId, _skipBatonResume = false) {
  // Use passed memory context, or recall fresh if not provided
  // Pass this mission's captured resource ledger into recall. On a RESUME the
  // envelope is re-read from Firestore, so identifiers resolved in earlier
  // iterations arrive here even though the working tree was re-cloned and its
  // contents destroyed — which is the whole point of storing them on the envelope.
  const memory = memoryContext || await recallMemory(envelope.instruction, {
    resources: envelope.context?.resources,
  });

  // Phase 5: Initialize shared workspace for this envelope (+ git clone if project)
  await initSharedWorkspace(envelope.id, { projectId: envelope.project_id });

  // ---- Baton pickup: a handed-off mission resumes its pinned spine here, not cortex ----
  // Under the handoff delegation model a mission travels agent→agent. When I dequeue a mission
  // handed to me (it carries a pinned _cp_spine and a _baton), I resume the executor at the first
  // checkpoint assigned to me — I do NOT re-enter cortex to re-plan someone else's mission (the
  // organs understand this; this routing makes it deterministic). 'synthesize'/'handback' fall
  // through to the normal loop, where an all-complete spine lands on the synthesize nudge.
  if (!_skipBatonResume && handoffModelEnabled(CONTRACTS) && Array.isArray(envelope._cp_spine) && envelope._cp_spine.length > 0 && envelope._baton) {
    const _me = AGENT_EMAIL || AGENT_ID;
    const _hop = decideHop(envelope._cp_spine, { me: _me, originator: missionOriginator(envelope) });
    if (_hop.action === 'execute') {
      log('INFO', `[baton] resume mission=${envelope.id} at CP${_hop.index + 1} (assignee=${effectiveAssignee(envelope)}, originator=${missionOriginator(envelope)})`);
      envelope.status = 'active';
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'active', 'brain', `Baton: resuming pinned spine at CP${_hop.index + 1}`);
      const { checkpoints: _cps } = rebuildFromSpine(envelope._cp_spine);
      await executeCheckpointPlanResume(envelope, { checkpointIndex: _hop.index, taskIndex: 0, allResults: [], checkpoints: _cps }, memory);
      return;
    }
  }

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

  // SESSION_CONTEXT_PLAN Phase 5: cortex per-mission session controller.
  // No-op unless session.enabled. The session is a rebuildable cache — any
  // miss falls back to today's stateless full assembly in the SAME iteration,
  // and a consecutive-miss circuit breaker stops attaching for this envelope.
  // Generation counters prevent a stale in-flight request from resurrecting
  // an old transcript; envelope._session carries ids and counters only.
  const _sessEnabled = CONTRACTS.session?.enabled === true;
  const _sessBreaker = CONTRACTS.session?.miss_circuit_breaker || 3;
  let _sess = null; // { id, seq }
  let _sessGen = envelope._session?.generation || 0;
  let _sessMisses = 0;
  let _lastCoercedDecision = null;  // prior turn's coerced decision → next continue's assistant turn
  let _priorResultsSent = 0;        // watermark: how many priorResults the model has already seen

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
    const res = await callAgent(agentId, { ...payload, _exec: true });
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
    ensureProcessesLoaded,
    PROCESSES,
    PROJECTS,
    generateTitle,
    callAgent,
    enforceSchema,
    formatSkillCatalog,
    SKILL_INDEX,
    CAPABILITY_MAP,
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
    CTX_VERIFY_INPUT,
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
    extractVerdict: (await import('../work/verdict.mjs')).extractVerdict,
    fireResponsibilityById,
    getTriggerableResponsibilities,
  };

  // Phase 2.3: Action dispatch table
  const ACTION_HANDLERS = {
    synthesize: handleSynthesize,
    blocked: handleBlocked,
    needs_input: handleNeedsInput,
    status_update: handleStatusUpdate,
    synthesize_with_failure: handleSynthesizeWithFailure,
    delegate: handleDelegate,
    checkpoint_plan: handleCheckpointPlan,
    wait: handleWait,
    trigger_responsibility: handleTriggerResponsibility,
    // Fleet project bootstrap — only offered when enabled (flag / per-VM env). A PM/lead
    // stands up a delivery project from a chat ask, binding it to the origin space.
    ...(projectBootstrapEnabled(CONTRACTS) ? { project_bootstrap: handleProjectBootstrap } : {}),
  };

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    envelope.iteration = iteration;

    // ORGAN_CONTEXT_SHARING_PLAN Phase 4: maintain the shared mission blackboard — a
    // deterministic, git-versioned view of goal + result packets + open items, written to the
    // mission tree each iteration (C-24 substrate, C-5 daemon-maintained). The complete
    // mission trail in one addressable place any organ can read. Non-fatal (B-22).
    if (BLACKBOARD_ENABLED && envelope.type === 'M') {
      try {
        // The mission git workspace (shared/<id>) exists during the mission but is rm'd on
        // finalize (artifacts.mjs) — so mkdir defensively (idempotent when the clone is
        // present) and emit telemetry, which is the only post-mission signal that it wrote.
        const _bbDir = `${CORE_DIR}/shared/${envelope.id}`;
        mkdirSync(_bbDir, { recursive: true });
        const _bb = renderBlackboard(envelope, priorResults, { maxChars: BLACKBOARD_MAX_CHARS, iteration });
        writeFileSync(`${_bbDir}/MISSION.md`, _bb);
        log('INFO', `[TELEMETRY] blackboard_written mission=${envelope.id} iter=${iteration} bytes=${_bb.length}`);
      } catch (e) { log('WARN', `[blackboard] write failed (non-fatal): ${e.message}`); }
    }

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
      // SESSION_CONTEXT_PLAN Phase 5: this rewrites priorResults IN PLACE, so
      // the index watermark (_priorResultsSent) no longer points at the same
      // entries. Close the session — the next decide re-opens over the
      // truncated array with a fresh watermark, so no result is ever dropped
      // from a delta slice. (Mirrors the compaction close.)
      if (_sess) { await closeGatewaySession(_sess.id); _sess = null; }
    }

    // SESSION_CONTEXT_PLAN Phase 3: rolling compaction — at the token
    // threshold, fold the middle iterations into a validated digest and
    // tell the model it rolled (the roll notice below).
    try {
      const compactSeq = await compactMissionContext(envelope, { lastPromptTokens: _lastPromptTokens });
      if (compactSeq > 0) {
        // Phase 5: a compaction rewrites the context the session's history no
        // longer matches — close it; the next iteration re-opens fresh over
        // the compacted state.
        if (_sess) {
          await closeGatewaySession(_sess.id);
          _sess = null;
        }
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
    const decideArgs = {
      envelope: {
        id: envelope.id,
        type: envelope.type,
        instruction: envelope.instruction,
        accept_criteria: envelope.accept_criteria,
        context_summary: envelope.context_summary,
        conversation_context: envelope.conversation_context || null,
      },
      // Trimmed projection above omits source_meta/project_id (context economy); pass the
      // fields the decide-payload builder needs from the FULL envelope explicitly.
      origin_space: missionOriginSpace(envelope),
      project_id: envelope.project_id,
      memory,
      envelope_context: envelopeContext,
      prior_results: priorResults,
      iteration,
      pending_intake_count: queueInfo.count,
      pending_queue: queueInfo.queue,
      brief,
    };

    // SESSION_CONTEXT_PLAN Phase 5: session-first decide. 'open' carries the
    // full context (byte-identical to the stateless assembly, so it is safe
    // even against an old/excluded gateway); 'continue' prepends the prior
    // coerced decision as an assistant turn and ships only the WORKING STATE
    // delta, failing closed to a stateless full call on any miss. On any
    // successful decide the watermark advances to priorResults.length so the
    // NEXT delta carries exactly the results appended since (dispatch results,
    // guard/parse nudges, human context_forward).
    let decision = null;
    if (_sessEnabled && _sessMisses < _sessBreaker) {
      if (!_sess) {
        _sessGen++;
        const sid = `${envelope.id}:cortex:g${_sessGen}`;
        const opened = await callCortex('decide', decideArgs, { id: sid, op: 'open' });
        if (opened && !opened.error && opened._session?.present) {
          _sess = { id: sid, seq: opened._session.seq };
          envelope._session = { id: sid, seq: _sess.seq, generation: _sessGen };
          _lastCoercedDecision = opened._coercedDecision || null;
          _priorResultsSent = priorResults.length;
          log('INFO', `[TELEMETRY] session_open mission=${envelope.id} id=${sid}`);
          decision = opened;
        } else if (opened && !opened.error) {
          // Full-context call, no session materialized (old gateway / flag off
          // server-side) — the decision is valid; count the miss.
          _sessMisses++;
          decision = opened;
        } else {
          _sessMisses++;
        }
      } else {
        const cont = await callCortex('decide', decideArgs, {
          id: _sess.id, op: 'continue', seq: _sess.seq,
          priorDecision: _lastCoercedDecision, sentUpto: _priorResultsSent,
        });
        if (cont?._session_miss || !cont || cont.error) {
          if (cont?.error) {
            // Garbage never poisons a transcript: hard cortex errors reset
            // the session; the stateless fallback below still decides, and the
            // parse-retry nudge (pushed below) rides the next fresh open.
            await closeGatewaySession(_sess.id);
          }
          _sess = null;
          _sessMisses++;
        } else {
          _sess.seq = cont._session?.seq ?? _sess.seq;
          envelope._session = { id: _sess.id, seq: _sess.seq, generation: _sessGen };
          _lastCoercedDecision = cont._coercedDecision || _lastCoercedDecision;
          _priorResultsSent = priorResults.length;
          decision = cont;
        }
      }
    }
    if (!decision) {
      decision = await callCortex('decide', decideArgs);
    }

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

    // ORGAN_CONTEXT_SHARING_PLAN Phase 2: hydrate-on-demand. Cortex read result summaries in
    // the delta; if it needs a result's FULL content to decide, it names the ref(s) in
    // request_context. The daemon fetches them (deterministic, C-5), appends them to
    // prior_results so they ride the next decide delta, and loops WITHOUT dispatching this
    // turn's action. Bounded: each ref fetched at most once per mission, capped by
    // HYDRATE_MAX_REFS, content by HYDRATE_MAX_CHARS. This is how an organ gets complete
    // context instead of re-dispatching work to re-observe a result (B-4 economy preserved:
    // summaries by default, full content only on explicit request).
    if (HYDRATE_ENABLED && Array.isArray(decision.request_context) && decision.request_context.length) {
      envelope._hydrated_refs = envelope._hydrated_refs || [];
      const fresh = decision.request_context
        .filter(r => typeof r === 'string' && r && !envelope._hydrated_refs.includes(r));
      const room = HYDRATE_MAX_REFS - envelope._hydrated_refs.length;
      const toFetch = fresh.slice(0, Math.max(0, room));
      if (toFetch.length) {
        for (const ref of toFetch) {
          let full = '';
          try {
            const doc = await firestoreRead('work', ref);
            full = toStr(doc?.output || doc?.error || '');
          } catch (e) { full = `[hydration error for ${ref}: ${e.message}]`; }
          envelope._hydrated_refs.push(ref);
          priorResults.push({
            agent: 'system',
            task: `hydrated context (ref=${ref})`,
            result: `[FULL CONTENT ref=${ref}]\n${full.slice(0, HYDRATE_MAX_CHARS)}`,
            success: true,
          });
          log('INFO', `[TELEMETRY] context_hydrated mission=${envelope.id} ref=${ref} bytes=${full.length}`);
        }
        continue; // re-decide with the full content now in prior_results
      }
      if (fresh.length) {
        // All requested refs already provided, or the per-mission hydration cap is hit —
        // tell cortex plainly and let this turn's action proceed (never loop on hydration).
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Requested context already provided (or hydration cap of ${HYDRATE_MAX_REFS} reached). Decide from what you already have.`,
        });
      }
    }

    // Prevent self-unblock runaway: after a self-unblock attempt, only allow
    // resolution actions (synthesize, blocked). If Cortex/enforceSchema returns
    // checkpoint_plan, it's stalling — force to blocked.
    //
    // This guard is correct and stays as-is. It once ended a mission that was
    // actually progressing, but the fault was upstream, not here: the checkpoint
    // had "failed" only because cerebellum returned an empty verdict twice and the
    // B-28 fail-closed treated that as a work failure. Loosening a guard that
    // demonstrably stops 5-7 iteration spin loops would trade a rare false block
    // for a common runaway. The fix is to stop producing spurious failures — see
    // the reduced-prompt retry in checkpoint-executor.mjs.
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

    // Deterministic bootstrap steering (project_bootstrap): a mission on a chat space with NO
    // project cannot checkpoint_plan/delegate to success — there is no delivery route, so it
    // loops (checkpoint_plan → delegation can't deliver → re-plan → needs_input). If cortex
    // avoids project_bootstrap here, reject-and-redirect up to twice, then block cleanly rather
    // than loop. Self-disables the instant a project exists for the space (post-bootstrap
    // re-scope makes envelope.project_id carry a gchat_space_id), so delivery planning is untouched.
    if (projectBootstrapEnabled(CONTRACTS)
        && (action === 'checkpoint_plan' || action === 'delegate')
        && (SKILL_INDEX || []).some(s => s.id === 'project-ops')
        && missionOriginSpace(envelope)
        && !(envelope.project_id && PROJECTS[envelope.project_id]?.gchat_space_id)) {
      envelope._pb_nudges = (envelope._pb_nudges || 0) + 1;
      if (envelope._pb_nudges <= 2) {
        log('WARN', `[project_bootstrap] rejecting '${action}' on unlinked space ${missionOriginSpace(envelope)} — redirecting to project_bootstrap (nudge ${envelope._pb_nudges})`);
        priorResults.push({ agent: 'system', result: `[SYSTEM] REJECTED action "${action}": this mission is on GChat space ${missionOriginSpace(envelope)}, which has NO project yet — so "${action}" has no delivery route and cannot succeed (this is why it loops). Respond NOW with { "action": "project_bootstrap", "project": { "name": "...", "goal": "...", "team": [ {"role":"engineer","specialty":"engineer","responsibilities":"..."}, {"role":"devops","specialty":"devops","responsibilities":"..."}, {"role":"designer","specialty":"designer","responsibilities":"..."} ], "canon": [...], "context": [...] } }. The chat this arrived on IS the project's space. Plan/delegate the actual work AFTER the project exists.` });
        continue;
      }
      log('ERROR', `[project_bootstrap] cortex avoided project_bootstrap after 2 redirects on ${envelope.id} — blocking rather than looping`);
      action = 'blocked';
      decision.action = 'blocked';
      decision.blocker = decision.blocker || 'This request needs a new project stood up (its chat space is not linked to any project yet), but the bootstrap step did not run. Create the project from the dashboard, or re-send the request.';
      decision.blocker_type = 'setup_incomplete';
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
        // SESSION_CONTEXT_PLAN Phase 5: every exit door closes the session —
        // suspensions outlive any sane TTL (B-27) and completions are final.
        if (_sess) {
          await closeGatewaySession(_sess.id);
          _sess = null;
        }
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
      result: `[SYSTEM] Invalid action "${action}". Valid actions: checkpoint_plan${(SKILL_INDEX || []).some(s => s.id === 'delegation') ? ', delegate' : ''}, synthesize, synthesize_with_failure, needs_input, blocked, status_update, wait${getTriggerableResponsibilities().length > 0 ? ', trigger_responsibility' : ''}${projectBootstrapEnabled(CONTRACTS) && (SKILL_INDEX || []).some(s => s.id === 'project-ops') ? ', project_bootstrap' : ''}.`,
    });
  }

  // Max iterations reached
  if (_sess) {
    await closeGatewaySession(_sess.id);
    _sess = null;
  }
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

// SESSION_CONTEXT_PLAN Phase 5: explicit gateway-session teardown. Idempotent
// (C-18); a failed DELETE is mopped up by the store's activity TTL.
async function closeGatewaySession(sessionId) {
  try {
    await fetch(GATEWAY_URL.replace('/v1/chat/completions', `/v1/sessions/${encodeURIComponent(sessionId)}`), {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    log('WARN', `session close failed (TTL will mop up): ${e.message}`);
  }
}

// SESSION_CONTEXT_PLAN Phase 4: resolve an intake's thread key and upsert the
// inbound turn into the thread ledger. Dashboard needs_input replies carry no
// address — they resolve through the envelope they answer (thread_key stamp,
// falling back to its delivery_address). Unkeyable intakes are skipped; the
// ledger is a cache, never a gate.
async function ledgerInboundTurn(intake) {
  if (CONTRACTS.conversation?.thread_ledger_enabled === false) return;
  const sm = intake.source_meta || {};
  let address = null;
  if (sm.address?.channel) {
    address = sm.address;
  } else if (intake.source === 'gchat' && (sm.threadName || sm.spaceName)) {
    address = { channel: 'gchat', space: sm.spaceName || null, thread: sm.threadName || null };
  } else if (intake.source === 'dashboard') {
    address = { channel: 'dashboard' };
  }
  let threadKey = threadKeyFor(address, PRIME_ID);
  if (!threadKey && sm.responding_to) {
    const target = await firestoreRead('work', sm.responding_to).catch(() => null);
    threadKey = target?.thread_key
      || threadKeyFor(target?.delivery_address, PRIME_ID)
      || null;
    if (threadKey && !address) address = target?.delivery_address || { channel: 'dashboard' };
  }
  if (!threadKey) return;
  const ok = await ledgerAppendTurn({
    projectId: GCP_PROJECT,
    primeId: PRIME_ID,
    getToken: getGceToken,
    threadKey,
    turnId: sm.channel_msg_id || intake.id,
    role: 'admin',
    text: sm.raw_text || intake.text,
    source: 'intake',
    channelMeta: address || {},
    config: CONTRACTS.conversation,
    log,
  });
  if (ok) {
    intake._thread_key = threadKey;
    log('INFO', `[TELEMETRY] thread_turn_append thread=${threadKey} role=admin source=intake`);
    // Code-triggered thread compaction rides the write path (deterministic
    // count threshold inside compactThread; C-4 — never model-decided).
    compactThread({
      projectId: GCP_PROJECT, primeId: PRIME_ID, getToken: getGceToken,
      threadKey, summarize: (text, instruction, opts) => _vtx.summarize(text, instruction, opts),
      config: CONTRACTS.conversation, log,
    }).catch(e => log('WARN', `thread compaction failed (non-fatal): ${e.message}`));
  }
}

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
        // SESSION_CONTEXT_PLAN Phase 4: ledger the inbound turn at the TRUE
        // claim site — before processIntake's delegation/approval early
        // returns, so those turns enter the thread too. Idempotent by channel
        // message identity; intake retries re-upsert the same turn.
        try {
          await ledgerInboundTurn(intake);
        } catch (e) {
          log('WARN', `thread-ledger inbound append failed (non-fatal): ${e.message}`);
        }
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

/**
 * Materialize the delegate's mission from the delegating agent's shared work T
 * (the durable coordination record — C-27). Shared by the ears-marker intake
 * path and the envelope reconciler. Idempotent within a single brain process
 * (pollLoop serializes the two pickup paths): best-effort dedup on delegation_ref
 * (+ owner + type M) means whichever pickup path runs first wins and the other
 * no-ops. Returns the mission id, or null if deduped / no parent.
 *
 * @param {object} p
 * @param {string}       p.ref            delegation_ref = the delegator's waiting T id
 * @param {object}       [p.parentEnvelope] pre-read parent (skips a read)
 * @param {string|null}  p.delegatedFrom  delegator email
 * @param {string}       p.instruction
 * @param {string|null}  p.acceptCriteria
 * @param {string|null}  p.projectId
 * @param {string}       p.sourceChannel
 * @param {object}       p.sourceMeta
 * @param {string|null}  p.sourceText
 * @param {object|null}  p.ackAddress     address the pickup-ack is delivered to (via Mouth)
 */
async function materializeDelegationMission(p) {
  const meOwner = AGENT_EMAIL || AGENT_ID;
  // Dedup (best-effort, single-process-serialized): at most one M per
  // delegation_ref for this agent. Keyed strictly on delegation_ref + owner +
  // type M — never on instruction similarity. On a query failure, SKIP rather
  // than risk a duplicate (the reconciler retries next poll; the ears path
  // re-fires on the next intake).
  try {
    // STRICT, and that is what makes the catch below reachable. It said "on a
    // query failure, SKIP rather than risk a duplicate" — and query() returned []
    // instead of throwing, so the catch was dead code and the guard it documented
    // did not exist. An outage produced two live missions and two acknowledgements
    // for one delegation.
    const existing = await firestoreQueryStrict('work', [
      { field: 'source_meta.delegation_ref', op: 'EQUAL', value: { stringValue: p.ref } },
    ], { noOrderBy: true });
    if (existing.some(e => e.type === 'M' && e.owner === meOwner)) return null;
  } catch (e) {
    log('WARN', `materializeDelegationMission dedup check failed (${e.message}) — skipping to avoid a duplicate`);
    return null;
  }
  // Parent (the delegator's waiting T) must exist.
  let parent = p.parentEnvelope || null;
  if (!parent) { try { parent = await firestoreRead('work', p.ref); } catch { /* ignore */ } }
  if (!parent) { log('WARN', `Delegation ref ${p.ref} not found — cannot materialize`); return null; }

  const instruction = p.instruction || '';
  const memoryContext = await recallMemory(instruction);
  const envelopeId = generateId('w');
  const envelope = {
    id: envelopeId, type: 'M', parent_id: null, owner: meOwner,
    status: 'queued', intent: 'execute',
    title: `Delegation: ${instruction.substring(0, 80)}`,
    instruction, accept_criteria: p.acceptCriteria || null,
    context_summary: `Delegated from ${p.delegatedFrom || 'unknown'}`,
    output: null, children: [], context_forward: null, error: null,
    source_channel: p.sourceChannel || 'brain',
    source_meta: { ...(p.sourceMeta || {}), delegation_ref: p.ref, delegated_from: p.delegatedFrom || null },
    project_id: (p.projectId && p.projectId !== 'none') ? p.projectId : DEFAULT_PROJECT_ID,
    context: null, source_text: p.sourceText || null,
    created_at: now(), started_at: null, completed_at: null, updated_at: now(),
    iteration: 0, memory_context: memoryContext, delivery_status: 'internal',
  };
  // Write the mission already QUEUED (status set in the literal above) so a later
  // failure in child-registration or the ack can never strand it half-built at
  // 'pending' — where the dedup would treat it as done but dequeueAndProcess
  // (which only runs 'queued') would never execute it.
  await firestoreWrite('work', envelopeId, envelope);
  await writeHistory(envelopeId, null, 'queued', 'brain', `Delegation from ${p.delegatedFrom || 'unknown'} (ref: ${p.ref}) — queued`);
  log('INFO', `Created + queued delegation mission: ${envelopeId} for ref ${p.ref}`);

  // Register as child on the parent (cross-agent Firestore write) — best-effort.
  // C-27/ME-5 concurrency (audit HIGH fix): field-masked append (children + updated_at
  // ONLY) off a FRESH read — never a stale full-object write. The delegator's
  // fast-fail / timeout sweep writes status+error on this SAME T from another daemon;
  // a whole-doc write here off the reconcile-time snapshot would clobber that status
  // (and vice-versa). Disjoint field masks let both writes coexist. Idempotent: if the
  // child is already registered (dedup or a retried poll), don't re-append.
  try {
    const freshParent = await firestoreRead('work', p.ref) || parent;
    const kids = Array.isArray(freshParent.children) ? freshParent.children : [];
    if (!kids.includes(envelopeId)) {
      await firestoreWriteFields('work', p.ref, {
        children: [...kids, envelopeId],
        updated_at: now(),
      });
    }
    log('INFO', `Registered ${envelopeId} as child on parent ${p.ref}`);
  } catch (e) {
    log('WARN', `Failed to register child on parent ${p.ref}: ${e.message}`);
  }

  // Pickup ack, delivered to the delegator by the Mouth (C-27) — best-effort; the
  // mission is already queued, so an ack failure cannot strand it.
  if (p.ackAddress) {
    try {
      await createCT(envelope, {
        checkpointTitle: 'Acknowledge receipt', taskTitle: 'Write acknowledgment',
        taskOutput: 'Delegation received and queued for processing.', taskIntent: 'ack',
        deliveryStatus: 'pending', deliveryAddress: p.ackAddress, ctKey: `ack-${envelopeId}`,
      });
    } catch (e) {
      log('WARN', `Pickup-ack createCT failed for ${envelopeId}: ${e.message}`);
    }
  }
  return envelopeId;
}

/**
 * Envelope-driven delegation pickup (C-27 / ME-5). The durable coordination
 * record is the shared work T the delegating agent wrote (owner=delegator,
 * intent='delegation', source_meta.target_agent_email=<this agent>). This poll
 * materializes the delegate's mission directly from that T — so a delegation
 * survives even if the conversational chat ping is never delivered or seen (the
 * Millie-class failure where a dropped chat message lost the whole delegation).
 * Two-equality query (target_agent_email + status=='waiting') served by the
 * provisioned (source_meta.target_agent_email, status) composite index
 * (firestore.indexes.json) — bounded to OUTSTANDING delegations, so the scan
 * never grows with history. The dedup in materializeDelegationMission keeps this
 * and the ears-marker path from double-creating; both run in this one poll loop,
 * so they never race in-process (best-effort across a restart overlap).
 */
async function reconcileIncomingDelegations() {
  const meEmail = (AGENT_EMAIL || AGENT_ID || '').toLowerCase();
  if (!meEmail) return;
  let tasks;
  try {
    tasks = await firestoreQuery('work', [
      { field: 'source_meta.target_agent_email', op: 'EQUAL', value: { stringValue: meEmail } },
      { field: 'status', op: 'EQUAL', value: { stringValue: 'waiting' } },
    ], { noOrderBy: true });
  } catch (e) { log('WARN', `reconcileIncomingDelegations query failed: ${e.message}`); return; }
  for (const t of (tasks || [])) {
    if (t.intent !== 'delegation') continue; // status==='waiting' is server-filtered
    // Resolve the shared GChat space for the pickup ack (delivered by the Mouth).
    const spaceId = (t.project_id && PROJECTS[t.project_id]?.gchat_space_id) || null;
    const ackAddress = spaceId ? makeAddress('gchat', { space: spaceId }) : null;
    try {
      const mid = await materializeDelegationMission({
        ref: t.id, parentEnvelope: t,
        delegatedFrom: t.owner || null,
        instruction: t.instruction || '',
        acceptCriteria: t.accept_criteria || null,
        projectId: t.project_id || null,
        sourceChannel: 'brain',
        sourceMeta: { delegated_from: t.owner || null },
        sourceText: null,
        ackAddress,
      });
      if (mid) log('INFO', `reconcileIncomingDelegations: materialized ${mid} for waiting delegation ${t.id} from ${t.owner}`);
    } catch (e) {
      log('WARN', `reconcileIncomingDelegations: failed for ${t.id}: ${e.message}`);
    }
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
        // Fast-fail: if the delegation message itself could not be delivered
        // (mouth exhausted its retry budget → delivery_status='failed'),
        // waiting out the full timeout is pointless — the delegate never
        // received anything. Fail the T now so the mission resumes and cortex
        // can re-target or escalate.
        const sendEnvId = waiting.source_meta?.delivery_envelope_id;
        if (sendEnvId) {
          try {
            const sendEnv = await firestoreRead('work', sendEnvId);
            if (sendEnv?.delivery_status === 'failed') {
              // C-27/ME-5: the shared work T is the durable coordination record; the
              // chat ping is best-effort. If the delegate has already materialized a
              // mission from the envelope (a child is registered), a failed ping is
              // moot — failing the T here would strand the delegate's in-flight work.
              //
              // Concurrency (audit HIGH fix): the `children` guard MUST read a FRESH
              // snapshot, not `waiting` (captured up to a full poll cycle earlier at
              // the query) — a child registered in that window is invisible to a stale
              // guard, so a full-doc fail write would drop it and strand completed
              // work. So: re-read here, guard on the fresh snapshot, and write ONLY
              // status/error/completed_at via a field mask so a concurrent child
              // registration (children-only mask) is never clobbered. The residual
              // sub-RTT window (child registers between this re-read and the mask
              // write) is closed downstream — the fail is tagged delivery_fast_failed,
              // and the cross-agent completion treats a fast-failed T as still
              // reconcilable, so a delegate that did the work still completes it.
              const fresh = await firestoreRead('work', waiting.id) || waiting;
              if (fresh.status !== 'waiting') {
                // Already transitioned (completed by the delegate, or otherwise) — leave it.
              } else if (Array.isArray(fresh.children) && fresh.children.length > 0) {
                log('INFO', `Delegation ${waiting.id}: ping delivery failed but a child mission was materialized from the envelope — not failing (envelope is authoritative, C-27)`);
              } else {
                const target = waiting.source_meta?.target_agent_email || 'target';
                log('WARN', `Delegation delivery failed and not yet picked up: ${waiting.id} → ${target}`);
                await firestoreWriteFields('work', waiting.id, {
                  status: 'failed',
                  error: `Delegation could not be delivered to ${target}: ${sendEnv.delivery_error || 'delivery rejected'}. The delegate never received the request.`,
                  completed_at: now(),
                  delivery_fast_failed: true,
                });
                await writeHistory(waiting.id, 'waiting', 'failed', 'brain', 'Delegation delivery failed');
                continue;
              }
            }
          } catch (e) {
            log('WARN', `Delegation delivery check failed for ${waiting.id}: ${e.message}`);
          }
        }
        const ageMs = Date.now() - new Date(waiting.started_at).getTime();
        const timeoutMs = (CONTRACTS.dispatch?.delegation_timeout_hours || 4) * 3600_000;
        if (ageMs > timeoutMs) {
          // Concurrency (audit HIGH fix): mirror the fast-fail path — re-read fresh and
          // write ONLY status/error/completed_at via a field mask, never a full-object
          // write off the stale query snapshot. A delegate completing right at the 4h
          // boundary transitions the T out of 'waiting' and (via the reconciler) may
          // register a child; a stale full-doc write here would clobber that completion
          // and drop the child. Skip if the T is no longer 'waiting'. No
          // delivery_fast_failed marker — a genuine timeout is terminal (the 4h contract
          // expired), not recoverable by a late completion.
          const freshT = await firestoreRead('work', waiting.id) || waiting;
          if (freshT.status !== 'waiting') continue;
          log('WARN', `Delegation timeout: ${waiting.id} waiting for ${Math.round(ageMs / 3600_000)}h`);
          const timeoutError = `Delegation timed out after ${Math.round(ageMs / 3600_000)} hours. Delegate may be offline or stuck.`;
          waiting.error = timeoutError; // consumed by the parent-escalation block below
          await firestoreWriteFields('work', waiting.id, {
            status: 'failed',
            error: timeoutError,
            completed_at: now(),
          });
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

      // UNREADABLE IS NOT FAILED.
      //
      // The comment below — "null child = deleted from Firestore" — is a sound
      // inference ONLY if null means absent. The permissive read returned null for
      // a 500 and a 403 too, so during a read outage every healthy in-flight
      // delegate was pushed as a synthetic FAILED result. That verdict is then
      // acted on irreversibly: the checkpoint is stamped `failed`, the parent is
      // re-queued around a failure that never happened, the re-delegation counter
      // is bumped, and at the cap a human is told "the delegate could not do it".
      // Firestore recovering undoes none of it.
      //
      // So a store failure now abandons THIS parent's check for this pass and
      // concludes nothing. The next tick re-reads. Deferring a verdict costs one
      // poll interval; inventing one costs a mission and a human's trust.
      let unreadable = null;
      for (const childId of children) {
        let child;
        try {
          child = await firestoreReadStrict('work', childId);
        } catch (e) {
          unreadable = `${childId}: ${e.message}`;
          break;
        }

        // Null child = deleted from Firestore (treat as failed)
        if (!child) {
          childResults.push({ agent: 'unknown', task: childId, result: '[FAILED] Envelope deleted from Firestore', success: false });
          continue;
        }

        // Terminal states: complete, failed, archived, cancelled, blocked, needs_input.
        // EXCEPTION (audit interaction w/ 0db2743): a delegation T that is 'failed' ONLY
        // because of a transient delivery-ping fast-fail AND has a materialized child is
        // NOT yet terminal — the reconciler picked it up and the cross-agent completion
        // write-back will still resolve it (recover to complete). Treating it as terminal
        // here would cascade a spurious checkpoint failure for a delegation that actually
        // succeeded. (A fast-failed T with NO child never materialized → genuinely failed,
        // so it stays terminal and the checkpoint doesn't hang.)
        const _fastFailTransient = child.status === 'failed' && child.delivery_fast_failed === true
          && Array.isArray(child.children) && child.children.length > 0;
        if (!_fastFailTransient && (child.status === 'complete' || child.status === 'failed' || child.status === 'archived' || child.status === 'cancelled' || child.status === 'blocked' || child.status === 'needs_input')) {
          // Label by the DELEGATE's email, not the delegation owner (= the delegator);
          // see summarizeDelegationResult (delegation.mjs) for why owner mislabels a
          // completed delegation as a failed self-delegation.
          childResults.push(summarizeDelegationResult(child, toStr));
        } else {
          allChildrenDone = false;
        }
      }

      // A store failure mid-scan leaves childResults PARTIAL, and a partial list is
      // more dangerous than no list: the remaining children look absent, so
      // allChildrenDone stays true and the parent concludes on a subset. Defer.
      if (unreadable) {
        log('WARN', `waiting envelope ${waiting.id}: cannot read a child (${unreadable}) — deferring `
          + `the verdict to the next tick rather than reading an outage as a failure`);
        continue;
      }
      if (!allChildrenDone || childResults.length === 0) continue;

      // All delegated children are done — re-queue the waiting envelope
      log('INFO', `Re-queuing waiting envelope ${waiting.id}: ${childResults.length} delegation(s) complete`);

      // Inject delegation results as context_forward
      const delegationSummary = childResults.map((r, i) =>
        `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result), RESULT_PREVIEW_CHARS)}`
      ).join('\n\n');

      // #2 (C-15/B-28): gate the checkpoint/task status + the mission's resume mode on the
      // delegation OUTCOME. On any non-success, mark the envelope 'failed' and (for a
      // re-queued parent M) clear _cp_progress so cortex re-enters the DECIDE loop on the
      // FAILED context_forward instead of mechanically resuming past the delegation.
      const cAllOk = childResults.every(r => r.success);

      // C-type checkpoint: complete it and re-queue the parent M-type mission
      // (dequeueAndProcess only handles M-type, so a queued C-type is a dead end)
      if (waiting.type === 'C' && waiting.parent_id) {
        waiting.status = cAllOk ? 'complete' : 'failed';
        waiting.output = delegationSummary;
        waiting.updated_at = now();
        await firestoreWrite('work', waiting.id, waiting);
        await writeHistory(waiting.id, 'waiting', waiting.status, 'brain',
          `C-type delegation(s) ${cAllOk ? 'complete' : 'had failures'}, marking checkpoint ${waiting.status}`);

        const parent = await firestoreRead('work', waiting.parent_id);
        if (parent && parent.status === 'active') {
          // FC-B: bound re-delegation of a repeatedly-failing checkpoint (see Phase B twin).
          if (!cAllOk && CONTRACTS?.dispatch?.redelegation_cap_enabled) {
            const cap = CONTRACTS?.dispatch?.redelegation_max ?? 2;
            const key = redelegationKey(waiting);
            const bumped = bumpRedelegation(parent._cp_redeleg, key, cap);
            parent._cp_redeleg = bumped.counters;
            if (bumped.exceeded) {
              const firstFail = childResults.find(r => !r.success) || {};
              log('WARN', `[TELEMETRY] redelegation_capped mission=${parent.id} cp="${key}" attempts=${bumped.attempts}`);
              await completeEnvelope(parent, {
                status: 'needs_input',
                output: composeRedelegationEscalation({
                  goal: parent.goal || parent.instruction,
                  checkpointOutcome: waiting.title || waiting.instruction,
                  agentLabel: firstFail.agent,
                  reason: firstFail.result,
                  attempts: bumped.attempts,
                }),
                historyDetail: `Re-delegation cap (${bumped.attempts}) hit on checkpoint`,
                skipArtifacts: true, skipMemory: true, skipCleanup: true,
              });
              continue;
            }
          }
          parent.status = 'queued';
          parent.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
          if (!cAllOk) parent._cp_progress = null; // force cortex re-entry, not mechanical resume
          parent.updated_at = now();
          await firestoreWrite('work', parent.id, parent);
          await writeHistory(parent.id, 'active', 'queued', 'brain',
            `Checkpoint delegation(s) ${cAllOk ? 'complete' : 'had failures'}, re-queued${cAllOk ? '' : ' for cortex decision'}`);
          log('INFO', `Re-queuing parent mission ${parent.id} after C-type checkpoint delegation (${cAllOk ? 'ok' : 'with failures'})`);
        }
        continue;
      }

      // T-type delegation task under a C checkpoint: mark complete so the parent
      // C can detect all children are terminal. Re-queuing to 'queued' would be a
      // dead end since dequeueAndProcess only handles M-type envelopes.
      if (waiting.type === 'T' && waiting.parent_id && waiting.intent === 'delegation') {
        waiting.status = cAllOk ? 'complete' : 'failed';
        waiting.output = delegationSummary;
        waiting.completed_at = now();
        waiting.updated_at = now();
        await firestoreWrite('work', waiting.id, waiting);
        await writeHistory(waiting.id, 'waiting', waiting.status, 'brain',
          `T-type delegation ${cAllOk ? 'complete' : 'had failures'}, marking ${waiting.status} for parent checkpoint`);
        log('INFO', `Marking delegation task ${waiting.id} ${waiting.status} (parent checkpoint ${waiting.parent_id})`);
        continue;
      }

      waiting.status = 'queued';
      waiting.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
      if (!cAllOk) waiting._cp_progress = null; // force cortex re-entry, not mechanical resume
      waiting.updated_at = now();
      await firestoreWrite('work', waiting.id, waiting);
      await writeHistory(waiting.id, 'waiting', 'queued', 'brain', `Delegation(s) ${cAllOk ? 'complete' : 'had failures'}, re-queued${cAllOk ? '' : ' for cortex decision'}`);
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
          // Same rule as Phase A: unreadable is not failed. See the note there.
          let cpUnreadable = null;
          for (const tcId of cpChildren) {
            let tc;
            try {
              tc = await firestoreReadStrict('work', tcId);
            } catch (e) {
              cpUnreadable = `${tcId}: ${e.message}`;
              break;
            }
            if (!tc) {
              cpResults.push({ agent: 'unknown', task: tcId, result: '[FAILED] Envelope deleted', success: false });
              continue;
            }
            // Same fast-fail transient exception as Phase A: a delivery-fast-failed T with a
            // materialized child will be recovered by the completion write-back — not yet terminal.
            const _tcFastFailTransient = tc.status === 'failed' && tc.delivery_fast_failed === true
              && Array.isArray(tc.children) && tc.children.length > 0;
            if (!_tcFastFailTransient && (tc.status === 'complete' || tc.status === 'failed' || tc.status === 'archived' || tc.status === 'cancelled' || tc.status === 'blocked' || tc.status === 'needs_input')) {
              cpResults.push(summarizeDelegationResult(tc, toStr));
            } else {
              allDone = false;
            }
          }

          if (cpUnreadable) {
            log('WARN', `checkpoint ${child.id}: cannot read a task (${cpUnreadable}) — deferring `
              + `rather than stamping the checkpoint failed`);
            continue;
          }
          if (!allDone || cpResults.length === 0) continue;

          log('INFO', `Re-queuing active mission ${active.id}: checkpoint ${childId} delegations complete (${cpResults.length} results)`);

          const delegationSummary = cpResults.map((r, i) =>
            `Delegation ${i + 1} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result), RESULT_PREVIEW_CHARS)}`
          ).join('\n\n');

          // #2 (C-15/B-28/B-1): gate the checkpoint on delegation OUTCOME, don't stamp it
          // 'complete' unconditionally. If any delegation did not succeed, mark the
          // checkpoint 'failed' AND clear the parent's _cp_progress so the dequeue routes
          // the mission back into the cortex DECIDE loop — which reads the FAILED
          // context_forward and re-plans / escalates — instead of executeCheckpointPlanResume
          // mechanically advancing past the delegation into the next checkpoint blind (the
          // failure mode that let a delegator push a deploy on top of a blocked design).
          const cpAllOk = cpResults.every(r => r.success);
          child.status = cpAllOk ? 'complete' : 'failed';
          child.output = delegationSummary;
          child.updated_at = now();
          await firestoreWrite('work', childId, child);

          // FC-B: bound re-delegation of a repeatedly-failing checkpoint. Unbounded, a
          // delegate that structurally cannot succeed loops — the observed review re-delegated
          // ~6× over 35 min, then false-completed. After the cap, escalate to the operator
          // honestly instead of clearing _cp_progress for yet another cortex → re-delegate round.
          if (!cpAllOk && CONTRACTS?.dispatch?.redelegation_cap_enabled) {
            const cap = CONTRACTS?.dispatch?.redelegation_max ?? 2;
            const key = redelegationKey(child);
            const bumped = bumpRedelegation(active._cp_redeleg, key, cap);
            active._cp_redeleg = bumped.counters;
            if (bumped.exceeded) {
              const firstFail = cpResults.find(r => !r.success) || {};
              log('WARN', `[TELEMETRY] redelegation_capped mission=${active.id} cp="${key}" attempts=${bumped.attempts}`);
              await completeEnvelope(active, {
                status: 'needs_input',
                output: composeRedelegationEscalation({
                  goal: active.goal || active.instruction,
                  checkpointOutcome: child.title || child.instruction,
                  agentLabel: firstFail.agent,
                  reason: firstFail.result,
                  attempts: bumped.attempts,
                }),
                historyDetail: `Re-delegation cap (${bumped.attempts}) hit on checkpoint`,
                skipArtifacts: true, skipMemory: true, skipCleanup: true,
              });
              break;
            }
          }

          active.status = 'queued';
          active.context_forward = `[DELEGATION RESULTS]\n${delegationSummary}`;
          if (!cpAllOk) active._cp_progress = null; // force cortex re-entry, not mechanical resume
          active.updated_at = now();
          await firestoreWrite('work', active.id, active);
          await writeHistory(active.id, 'active', 'queued', 'brain',
            `Checkpoint delegation(s) ${cpAllOk ? 'complete' : 'had failures'}, re-queued${cpAllOk ? '' : ' for cortex decision'}`);
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
    // Route by the mission's current ASSIGNEE (baton model), which shims to `owner` when unset
    // (child-mission model) — so this is behavior-identical until a checkpoint is assigned away.
    const queued = allQueued.filter(e => e.type === 'M' && (effectiveAssignee(e) || '').includes(agentOwner.split('@')[0]));
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
      const memory = await recallMemory(next.instruction, { resources: next.context?.resources });
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
      await reconcileIncomingDelegations();  // ME-5: envelope-driven delegation pickup (runs after intake so the chat-marker path wins when both fire; dedup keeps them from double-creating)
      await checkWaitingEnvelopes();
      await checkApprovedApprovals();
      await checkResponsibilityTriggers();  // operator "Run now" → fire on-demand
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
    firestoreRead,
    firestoreQuery,
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
    resumeCheckpointPlan,
    processEnvelope,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    writeHistory,
    logger: log,
    config: {
      primeId: PRIME_ID,
      gcpProject: GCP_PROJECT,
      agentEmail: AGENT_EMAIL,
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

// On-demand responsibility trigger — shared by the agent path (trigger_responsibility
// action) and the operator path (responsibility_triggers poll). Delegates to the
// scheduler's fireById primitive; ensures the responsibility set is loaded first.
async function fireResponsibilityById(id, opts = {}) {
  if (!_scheduler) _initScheduler();
  if (RESPONSIBILITIES.length === 0) loadResponsibilities();
  return _scheduler.fireById(id, opts);
}

// The curated set of responsibilities a user may ask the agent to run out of
// turn (opt-in via `triggerable: true`). Injected into the Cortex decide payload
// and used by the trigger_responsibility handler to validate the requested id.
function getTriggerableResponsibilities() {
  if (!_scheduler) _initScheduler();
  if (RESPONSIBILITIES.length === 0) loadResponsibilities();
  return RESPONSIBILITIES
    .filter(r => r.enabled !== false && r.triggerable === true)
    .map(r => ({
      id: r.id,
      name: r.name || r.id,
      purpose: (r.context?.purpose || r.instruction || '').substring(0, 160),
    }));
}

// Operator path for on-demand triggers: the dashboard "Run now" control writes a
// pending doc to the top-level `responsibility_triggers` collection; this poll
// (in the 3s pollLoop, beside approvals) claims the ones addressed to this agent,
// fires them via the shared primitive, and writes back a terminal status the
// dashboard reads. The collection may not exist yet — a query miss is benign.
async function checkResponsibilityTriggers() {
  let pending;
  try {
    pending = await firestoreQuery('responsibility_triggers', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ], { noOrderBy: true });
  } catch {
    return; // collection absent / transient — nothing to do
  }
  if (!pending || pending.length === 0) return;

  // Match the trigger doc's agent_id against every form this agent is known by:
  // the brain's env AGENT_ID, the email prefix, and the same hostname-strip the
  // introspect daemon (which writes the doc) uses — so the two agree by construction.
  const emailPrefix = (AGENT_EMAIL || '').split('@')[0];
  const hostAgentId = hostname().replace(/^fleet-/, '');
  const idForms = new Set([AGENT_ID, emailPrefix, hostAgentId].filter(Boolean));
  const mine = pending.filter(t => idForms.has(t.agent_id));
  for (const t of mine) {
    try {
      // Claim first so the next tick can't re-match this doc while it fires.
      await firestoreWrite('responsibility_triggers', t.id, { ...t, status: 'firing', claimed_at: now() });
      const r = await fireResponsibilityById(t.responsibility_id, {
        bypassSpacing: t.bypass_spacing !== false, // default: honor the explicit "now"
        source: 'operator',
      });
      const status = r.ok ? 'fired' : (r.skipped ? 'skipped' : 'error');
      await firestoreWrite('responsibility_triggers', t.id, {
        ...t, status, detail: r.error || r.name || null, fired_at: now(),
      });
      log('INFO', `Responsibility trigger ${t.id} (${t.responsibility_id}) → ${status}${r.error ? ': ' + r.error : ''}`);
    } catch (e) {
      log('WARN', `Responsibility trigger ${t.id} failed: ${e.message}`);
      try { await firestoreWrite('responsibility_triggers', t.id, { ...t, status: 'error', detail: e.message, fired_at: now() }); } catch { /* best-effort */ }
    }
  }
}

main().catch(e => {
  log('ERROR', `Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
