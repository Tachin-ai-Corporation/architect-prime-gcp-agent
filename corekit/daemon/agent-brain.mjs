#!/usr/bin/env node
// ============================================================
// agent-brain.mjs — Brain v3 Orchestration Service
//
// Deterministic orchestration layer between Ears and Mouth.
// Processes Firestore intake records through the Cortex loop
// and manages envelopes (the R/C/M/T work hierarchy).
//
// Phase 7A: responsibilities, quick ack, cron scheduler
//   - Responsibility scheduler: cron-triggered R→M envelope creation
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
import { readFileSync, appendFileSync, existsSync, watchFile, readdirSync } from 'fs';
import { randomBytes } from 'crypto';

// ---- Contracts (loaded first — config depends on it) ----
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

// Brain's own LLM — used ONLY for simple text→text summarization via direct
// Vertex AI calls (not through gateway). Classify/decide/synthesize always use
// cortex through the gateway. See summarizeViaVertex() below.
const BRAIN_MODEL = CONTRACTS.dispatch?.model || 'gemini-2.5-flash';
const BRAIN_ROUTE = CORTEX_ROUTE;  // classify/decide/synthesize always use cortex

// ---- Project contracts config ----
const PROJECT_CONTEXT_MAX_TOKENS = CONTRACTS.projects?.context_max_tokens || 2000;
const PROJECT_PROMOTION_AUTO = CONTRACTS.projects?.promotion_auto || false;
const PROJECT_ARCHIVE_DAYS = CONTRACTS.projects?.archive_completed_after_days || 30;

// ---- Context forwarding budgets (chars per prior step) ----
const CTX_DISPATCH_SUCCESS = CONTRACTS.dispatch?.ctx_dispatch_success || 4000;
const CTX_DISPATCH_FAILURE = CONTRACTS.dispatch?.ctx_dispatch_failure || 3000;
const CTX_AGENT_STEP = CONTRACTS.dispatch?.ctx_agent_step || 8000;
const CTX_CORTEX_STEP = CONTRACTS.dispatch?.ctx_cortex_step || 4000;

// ---- Direct Vertex AI summarization ----
// Brain's own LLM for simple text→text tasks (summarize, compress, rephrase).
// Bypasses the brain gateway entirely — no agent routing, no workspace, no tools.
// Uses GCE metadata server for OAuth2 tokens (same as ears/mouth).

const VERTEX_LOCATION = CONTRACTS.vertex?.location || 'global';
const VERTEX_API_BASE = `https://${VERTEX_LOCATION === 'global' ? '' : VERTEX_LOCATION + '-'}aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models`;

/** Cache for GCE metadata OAuth2 token (auto-refreshes when expired) */
let _gceTokenCache = { token: null, expiresAt: 0 };

async function getGceToken() {
  if (_gceTokenCache.token && Date.now() < _gceTokenCache.expiresAt - 30_000) {
    return _gceTokenCache.token;
  }
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) }
  );
  if (!resp.ok) throw new Error(`GCE metadata token fetch failed: ${resp.status}`);
  const data = await resp.json();
  _gceTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return _gceTokenCache.token;
}

/**
 * Direct Vertex AI call for simple text→text summarization.
 * Bypasses the brain gateway. No agent context, no tools.
 *
 * @param {string} text - The text to summarize/transform
 * @param {string} instruction - What to do with the text (e.g. "Summarize in 2 sentences")
 * @param {object} [opts] - Optional overrides
 * @param {number} [opts.maxTokens=1024] - Max output tokens
 * @param {number} [opts.temperature=0.3] - Temperature
 * @returns {Promise<string>} - The summarized/transformed text
 */
async function summarizeViaVertex(text, instruction, opts = {}) {
  const model = BRAIN_MODEL;
  const maxTokens = opts.maxTokens || 1024;
  const temperature = opts.temperature ?? 0.3;

  log('DEBUG', `summarizeViaVertex: model=${model}, instruction="${instruction.substring(0, 80)}", input=${text.length} chars`);

  try {
    const token = await getGceToken();
    const url = `${VERTEX_API_BASE}/${model}:generateContent`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${instruction}\n\n---\n\n${text}` }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperature,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log('ERROR', `summarizeViaVertex HTTP ${resp.status}: ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    log('DEBUG', `summarizeViaVertex result: ${result.length} chars`);
    return result.trim();
  } catch (err) {
    log('ERROR', `summarizeViaVertex failed: ${err.message}`);
    return null;
  }
}

// ---- Schema enforcement via Gemini structured output ----
const CORTEX_SCHEMAS = {
  classify: {
    type: 'OBJECT',
    properties: {
      classification: { type: 'STRING', enum: ['new_mission', 'attach', 'continue', 'cancel', 'info_only'] },
      instruction:    { type: 'STRING' },
      intent:         { type: 'STRING' },
      reasoning:      { type: 'STRING' },
      attach_to:      { type: 'STRING' },
      accept_criteria:{ type: 'STRING' },
      context_summary:{ type: 'STRING' },
      project_id:     { type: 'STRING' },
      process_id:     { type: 'STRING' },
    },
    required: ['classification', 'reasoning'],
  },
  decide: {
    type: 'OBJECT',
    properties: {
      action:     { type: 'STRING', enum: [
        'checkpoint_plan', 'synthesize', 'synthesize_with_failure',
        'needs_input', 'blocked', 'follow_process', 'status_update',
      ]},
      reasoning:  { type: 'STRING' },
      checkpoints: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        instruction:     { type: 'STRING' },
        accept_criteria: { type: 'STRING' },
        tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          agent:           { type: 'STRING' },
          task:            { type: 'STRING' },
          accept_criteria: { type: 'STRING' },
        }, required: ['agent', 'task'] }},
      }, required: ['instruction', 'tasks'] }},
      synthesis:       { type: 'STRING' },
      failure_summary: { type: 'STRING' },
      question:        { type: 'STRING' },
      what_is_needed:  { type: 'STRING' },
      blocker:            { type: 'STRING' },
      blocker_type:       { type: 'STRING' },
      escalation_message: { type: 'STRING' },
      processId:  { type: 'STRING' },
      parameters: { type: 'OBJECT' },
      message: { type: 'STRING' },
    },
    required: ['action'],
  },
};

async function enforceSchema(cortexRaw, mode) {
  const schema = CORTEX_SCHEMAS[mode];
  if (!schema) return typeof cortexRaw === 'string' ? parseJsonResponse(cortexRaw) : cortexRaw;

  const input = typeof cortexRaw === 'string' ? cortexRaw : JSON.stringify(cortexRaw);
  const prompt = `Restructure this AI decision into the required JSON schema. Preserve ALL semantic content exactly — do not invent, remove, or modify any decisions, instructions, or reasoning. Only restructure to fit the schema.\n\n---\n${input}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await getGceToken();
      const resp = await fetch(`${VERTEX_API_BASE}/${BRAIN_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            maxOutputTokens: 8192,
            temperature: 0.1,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        log('WARN', `enforceSchema attempt ${attempt}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { log('WARN', `enforceSchema attempt ${attempt}: empty response`); continue; }

      const parsed = JSON.parse(text);
      log('DEBUG', `enforceSchema OK (attempt ${attempt}): action=${parsed.action || parsed.classification}`);
      return parsed;
    } catch (err) {
      log('WARN', `enforceSchema attempt ${attempt}: ${err.message}`);
    }
  }

  log('WARN', `enforceSchema failed 2x, falling back to parseJsonResponse`);
  return typeof cortexRaw === 'string' ? parseJsonResponse(cortexRaw) : cortexRaw;
}


function smartTruncate(text, budget) {
  if (!text || text.length <= budget) return text;
  const headBudget = Math.floor(budget * 0.4);
  const tailBudget = Math.floor(budget * 0.4);
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const truncated = text.length - headBudget - tailBudget;
  return `${head}\n[...${truncated} chars truncated...]\n${tail}`;
}

/**
 * Summarize text using the brain's direct Vertex AI LLM.
 * Falls back to smartTruncate if the LLM call fails or times out.
 * @param {string} text - Text to summarize
 * @param {number} budget - Max character budget for the result
 * @param {string} prompt - Summarization instruction optimized for context
 * @returns {Promise<string>} Summarized text
 */
async function smartSummarize(text, budget, prompt) {
  if (!text || text.length <= budget) return text || '';
  try {
    const result = await summarizeViaVertex(text, prompt, { maxTokens: Math.ceil(budget / 3) });
    if (result && result.length > 0) {
      // Ensure result fits budget
      return result.length <= budget ? result : result.substring(0, budget);
    }
  } catch (e) {
    log('WARN', `smartSummarize fallback to truncate: ${e.message}`);
  }
  return smartTruncate(text, budget);
}

/**
 * Generate a human-readable title from instruction text.
 * Takes the first sentence (up to maxLen chars), trimming at word boundaries.
 * Used as heuristic fallback when Cortex doesn't provide a title.
 */
function summarizeTitle(text, maxLen = 80) {
  if (!text) return 'Untitled';
  // Strip GChat context framing headers
  let cleaned = text
    .replace(/^\[Current message[^\]]*\]\s*/i, '')
    .replace(/^\[Chat messages since[^\]]*\]\s*/i, '')
    .replace(/^\[Previous context[^\]]*\]\s*/i, '')
    .replace(/^(User|Someone|Human):\s*/i, '')
    .trim();
  // Strip leading tool-name prefix (e.g. "project-manage update 'tachin-website'")
  cleaned = cleaned.replace(/^```[^\n]*\n?/, '').trim();
  // Take first meaningful sentence (split on period, newline, exclamation, question)
  const firstSentence = cleaned.split(/[.\n!?]/)[0].trim();
  if (!firstSentence) return cleaned.substring(0, maxLen);
  if (firstSentence.length <= maxLen) return firstSentence;
  // Truncate at word boundary
  const truncated = firstSentence.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '…';
}

/**
 * Generate a clean title for an M, C, or T envelope using Gemini Flash.
 * Falls back to summarizeTitle() on failure.
 */
async function generateTitle(text, type = 'mission') {
  if (!text || text.length < 3) return 'Untitled';
  const definitions = {
    mission: 'A MISSION is a strategic goal — the top-level objective being accomplished. ' +
      'Title it as the outcome or deliverable. 5-12 words.',
    checkpoint: 'A CHECKPOINT is a milestone or phase within a mission — a meaningful stage of progress. ' +
      'Title it as the deliverable or verification this phase produces. 5-10 words.',
    task: 'A TASK is an atomic unit of work — a single action performed by one agent. ' +
      'Title it as the specific action being taken. 5-10 words.',
  };
  const prompt = (definitions[type] || definitions.mission) +
    '\nNo quotes, no prefixes, no labels. Just the title.';
  try {
    const result = await summarizeViaVertex(text.substring(0, 1000), prompt, { maxTokens: 30, temperature: 0.3 });
    if (result && result.length > 2 && result.length < 120) {
      return result.replace(/^["']|["']$/g, '').replace(/^(Mission|Checkpoint|Task):\s*/i, '').trim();
    }
  } catch (e) {
    log('DEBUG', `generateTitle failed: ${e.message}`);
  }
  return summarizeTitle(text);
}

/**
 * Create a C→T pair under a parent envelope and return the checkpoint ID.
 * Enforces M→C→T hierarchy for all terminal outputs.
 */
async function createCT(parentEnvelope, { checkpointTitle, taskTitle, taskOutput, taskIntent = 'execute', taskStatus = 'complete', deliveryStatus = 'internal' }) {
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

// ---- Project registry (loaded from Firestore, refreshed periodically) ----
let PROJECTS = {}; // keyed by project id
let _projectsLoadedAt = 0;
const PROJECTS_REFRESH_MS = 60_000;

async function loadProjects() {
  try {
    const token = await getAuthToken();
    if (!token) return;
    const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/projects`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const projects = {};
    for (const doc of (data.documents || [])) {
      const p = firestoreDecode(doc.fields || {});
      if (p.id && p.status !== 'archived') {
        projects[p.id] = p;
      }
    }
    PROJECTS = projects;
    _projectsLoadedAt = Date.now();
    if (Object.keys(projects).length > 0) {
      log('INFO', `Projects loaded: ${Object.keys(projects).join(', ')}`);
    }
  } catch (e) {
    log('WARN', `Failed to load projects: ${e.message}`);
  }
}

async function ensureProjectsLoaded() {
  if (Date.now() - _projectsLoadedAt > PROJECTS_REFRESH_MS) {
    await loadProjects();
  }
}

// ---- Process registry (loaded from local files + Firestore, refreshed periodically) ----
let PROCESSES = {}; // keyed by process id
let _processesLoadedAt = 0;
const PROCESSES_REFRESH_MS = 60_000;

/** Load standard processes bundled with CoreKit (on-disk JSON files). */
function loadLocalProcesses() {
  const localProcs = {};
  const procDir = CORE_DIR + '/corekit/processes';
  try {
    if (!existsSync(procDir)) return localProcs;
    for (const file of readdirSync(procDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const p = JSON.parse(readFileSync(`${procDir}/${file}`, 'utf8'));
        if (p.id && p.status !== 'deprecated') {
          localProcs[p.id] = p;
        }
      } catch (e) {
        log('WARN', `Failed to parse local process ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    log('DEBUG', `Local processes dir not found: ${e.message}`);
  }
  return localProcs;
}

async function loadProcesses() {
  // 1. Load standard processes from local CoreKit files (always available)
  const localProcs = loadLocalProcesses();

  // 2. Load user-defined processes from Firestore (may override local by ID)
  const firestoreProcs = {};
  try {
    const token = await getAuthToken();
    if (token) {
      const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/processes`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        for (const doc of (data.documents || [])) {
          const p = firestoreDecode(doc.fields || {});
          if (p.id && p.status !== 'deprecated') {
            firestoreProcs[p.id] = p;
          }
        }
      }
    }
  } catch (e) {
    log('WARN', `Failed to load Firestore processes: ${e.message}`);
  }

  // 3. Merge: Firestore overrides local (same ID), local provides baseline
  PROCESSES = { ...localProcs, ...firestoreProcs };
  _processesLoadedAt = Date.now();
  const localCount = Object.keys(localProcs).length;
  const fsCount = Object.keys(firestoreProcs).length;
  if (localCount + fsCount > 0) {
    log('INFO', `Processes loaded: ${Object.keys(PROCESSES).join(', ')} (${localCount} local, ${fsCount} firestore)`);
  }
}

async function ensureProcessesLoaded() {
  if (Date.now() - _processesLoadedAt > PROCESSES_REFRESH_MS) {
    await loadProcesses();
  }
}

/**
 * Convert a Process definition into a checkpoint_plan decision payload.
 * Groups steps by checkpointBoundary markers into checkpoints.
 * Substitutes parameters into step titles, descriptions, and context.
 */
function processToCheckpointPlan(process, parameters = {}) {
  const steps = process.steps || [];
  if (steps.length === 0) return null;

  // Substitute parameters in strings
  function substitute(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const [key, value] of Object.entries(parameters)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}|\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
  }

  // Group steps into checkpoints (split on checkpointBoundary: true)
  const checkpoints = [];
  let currentTasks = [];
  let cpIndex = 1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = {
      agent: step.agent || 'motor',
      task: substitute(step.description || step.title),
      accept_criteria: substitute(step.accept_criteria || ''),
      intent: step.intent || 'execute',
      // Carry process metadata for special step types
      _step_type: step.type || 'standard',
      _optional: step.optional || false,
      _specialty: step.specialty || null,
      _approval_message: substitute(step.approval_message || null),
    };
    currentTasks.push(task);

    // Create checkpoint boundary
    if (step.checkpointBoundary || i === steps.length - 1) {
      checkpoints.push({
        instruction: substitute(step.checkpointBoundary
          ? `Checkpoint ${cpIndex}: ${step.title || 'Steps ' + (i - currentTasks.length + 2) + '-' + (i + 1)}`
          : `Process Steps`),
        accept_criteria: '',
        tasks: currentTasks,
      });
      currentTasks = [];
      cpIndex++;
    }
  }

  return {
    action: 'checkpoint_plan',
    checkpoints,
    process_id: process.id,
    process_name: process.name,
    process_version: process.version || 1,
  };
}

// ---- Deterministic Process Executor ----
// Stamps the full M/C/T hierarchy from a process definition and executes
// tasks sequentially without Cortex decide loop involvement.

/**
 * Execute a process deterministically.
 * Creates the full M → C → T envelope hierarchy upfront, then runs
 * each task sequentially. No Cortex involvement in structure or flow.
 *
 * @param {object|null} intake - The intake that triggered this (null if from decide loop)
 * @param {object} decision - Cortex classify/decide result with process info
 * @param {object} memoryContext - Memory context for agent dispatches
 * @param {string} processId - The process ID to execute
 * @param {object|null} existingEnvelope - If called from decide loop, the existing envelope to use as mission
 */
async function executeProcess(intake, decision, memoryContext, processId, existingEnvelope = null) {
  await ensureProcessesLoaded();
  const process = PROCESSES[processId];
  if (!process) {
    log('ERROR', `executeProcess: process '${processId}' not found`);
    return;
  }

  const parameters = decision.parameters || {};

  // Validate required parameters
  const requiredParams = Object.entries(process.parameters || {})
    .filter(([, def]) => def && typeof def === 'object' && def.required && !def.default)
    .map(([key]) => key);
  const missingParams = requiredParams.filter(k => !(k in parameters));
  if (missingParams.length > 0) {
    // Auto-fill missing params from intake/decision text when obvious
    const sourceText = decision.instruction || intake?.text || '';
    for (const param of [...missingParams]) {
      if (sourceText && !parameters[param]) {
        parameters[param] = sourceText;
        missingParams.splice(missingParams.indexOf(param), 1);
        log('INFO', `executeProcess: auto-filled parameter '${param}' from intake text (${sourceText.length} chars)`);
      }
    }
    if (missingParams.length > 0) {
      log('WARN', `executeProcess: missing required parameters after auto-fill: ${missingParams.join(', ')} — falling back to decide loop`);
      return 'fallback_to_decide';
    }
  }

  // Fill defaults for missing optional parameters
  for (const [key, def] of Object.entries(process.parameters || {})) {
    if (!(key in parameters) && def && typeof def === 'object' && def.default !== undefined) {
      parameters[key] = def.default;
    }
  }

  // Convert process to checkpoint structure
  const cpPlan = processToCheckpointPlan(process, parameters);
  if (!cpPlan || !cpPlan.checkpoints || cpPlan.checkpoints.length === 0) {
    log('ERROR', `executeProcess: process '${processId}' has no steps`);
    return;
  }

  log('INFO', `executeProcess: '${process.name}' v${process.version || 1} — ${cpPlan.checkpoints.length} checkpoints, stamping hierarchy`);

  // ---- Step 1: Create or reuse Mission envelope ----
  let mission;
  if (existingEnvelope) {
    mission = existingEnvelope;
    mission.process_id = processId;
    mission.process_version = process.version || 1;
    mission.status = 'active';
    mission.started_at = mission.started_at || now();
    mission.updated_at = now();
  } else {
    const missionId = generateId('w');
    // Extract raw user message for source_text preservation
    const sourceText = intake?.text ? extractCurrentMessage(intake.text) : null;
    mission = {
      id: missionId,
      type: 'M',
      parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'active',
      intent: 'process_execution',
      title: await generateTitle(decision.instruction || process.description || process.name, 'mission'),
      instruction: decision.instruction || intake?.text || `Execute process: ${process.name}`,
      accept_criteria: decision.accept_criteria || `Process '${process.name}' completes all steps successfully.`,
      context_summary: decision.context_summary || process.description || null,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: intake?.source || 'system',
      source_meta: intake?.source_meta || {},
      project_id: decision.project_id || null,
      context: decision.context || null,
      source_text: sourceText || null, // Raw user message — preserved verbatim for child dispatches
      process_id: processId,
      process_version: process.version || 1,
      created_at: now(),
      started_at: now(),
      completed_at: null,
      updated_at: now(),
      iteration: 0,
      memory_context: memoryContext,
      delivery_status: 'internal',
    };
  }

  // Merge process context template into mission context
  if (process.contextTemplate && typeof process.contextTemplate === 'object') {
    const templateCtx = {};
    for (const [key, entry] of Object.entries(process.contextTemplate)) {
      if (entry && typeof entry === 'object') {
        const processed = { ...entry };
        if (processed.name) processed.name = processed.name.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
        if (processed.summary) processed.summary = processed.summary.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
        templateCtx[key] = processed;
      }
    }
    mission.context = mergeContextPackets(mission.context, templateCtx);
  }

  // ---- Step 2: Stamp all C and T envelopes upfront ----
  const checkpointEnvelopes = []; // { cEnvelope, tEnvelopes[] }

  for (let ci = 0; ci < cpPlan.checkpoints.length; ci++) {
    const cp = cpPlan.checkpoints[ci];
    const cpId = generateId('w');
    const cpNum = ci + 1;

    const cEnvelope = {
      id: cpId,
      type: 'C',
      parent_id: mission.id,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'pending',
      intent: 'checkpoint',
      title: await generateTitle(cp.instruction || `Checkpoint ${cpNum}`, 'checkpoint'),
      instruction: cp.instruction || `Checkpoint ${cpNum}`,
      accept_criteria: cp.accept_criteria || '',
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: mission.source_channel || 'system',
      source_meta: {},
      project_id: mission.project_id || null,
      process_id: processId,
      created_at: now(),
      started_at: null,
      completed_at: null,
      updated_at: now(),
      iteration: 0,
    };

    const tEnvelopes = [];
    for (let ti = 0; ti < (cp.tasks || []).length; ti++) {
      const task = cp.tasks[ti];
      const tId = generateId('w');
      const taskNum = ti + 1;
      const stepType = task._step_type || 'standard';

      const tEnvelope = {
        id: tId,
        type: 'T',
        parent_id: cpId,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'pending',
        intent: stepType === 'approval_gate' ? 'approval_gate' : (task.intent || 'execute'),
        title: await generateTitle(task.task || `Step ${cpNum}.${taskNum}`, 'task'),
        instruction: task.task || '',
        accept_criteria: task.accept_criteria || '',
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: mission.source_channel || 'system',
        source_meta: {
          step_type: stepType,
          step_index: ti,
          checkpoint_index: ci,
          agent: task.agent || 'motor',
          optional: task._optional || false,
          specialty: task._specialty || null,
          approval_message: task._approval_message || null,
        },
        project_id: mission.project_id || null,
        process_id: processId,
        created_at: now(),
        started_at: null,
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      tEnvelopes.push(tEnvelope);
      cEnvelope.children.push(tId);
    }

    checkpointEnvelopes.push({ cEnvelope, tEnvelopes });
    mission.children.push(cpId);
  }

  // ---- Step 3: Write everything to Firestore ----
  await firestoreWrite('work', mission.id, mission);
  if (!existingEnvelope) {
    await writeHistory(mission.id, null, 'active', 'brain', `Process '${process.name}' — stamped full hierarchy`);
  }

  for (const { cEnvelope, tEnvelopes } of checkpointEnvelopes) {
    await firestoreWrite('work', cEnvelope.id, cEnvelope);
    await writeHistory(cEnvelope.id, null, 'pending', 'brain', `Checkpoint created (process: ${process.name})`);
    for (const tEnv of tEnvelopes) {
      await firestoreWrite('work', tEnv.id, tEnv);
      await writeHistory(tEnv.id, null, 'pending', 'brain', `Task created (${tEnv.source_meta.step_type})`);
    }
  }

  // Increment process execution count
  try {
    const token = await getAuthToken();
    if (token) {
      const procUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/processes/${processId}`;
      const currentCount = process.execution_count || 0;
      await fetch(procUrl + '?updateMask.fieldPaths=execution_count&updateMask.fieldPaths=last_executed_at', {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          execution_count: { integerValue: String(currentCount + 1) },
          last_executed_at: { stringValue: now() },
        }}),
      });
    }
  } catch (e) { log('DEBUG', `Process execution count update failed: ${e.message}`); }

  log('INFO', `executeProcess: hierarchy stamped — M:${mission.id}, ${checkpointEnvelopes.length} checkpoints, ${checkpointEnvelopes.reduce((s, c) => s + c.tEnvelopes.length, 0)} tasks`);

  // ---- Pre-flight workspace cleanup ----
  const processDoc = PROCESSES[processId];
  const preFlight = processDoc?.pre_flight;
  if (preFlight) {
    log('INFO', `Process ${processId}: running pre-flight check`);
    const preFlightResult = await callAgent('motor', {
      instruction: `[PRE-FLIGHT CHECK]\n${preFlight}`,
      accept_criteria: 'Pre-flight checks completed, workspace ready',
      _missionId: mission.id,
    });
    log('INFO', `Process ${processId}: pre-flight ${preFlightResult.success ? 'passed' : 'FAILED'} (${preFlightResult.durationMs}ms)`);
  }

  // ---- Step 4: Execute the plan ----
  await runProcessPlan(mission, checkpointEnvelopes, memoryContext);
}

/**
 * Mechanical sequential executor for a stamped process plan.
 * Walks through C → T envelopes, dispatches to agents, handles approval gates.
 * No Cortex involvement — purely deterministic.
 *
 * @param {object} mission - The M-envelope
 * @param {Array} checkpointEnvelopes - Array of { cEnvelope, tEnvelopes[] }
 * @param {object} memoryContext - Memory context for agent dispatches
 * @param {number} startCpIndex - Checkpoint index to start from (for resumption)
 * @param {number} startTaskIndex - Task index within the starting checkpoint (for resumption)
 */
async function runProcessPlan(mission, checkpointEnvelopes, memoryContext, startCpIndex = 0, startTaskIndex = 0) {
  let allResults = [];
  let planFailed = false;

  for (let ci = startCpIndex; ci < checkpointEnvelopes.length; ci++) {
    const { cEnvelope, tEnvelopes } = checkpointEnvelopes[ci];
    const cpNum = ci + 1;
    const taskStartIdx = (ci === startCpIndex) ? startTaskIndex : 0;

    // Mark checkpoint active
    cEnvelope.status = 'active';
    cEnvelope.started_at = cEnvelope.started_at || now();
    cEnvelope.updated_at = now();
    await firestoreWrite('work', cEnvelope.id, cEnvelope);
    if (taskStartIdx === 0) {
      await writeHistory(cEnvelope.id, 'pending', 'active', 'brain', `Checkpoint ${cpNum} started`);
    }

    log('INFO', `Process CP${cpNum}/${checkpointEnvelopes.length}: ${tEnvelopes.length} tasks`);

    let cpFailed = false;
    let cpResults = [];

    for (let ti = taskStartIdx; ti < tEnvelopes.length; ti++) {
      const tEnv = tEnvelopes[ti];
      const taskNum = ti + 1;
      const stepType = tEnv.source_meta?.step_type || 'standard';
      const taskAgent = tEnv.source_meta?.agent || 'motor';
      const isOptional = tEnv.source_meta?.optional || false;

      // ---- Approval Gate ----
      if (stepType === 'approval_gate') {
        log('INFO', `Process CP${cpNum} Task ${taskNum}: Approval gate — pausing`);

        const approvalId = generateId('apr');

        // Write approval doc
        try {
          const token = await getAuthToken();
          if (token) {
            const approvalUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/approvals/${approvalId}`;
            await fetch(approvalUrl, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: {
                envelopeId: { stringValue: mission.id },
                checkpointId: { stringValue: cEnvelope.id },
                taskIndex: { integerValue: String(ti) },
                checkpointIndex: { integerValue: String(ci) },
                title: { stringValue: (tEnv.title || '').substring(0, 200) },
                description: { stringValue: tEnv.instruction || tEnv.title || '' },
                processId: { stringValue: mission.process_id || '' },
                processName: { stringValue: PROCESSES[mission.process_id]?.name || '' },
                status: { stringValue: 'pending' },
                requestedAt: { stringValue: now() },
              }}),
            });
          }
        } catch (e) { log('WARN', `Failed to write approval doc: ${e.message}`); }

        // Mark task as awaiting approval
        tEnv.status = 'awaiting_approval';
        tEnv.started_at = now();
        tEnv.updated_at = now();
        tEnv.source_meta.approval_id = approvalId;
        await firestoreWrite('work', tEnv.id, tEnv);
        await writeHistory(tEnv.id, 'pending', 'awaiting_approval', 'brain', `Approval gate: ${tEnv.title}`);

        // Mark checkpoint as awaiting
        cEnvelope.status = 'awaiting_approval';
        cEnvelope.updated_at = now();
        await firestoreWrite('work', cEnvelope.id, cEnvelope);
        await writeHistory(cEnvelope.id, 'active', 'awaiting_approval', 'brain', `Paused at approval gate`);

        // Mark mission as awaiting with resume state
        mission.status = 'awaiting_approval';
        mission.updated_at = now();
        mission.source_meta = {
          ...mission.source_meta,
          paused_approval_id: approvalId,
          paused_checkpoint_index: ci,
          paused_task_index: ti,
        };
        await firestoreWrite('work', mission.id, mission);
        await writeHistory(mission.id, 'active', 'awaiting_approval', 'brain', `Process paused — approval gate`);

        // Build context summary from completed steps
        const priorSteps = [...allResults, ...cpResults];
        const rawStepData = priorSteps.map(r => ({
          step: r.step, agent: r.agent, success: r.success,
          result: (r.result || '').substring(0, 1500),
        }));

        // Use custom approval_message from process definition if available
        const customMessage = tEnv.source_meta?.approval_message || '';
        const approvalTitle = tEnv.title || tEnv.instruction || 'Approval needed';

        // Basic fallback text (used if LLM summarization fails)
        const fallbackText = [
          `⏸ **Approval needed**`,
          ``,
          `**${approvalTitle.substring(0, 200)}**`,
          customMessage ? `\n${customMessage}` : '',
          ``,
          `Approve or reject from the dashboard, or reply \`approve\` / \`reject\` here.`,
        ].filter(Boolean).join('\n');

        // LLM summarization for clean, self-contained approval notification
        const cleanSummary = await summarizeForDelivery('approval_request', fallbackText, {
          steps: rawStepData,
          title: approvalTitle,
          processName: PROCESSES[mission.process_id]?.name || '',
          customMessage,
        });

        const notifOutput = [
          `⏸ **Approval needed**`,
          ``,
          cleanSummary,
          ``,
          `Reply \`approve\` or \`reject\` here, or use the dashboard.`,
        ].join('\n');

        // Send notification
        const notifId = generateId('w');
        await firestoreWrite('work', notifId, {
          id: notifId,
          type: 'T',
          parent_id: null, // Must be null for Mouth to deliver (it skips child envelopes)
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'complete',
          intent: 'notification',
          instruction: 'Approval gate notification',
          output: notifOutput,
          source_channel: mission.source_channel || 'system',
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
          delivery_status: 'pending',
        });

        log('INFO', `Process paused at CP${cpNum} task ${taskNum} — awaiting approval ${approvalId}`);
        return; // Exit — approval handler will resume
      }

      // ---- Standard / spawn_responsibility / delegation task ----
      log('INFO', `Process CP${cpNum} Task ${taskNum}/${tEnvelopes.length}: ${taskAgent} — ${(tEnv.title || '').substring(0, 60)}`);

      // Mark task active
      tEnv.status = 'active';
      tEnv.started_at = now();
      tEnv.updated_at = now();
      await firestoreWrite('work', tEnv.id, tEnv);
      await writeHistory(tEnv.id, 'pending', 'active', 'brain', `Dispatching to ${taskAgent}`);

      // Build instruction with prior results context
      let instruction = tEnv.instruction || '';

      // Prepend project context
      if (mission.project_id) {
        const projCtx = buildProjectContext(mission.project_id, mission.context);
        if (projCtx) {
          instruction = `[PROJECT CONTEXT]\n${projCtx}\n[END PROJECT CONTEXT]\n\n${instruction}`;
        }
      }

      // Add prior results for context
      const priorContext = allResults.length > 0
        ? (await Promise.all(allResults.map(async r => `Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${await smartSummarize(r.result || '', CTX_AGENT_STEP, 'Summarize this agent execution result. Keep key outputs, file paths, resource names, URLs, and error messages. Omit verbose logs and raw command output.')}`))).join('\n\n')
        : null;

      // Dispatch to agent
      const dispatchEnvelope = {
        instruction,
        accept_criteria: tEnv.accept_criteria || '',
        context_summary: tEnv.instruction || '',
        prior_results_context: priorContext,
        memory_context: typeof memoryContext === 'object' ? memoryContext.recalled : memoryContext,
        _missionId: mission.id,
      };

      const result = await callAgent(taskAgent, dispatchEnvelope);

      // Record result
      const stepResult = {
        step: `${cpNum}.${taskNum}`,
        agent: taskAgent,
        task: (tEnv.title || tEnv.instruction || '').substring(0, 150),
        result: result.success
          ? await smartSummarize(result.output || '', CTX_AGENT_STEP, 'Summarize this successful agent execution output. Keep key results, file paths, resource names, and actionable details. Omit verbose logs.')
          : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${await smartSummarize(result.output || '(no output)', CTX_AGENT_STEP, 'Summarize this failed agent output. Keep error details, partial progress, and diagnostic info.')}`,
        success: result.success,
        durationMs: result.durationMs,
      };
      cpResults.push(stepResult);

      // Update task envelope
      tEnv.output = result.success
        ? await smartSummarize(result.output || '', CTX_AGENT_STEP, 'Summarize this task completion output. Keep deliverables, file paths, and key outcomes.')
        : result.error || 'Task failed';
      tEnv.status = result.success ? 'complete' : 'failed';
      tEnv.completed_at = now();
      tEnv.updated_at = now();
      if (result.error) tEnv.error = result.error;
      await firestoreWrite('work', tEnv.id, tEnv);
      await writeHistory(tEnv.id, 'active', tEnv.status, 'brain',
        `${taskAgent}: ${result.success ? 'completed' : 'failed'} (${result.durationMs}ms)`);

      log('INFO', `Process CP${cpNum} Task ${taskNum} ${result.success ? 'completed' : 'FAILED'} (${result.durationMs}ms)`);

      // Retry once on failure (for non-optional tasks)
      if (!result.success && !isOptional) {
        log('INFO', `Process CP${cpNum} Task ${taskNum}: retrying once`);
        const retryResult = await callAgent(taskAgent, {
          ...dispatchEnvelope,
          instruction: `[RETRY — previous attempt failed: ${result.error}]\n\n${instruction}`,
          prior_results_context: [
            priorContext,
            `[PREVIOUS ATTEMPT FAILED] ${result.error}\nOutput: ${await smartSummarize(result.output || '', 500, 'Summarize why this attempt failed. Keep error messages and root cause details.')}`,
          ].filter(Boolean).join('\n\n'),
        });

        if (retryResult.success) {
          log('INFO', `Process CP${cpNum} Task ${taskNum}: retry succeeded`);
          cpResults[cpResults.length - 1] = {
            ...stepResult,
            result: await smartSummarize(retryResult.output || '', CTX_AGENT_STEP, 'Summarize this successful retry output. Keep key results and deliverables.'),
            success: true,
            durationMs: result.durationMs + retryResult.durationMs,
          };
          tEnv.output = await smartSummarize(retryResult.output || '', CTX_AGENT_STEP, 'Summarize this task completion output. Keep deliverables, file paths, and key outcomes.');
          tEnv.status = 'complete';
          tEnv.error = null;
          tEnv.completed_at = now();
          tEnv.updated_at = now();
          await firestoreWrite('work', tEnv.id, tEnv);
          await writeHistory(tEnv.id, 'failed', 'complete', 'brain', `Retry succeeded (${retryResult.durationMs}ms)`);
        } else {
          // Hard failure
          cpFailed = true;
          break;
        }
      }
    }

    // Mark checkpoint complete/failed
    allResults.push(...cpResults);
    cEnvelope.status = cpFailed ? 'failed' : 'complete';
    cEnvelope.completed_at = now();
    cEnvelope.updated_at = now();
    await firestoreWrite('work', cEnvelope.id, cEnvelope);
    await writeHistory(cEnvelope.id, 'active', cEnvelope.status, 'brain',
      `Checkpoint ${cpNum} ${cpFailed ? 'failed' : 'complete'} (${cpResults.length} tasks)`);

    log('INFO', `Process CP${cpNum} ${cpFailed ? 'FAILED' : 'complete'} (${cpResults.length} tasks)`);

    // ---- Automatic checkpoint verification ----
    if (!cpFailed && cpResults.length > 0) {
      const verifySummary = cpResults.map(r => `Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${(r.result || '').substring(0, 500)}`).join('\n\n');
      const verifyInstruction = [
        `[CHECKPOINT VERIFICATION]`,
        `The following steps just completed. Verify their work is actually correct — don't just check that commands succeeded, verify the OUTCOMES are what was intended.`,
        ``,
        verifySummary,
        ``,
        `Check:`,
        `1. Are the outputs/artifacts actually correct? (e.g., if a URL was generated, fetch it and verify the content)`,
        `2. Is there stale state from previous runs that might have interfered?`,
        `3. Do the results match what the step instructions asked for?`,
        ``,
        `If everything checks out, respond with VERIFIED and a brief summary.`,
        `If something is wrong, respond with FAILED and describe exactly what's wrong and what you found.`,
      ].join('\n');

      log('INFO', `Process CP${cpNum}: running automatic verification`);
      const verifyResult = await callAgent('motor', {
        instruction: verifyInstruction,
        accept_criteria: 'Verification result with evidence',
        _missionId: mission.id,
        memory_context: typeof memoryContext === 'object' ? memoryContext.recalled : memoryContext,
      });

      if (verifyResult.success && verifyResult.output) {
        const verifyOutput = (verifyResult.output || '').toUpperCase();
        if (verifyOutput.includes('FAILED') || verifyOutput.includes('INCORRECT') || verifyOutput.includes('WRONG')) {
          log('WARN', `Process CP${cpNum}: verification FAILED — ${(verifyResult.output || '').substring(0, 200)}`);
          // Store verification failure in checkpoint and treat as checkpoint failure
          cEnvelope.status = 'failed';
          cEnvelope.error = `Verification failed: ${(verifyResult.output || '').substring(0, 500)}`;
          cEnvelope.updated_at = now();
          await firestoreWrite('work', cEnvelope.id, cEnvelope);
          await writeHistory(cEnvelope.id, 'complete', 'failed', 'brain', `Verification failed`);
          cpFailed = true;
        } else {
          log('INFO', `Process CP${cpNum}: verification PASSED`);
        }
      }
    }

    if (cpFailed) {
      planFailed = true;
      break;
    }
  }

  // ---- Step 5: Auto-complete the mission ----
  const processName = PROCESSES[mission.process_id]?.name || mission.process_id;
  const totalTasks = allResults.length;
  const successTasks = allResults.filter(r => r.success).length;

  if (planFailed) {
    const failedStep = allResults.find(r => !r.success);
    mission.output = [
      `❌ Process "${processName}" failed at step ${failedStep?.step || '?'}.`,
      '',
      ...allResults.map((r, i) => `${i + 1}. **${r.task}** (${r.agent}): ${r.success ? '✅' : '❌'} ${(r.result || '').substring(0, 150)}`),
      '',
      `Failed: ${failedStep?.result || 'Unknown error'}`,
    ].join('\n');
    mission.status = 'blocked';
    mission.blocker = `Process step failed: ${failedStep?.task || 'unknown'}`;
    mission.blocker_type = 'task_failure';
    mission.blocked_at = now();
  } else {
    mission.output = [
      `✅ Process "${processName}" completed successfully (${successTasks}/${totalTasks} tasks).`,
      '',
      ...allResults.map((r, i) => `${i + 1}. **${r.task}** (${r.agent}): ✅ ${(r.result || '').substring(0, 150)}`),
    ].join('\n');
    mission.status = 'complete';
    mission.completed_at = now();
  }

  mission.updated_at = now();
  if (!mission.parent_id) mission.delivery_status = 'pending';
  await firestoreWrite('work', mission.id, mission);
  await writeHistory(mission.id, 'active', mission.status, 'brain',
    `Process ${planFailed ? 'blocked' : 'complete'}: ${processName} (${successTasks}/${totalTasks} tasks)`);

  log('INFO', `Process "${processName}" ${planFailed ? 'BLOCKED' : 'COMPLETE'}: ${successTasks}/${totalTasks} tasks`);

  // Write to memory
  await writeMemory(mission);

  // Context promotion for project-scoped missions
  if (mission.project_id && mission.type === 'M' && mission.context) {
    await suggestContextPromotions(mission);
  }
}

/**
 * Resume a process plan after an approval gate.
 * Loads the child C/T envelopes from Firestore and continues execution
 * from the task after the approval gate.
 *
 * @param {object} mission - The M-envelope with paused_checkpoint_index/paused_task_index
 */
async function resumeProcessPlan(mission) {
  const ci = mission.source_meta?.paused_checkpoint_index;
  const ti = mission.source_meta?.paused_task_index;

  if (ci === undefined || ti === undefined) {
    log('ERROR', `resumeProcessPlan: missing resume state on mission ${mission.id}`);
    return;
  }

  log('INFO', `resumeProcessPlan: resuming ${mission.id} from CP${ci + 1} task ${ti + 2}`);

  // Clean up paused state
  delete mission.source_meta.paused_approval_id;
  delete mission.source_meta.paused_checkpoint_index;
  delete mission.source_meta.paused_task_index;
  mission.status = 'active';
  mission.updated_at = now();
  await firestoreWrite('work', mission.id, mission);
  await writeHistory(mission.id, 'awaiting_approval', 'active', 'brain', 'Approval granted — resuming');

  // Load all child envelopes to reconstruct the plan
  const allChildren = [];
  for (const childId of (mission.children || [])) {
    const child = await firestoreRead('work', childId);
    if (child) allChildren.push(child);
  }

  // Reconstruct checkpointEnvelopes structure
  const checkpointEnvelopes = [];
  for (const cEnv of allChildren.filter(c => c.type === 'C').sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))) {
    const tEnvelopes = [];
    for (const tId of (cEnv.children || [])) {
      const tEnv = await firestoreRead('work', tId);
      if (tEnv) tEnvelopes.push(tEnv);
    }
    // Sort by created_at to preserve order
    tEnvelopes.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    checkpointEnvelopes.push({ cEnvelope: cEnv, tEnvelopes });
  }

  if (checkpointEnvelopes.length === 0) {
    log('ERROR', `resumeProcessPlan: no checkpoint envelopes found for mission ${mission.id}`);
    return;
  }

  // Mark the approval gate task as complete
  if (checkpointEnvelopes[ci] && checkpointEnvelopes[ci].tEnvelopes[ti]) {
    const approvalTask = checkpointEnvelopes[ci].tEnvelopes[ti];
    approvalTask.status = 'complete';
    approvalTask.output = 'Approval granted';
    approvalTask.completed_at = now();
    approvalTask.updated_at = now();
    await firestoreWrite('work', approvalTask.id, approvalTask);
    await writeHistory(approvalTask.id, 'awaiting_approval', 'complete', 'brain', 'Approval granted');
  }

  // Recall memory for context
  const memoryContext = await recallMemory(mission.instruction);

  // Resume from the task AFTER the approval gate
  await runProcessPlan(mission, checkpointEnvelopes, memoryContext, ci, ti + 1);
}


// Context entry kinds and their display icons
const CONTEXT_KIND_LABELS = {
  drive_folder: 'drive_folder', sheet: 'sheet', doc: 'doc',
  dataset: 'dataset', url: 'url', template: 'template',
  people: 'people', convention: 'convention',
};

/**
 * Merge two context packets (maps of key→entry). Child wins on key collision.
 * Both inputs are { key: { kind, ref, url, name, summary, updatedAt, updatedBy } }
 */
function mergeContextPackets(parentCtx, childCtx) {
  if (!parentCtx && !childCtx) return {};
  if (!parentCtx) return { ...(childCtx || {}) };
  if (!childCtx) return { ...(parentCtx || {}) };
  return { ...parentCtx, ...childCtx }; // shallow by key — child overrides
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

/**
 * Build full project context for injection into agent dispatches.
 * Merges project-level context with optional envelope-level context.
 * Returns null if no project found.
 */
function buildProjectContext(projectId, envelopeContext = null) {
  if (!projectId || !PROJECTS[projectId]) return null;
  const p = PROJECTS[projectId];
  const projectCtx = p.context || {};
  const mergedCtx = mergeContextPackets(projectCtx, envelopeContext);

  const header = [`## Project Context: ${p.name || p.id}`];
  if (p.description) header.push(`Description: ${p.description}`);
  header.push('');

  const rendered = renderContextPacket(mergedCtx);
  if (!rendered && !p.description) return null;

  return header.join('\n') + rendered;
}

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
        log('INFO', `Context backfill: ${key} → ref=${match[1]}`);
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
const _fileCache = new Map(); // path → { content, readAt }
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

// ---- Responsibility config ----
let RESPONSIBILITIES = [];
function loadResponsibilities() {
  const files = [
    CORE_DIR + '/corekit/responsibilities.json',
    CORE_DIR + '/corekit/responsibilities-job.json',
  ];
  const merged = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      for (const r of (data.responsibilities || [])) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          merged.push(r);
        }
      }
    } catch { /* file may not exist */ }
  }
  RESPONSIBILITIES = merged;
  if (merged.length > 0) {
    log('INFO', `Responsibilities loaded: ${merged.map(r => r.id).join(', ')}`);
  }
}
loadResponsibilities();

// ---- Firestore REST helpers ----
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;

async function getAuthToken() {
  try {
    const resp = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    const data = await resp.json();
    return data.access_token;
  } catch (e) {
    log('ERROR', `Failed to get auth token: ${e.message}`);
    return null;
  }
}

function firestoreEncode(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'string') {
      fields[k] = { stringValue: v };
    } else if (typeof v === 'number') {
      fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (Array.isArray(v)) {
      fields[k] = { arrayValue: { values: v.map(item => ({ stringValue: String(item) })) } };
    } else if (v instanceof Date) {
      fields[k] = { timestampValue: v.toISOString() };
    } else if (typeof v === 'object') {
      fields[k] = { mapValue: { fields: firestoreEncode(v) } };
    }
  }
  return fields;
}

function firestoreDecode(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if ('stringValue' in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = parseInt(v.integerValue);
    else if ('doubleValue' in v) obj[k] = v.doubleValue;
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue' in v) obj[k] = null;
    else if ('timestampValue' in v) obj[k] = v.timestampValue;
    else if ('arrayValue' in v) {
      obj[k] = (v.arrayValue.values || []).map(item => {
        if ('mapValue' in item) return firestoreDecode(item.mapValue.fields || {});
        if ('stringValue' in item) return item.stringValue;
        if ('integerValue' in item) return parseInt(item.integerValue);
        if ('booleanValue' in item) return item.booleanValue;
        if ('doubleValue' in item) return item.doubleValue;
        if ('nullValue' in item) return null;
        if ('timestampValue' in item) return item.timestampValue;
        if ('arrayValue' in item) return (item.arrayValue.values || []).map(sub => sub.stringValue || sub.integerValue || '');
        return '';
      });
    } else if ('mapValue' in v) {
      obj[k] = firestoreDecode(v.mapValue.fields);
    }
  }
  return obj;
}

async function firestoreWrite(collection, docId, data) {
  const token = await getAuthToken();
  if (!token) return null;
  const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/${collection}/${docId}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: firestoreEncode(data) }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Firestore write failed: ${resp.status} ${text}`);
    return null;
  }
  return await resp.json();
}

async function firestoreRead(collection, docId) {
  const token = await getAuthToken();
  if (!token) return null;
  const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/${collection}/${docId}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const doc = await resp.json();
  return firestoreDecode(doc.fields || {});
}

async function firestoreQuery(collection, filters) {
  const token = await getAuthToken();
  if (!token) return [];
  const parentPath = `${FIRESTORE_BASE}/primes/${PRIME_ID}`;
  const url = `${parentPath}:runQuery`;
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(f => ({
          fieldFilter: {
            field: { fieldPath: f.field },
            op: f.op,
            value: f.value,
          }
        })),
      }
    },
    orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'ASCENDING' }],
    limit: 300,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Firestore query failed: ${resp.status} ${text}`);
    return [];
  }
  const results = await resp.json();
  return results
    .filter(r => r.document)
    .map(r => ({
      id: r.document.name.split('/').pop(),
      ...firestoreDecode(r.document.fields || {}),
    }));
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

  return enforceSchema(content, mode);
}

function buildSystemPrompt(mode, payload) {
  const parts = [];

  // 1. Read SOUL.md — core decision-making guidance
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
    parts.push(`[SOUL — core decision-making guidance]\n${soulContent}`);
  }

  // 2. Read IDENTITY.md — who you are
  const identityPaths = [
    CORE_DIR + `/workspace-${AGENT_ID}/IDENTITY.md`,
    CORE_DIR + '/workspace-devops/IDENTITY.md',
    CORE_DIR + '/workspace/IDENTITY.md',
  ];
  let identityContent = null;
  for (const p of identityPaths) {
    identityContent = cachedReadFile(p);
    if (identityContent) break;
  }
  if (identityContent) {
    parts.push(`[IDENTITY — who you are]\n${identityContent}`);
  }

  // 3. Read MEMORY.md — baseline knowledge
  const memoryPaths = [
    CORE_DIR + `/workspace-${AGENT_ID}/MEMORY.md`,
    CORE_DIR + '/workspace-devops/MEMORY.md',
    CORE_DIR + '/workspace/MEMORY.md',
  ];
  let memoryContent = null;
  for (const p of memoryPaths) {
    memoryContent = cachedReadFile(p);
    if (memoryContent) break;
  }
  if (memoryContent) {
    parts.push(`[MEMORY — baseline knowledge]\n${memoryContent}`);
  }


  // 4. Agent registry with tool descriptions
  parts.push(`[AGENT REGISTRY — available agents and their capabilities]\n${JSON.stringify(REGISTRY.agents, null, 2)}`);

  // 5. Project registry (if any projects exist)
  if (Object.keys(PROJECTS).length > 0) {
    const projectSummary = Object.values(PROJECTS).map(p => ({
      id: p.id, name: p.name, status: p.status, description: p.description,
      context: p.context || {},
    }));
    parts.push(`[PROJECT REGISTRY — active work streams with context]\nEach project carries context that applies to all missions within it. When classifying or deciding, identify the relevant project and use its context.\n${JSON.stringify(projectSummary, null, 2)}`);
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
        blocked_missions: 'If a blocked mission exists and the user message addresses the blocker or asks to retry/fix/continue the work, classify as "continue" with continue_mission set to the mission ID. Do NOT classify as "attach" for blocked missions — use "continue" instead.',
        attach_vs_continue: '"attach" = follow-up info or new instruction for active/waiting work. "continue" = resume blocked/stalled work or retry after failure.',
        dedup_prevention: 'CRITICAL: If a recent_completed_mission has a very similar instruction to the new inbound message (same goal/action), do NOT create a new_mission. Instead classify as \"info_only\" and reference the prior result, or classify as \"attach\" to add follow-up context. Only create new_mission if the inbound is genuinely different work.',
        project_identification: 'If the work matches a known project from the project_registry, set project_id in your response. Not every piece of work belongs to a project.',
        required_processes: 'CRITICAL: Projects may define required_processes — activities that MUST go through a specific process. When classifying, if any part of the instruction matches a required_process description on a project, you MUST set project_id to that project. On the decide step, the required process will be surfaced for you to follow.',
      },
    };
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
    // Task decomposition guidance — enforce checkpoint_plan structure
    decidePayload.dispatch_guidance = {
      rule: 'ALL work MUST use checkpoint_plan. One focused task per task entry. Even single-step work is one checkpoint with one task.',
      bad_example: 'Step 1: check health. Step 2: read logs. Step 3: create file.',
      good_example: 'checkpoint_plan with separate checkpoints for research, implementation, and verification — each containing atomic tasks.',
      reasoning: 'Each motor task has a limited step budget. Atomic tasks prevent timeouts and preserve context on failure. The M→C→T hierarchy ensures progress tracking and enables re-planning on failure.',
    };
    return JSON.stringify(decidePayload);
  }
  return JSON.stringify(payload);
}

// ---- Response parser (hardened for Phase 2) ----
function parseJsonResponse(raw) {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Strip legacy Action: blocks that may follow JSON
  cleaned = cleaned.replace(/\nAction:.*$/s, '');

  // Try bracket-balanced JSON extraction
  const extracted = extractBalancedJson(cleaned);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (parsed.action) return parsed;
    } catch {}
  }

  // Try greedy regex match
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      log('WARN', `JSON parse failed (greedy): ${e.message}`);
    }
  }

  // Fallback: try the whole string
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    log('ERROR', `Could not parse Cortex response: ${raw.substring(0, 300)}`);
    return { error: 'parse_failed', raw: raw.substring(0, 500) };
  }
}

function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.substring(start, i + 1);
        return candidate;
      }
    }
  }
  return null;
}

// ---- Gateway HTTP dispatch to agents ----
// ---- Notification summarizer ----
// Type-specific summarization for outbound notifications.
// Some types need LLM to distill raw data; others pass through.
const SUMMARY_TYPES = {
  approval_request: {
    llm: true,
    maxChars: 1500,
    prompt: (ctx) => [
      `You are writing a concise approval request notification for a human reviewer.`,
      `Summarize the completed work into a clean, self-contained message.`,
      ``,
      `RULES:`,
      `- 3-8 sentences max, under ${ctx.maxChars || 1500} characters`,
      `- Include ALL relevant URLs, links, and artifact references inline`,
      `- The reader must NOT need any prior context — everything self-contained`,
      `- State what was done, what the outcome is, and what happens next if approved`,
      `- NEVER say "see above", "the link from earlier", or reference prior messages`,
      `- Do NOT include raw command output, JSON blobs, or deployment logs`,
      `- Do NOT include step numbers, agent names (motor, cerebellum), or internal jargon`,
      `- Use markdown for readability (bold for key items, links clickable)`,
      ``,
      ctx.processName ? `PROCESS: ${ctx.processName}` : '',
      ctx.title ? `APPROVAL TITLE: ${ctx.title}` : '',
      ctx.customMessage ? `CUSTOM CONTEXT: ${ctx.customMessage}` : '',
      ``,
      `COMPLETED STEPS:`,
      JSON.stringify(ctx.steps, null, 2),
    ].filter(Boolean).join('\n'),
  },
  status_update: { llm: false },  // Pass through — already human-readable
  error_report: { llm: false },   // Pass through — errors should be precise
};

/**
 * Summarize raw notification data for delivery.
 * @param {string} type - Summary type key (e.g. 'approval_request')
 * @param {string} rawText - Fallback text if LLM is skipped or fails
 * @param {object} context - Type-specific context (steps, title, processName, etc.)
 * @returns {string} Clean, delivery-ready text
 */
async function summarizeForDelivery(type, rawText, context = {}) {
  const config = SUMMARY_TYPES[type];
  if (!config || !config.llm) {
    // No LLM needed — return raw text as-is
    return rawText;
  }

  const maxChars = config.maxChars || 1500;
  const promptText = config.prompt({ ...context, maxChars });

  try {
    const instruction = 'You are a notification writer. Return ONLY the notification text — no JSON, no markdown fences, no preamble.';
    const content = await summarizeViaVertex(promptText, instruction, { maxTokens: 2048 });

    if (content && content.length > 0) {
      // Strip any markdown fences or JSON wrapping the LLM might add
      const cleaned = content.replace(/^```[a-z]*\s*/gi, '').replace(/\s*```$/g, '').trim();
      log('INFO', `summarizeForDelivery(${type}): ${cleaned.length} chars (from ${JSON.stringify(context.steps || []).length} chars raw)`);
      return cleaned.substring(0, maxChars);
    }

    log('WARN', `summarizeForDelivery(${type}): empty response — falling back to raw`);
    return rawText;
  } catch (e) {
    log('WARN', `summarizeForDelivery(${type}) error: ${e.message} — falling back to raw`);
    return rawText;
  }
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
    ? `\n\n## Workspace\nWrite ALL files to \`shared/${workspaceId}/\` — this directory persists across sessions. Before using files from a prior step, verify they exist with \`ls shared/${workspaceId}/\`.`
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
    // Cerebellum FAIL verdict — agent returned successfully but the verification failed
    if (content.includes('"verdict"') && content.includes('"FAIL"')) {
      log('WARN', `Agent ${agentId} returned FAIL verdict — treating as failure`);
      return { success: false, output: content, error: 'Verification FAIL verdict', durationMs };
    }

    // Motor tool failure — agent returned successfully but reports the command failed
    // Only apply to motor-class agents (not memory agents whose stored content may echo error keywords)
    const FAILURE_PATTERN_AGENTS = ['motor', 'verifier'];
    if (FAILURE_PATTERN_AGENTS.includes(agentId)) {
      const failurePatterns = [
        /\berror\b.*\b(?:DWD|token|auth|permission|denied|unauthorized)\b/i,
        /\bfailed\b.*\b(?:execute|command|operation)\b/i,
        /\b(?:command|tool)\b.*\bfailed\b/i,
        /exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]/i,
      ];
      for (const pattern of failurePatterns) {
        if (pattern.test(content)) {
          log('WARN', `Agent ${agentId} output contains failure pattern: ${pattern} — treating as failure`);
          return { success: false, output: content, error: 'Agent reported tool failure', durationMs };
        }
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

// ---- Memory: write completed work via temporal-memory agent ----
async function writeMemory(envelope) {
  try {
    const summary = [
      `Request: ${envelope.instruction}`,
      `Type: ${envelope.type}`,
      `Result: ${(envelope.output || '').substring(0, 1500)}`,
      `Envelope: ${envelope.id}`,
      `Completed: ${envelope.completed_at}`,
    ].join('\n');

    log('INFO', `Memory write: envelope ${envelope.id}`);
    const result = await callAgent('temporal-memory', {
      instruction: `Store this completed work in memory:\n${summary}`,
      accept_criteria: 'Acknowledge storage',
    });
    log('INFO', `Memory write: ${result.success ? 'OK' : 'failed'} (${result.durationMs}ms)`);

    // Mark envelope as memory-reconciled so archival knows it's safe to archive.
    // IMPORTANT: Use targeted updateMask to avoid overwriting delivered_at set by mouth.
    if (result.success) {
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
    } else {
      log('WARN', `Memory write returned failure for ${envelope.id}: ${result.error || 'unknown'} — output preview: ${(result.output || '').substring(0, 150)}`);
    }
  } catch (e) {
    log('WARN', `Memory write failed: ${e.message}`);
  }
}

// ---- Active envelope scan: query for in-progress work ----
async function scanActiveEnvelopes() {
  try {
    // Query all live statuses — active, waiting, needs_input, blocked
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

// ---- Status update delivery (transient, for Mouth to pick up) ----
async function deliverStatusUpdate(envelopeId, message) {
  const statusId = generateId('status');
  await firestoreWrite('work', statusId, {
    id: statusId,
    type: 'T',
    parent_id: envelopeId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete',
    intent: 'status_update',
    instruction: 'Status update',
    output: message,
    source_channel: 'system',
    source_meta: {},
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
  log('INFO', `Status update written: ${statusId} — ${message.substring(0, 80)}`);
}

// ---- Periodic envelope archival ----
// Archives: failed (>STALE_CLEANUP_HOURS), complete (>STALE_CLEANUP_HOURS or immediately if child), stale needs_input (>NEEDS_INPUT_TIMEOUT_HOURS), cancelled (>STALE_CLEANUP_HOURS)
// NOTE: blocked envelopes are NEVER archived — they stay alive indefinitely for resumption
async function archiveEnvelopes() {
  log('INFO', 'Running envelope archival sweep...');
  let totalArchived = 0;
  try {
    // 1. Failed envelopes older than STALE_CLEANUP_HOURS
    const failedCutoff = new Date(Date.now() - STALE_CLEANUP_HOURS * 60 * 60 * 1000).toISOString();
    const failed = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'failed' } },
    ]);
    let failedCount = 0;
    for (const env of failed) {
      if (env.created_at && env.created_at < failedCutoff) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'stale_failed', delivery_status: 'delivered', updated_at: now() });
        failedCount++;
      }
    }
    if (failedCount) log('INFO', `Archived ${failedCount} failed envelopes (>${STALE_CLEANUP_HOURS}h old)`);

    // 2. Complete envelopes: archive children immediately, top-level after STALE_CLEANUP_HOURS
    const completeCutoff = new Date(Date.now() - STALE_CLEANUP_HOURS * 60 * 60 * 1000).toISOString();
    const forceArchiveCutoff = new Date(Date.now() - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const complete = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } },
    ]);
    let completeCount = 0;
    for (const env of complete) {
      // Child envelopes (have parent_id) never need delivery — archive immediately
      if (env.parent_id) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'child_complete', delivery_status: 'delivered', updated_at: now() });
        completeCount++;
        continue;
      }
      // Top-level envelopes: require delivery AND memory before archiving
      if (env.delivery_status === 'pending') {
        // DO NOT archive — mouth hasn't delivered this to the user yet
        continue;
      }
      const envAge = env.completed_at || env.updated_at || env.created_at;
      if (envAge && envAge < completeCutoff) {
        if (env.memory_written) {
          // Memory confirmed written — safe to archive
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered', delivery_status: 'delivered', updated_at: now() });
          completeCount++;
        } else if (envAge < forceArchiveCutoff) {
          // Force-archive very old envelopes even without memory flag (safety fallback)
          log('WARN', `Force-archiving envelope without memory_written: ${env.id} (age > ${ARCHIVE_AGE_DAYS}d)`);
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered_no_memory', delivery_status: 'delivered', updated_at: now() });
          completeCount++;
        }
      }
    }
    if (completeCount) log('INFO', `Archived ${completeCount} complete envelopes (children + >${STALE_CLEANUP_HOURS}h old)`);

    // 3. Stale needs_input envelopes older than NEEDS_INPUT_TIMEOUT_HOURS
    const needsInputCutoff = new Date(Date.now() - NEEDS_INPUT_TIMEOUT_HOURS * 60 * 60 * 1000).toISOString();
    const needsInput = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'needs_input' } },
    ]);
    let needsInputCount = 0;
    for (const env of needsInput) {
      if (env.updated_at && env.updated_at < needsInputCutoff) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'unanswered', delivery_status: 'delivered', updated_at: now() });
        needsInputCount++;
        log('WARN', `Archived unanswered needs_input envelope: ${env.id} (last updated ${env.updated_at})`);
      }
    }

    // 4. Cancelled envelopes older than STALE_CLEANUP_HOURS
    const cancelled = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'cancelled' } },
    ]);
    let cancelledCount = 0;
    for (const env of cancelled) {
      if (env.cancelled_at && env.cancelled_at < failedCutoff) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'cancelled', delivery_status: 'delivered', updated_at: now() });
        cancelledCount++;
      }
    }
    if (cancelledCount) log('INFO', `Archived ${cancelledCount} cancelled envelopes (>${STALE_CLEANUP_HOURS}h old)`);

    // 5. Timed-out envelopes — always children, archive immediately (they are terminal)
    const timedOut = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'timed_out' } },
    ]);
    let timedOutCount = 0;
    for (const env of timedOut) {
      await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'timed_out', delivery_status: 'delivered', updated_at: now() });
      timedOutCount++;
    }
    if (timedOutCount) log('INFO', `Archived ${timedOutCount} timed_out envelopes`);

    // NOTE: blocked envelopes are NOT archived — they persist indefinitely for resumption

    totalArchived = failedCount + completeCount + needsInputCount + cancelledCount + timedOutCount;
    log('INFO', `Archival sweep complete: ${totalArchived} total archived (${failedCount} failed, ${completeCount} complete, ${needsInputCount} unanswered, ${cancelledCount} cancelled, ${timedOutCount} timed_out)`);
  } catch (e) {
    log('WARN', `Archival sweep error: ${e.message}`);
  }
}

// ---- Quick ACK generation (lightweight LLM call, mission-aware) ----
const ACK_FALLBACKS = [
  '✅ Got it — working on this now.',
  '👍 On it!',
  '✅ Received — let me look into this.',
  '🔛 Working on it.',
];

async function generateAck(intakeText, activeEnvelopes, recentMissions = []) {
  try {
    // Read a personality snippet from IDENTITY.md (first 500 chars)
    const identityPaths = [
      CORE_DIR + `/workspace-${AGENT_ID}/IDENTITY.md`,
      CORE_DIR + '/workspace/IDENTITY.md',
    ];
    let identity = '';
    for (const p of identityPaths) {
      const content = cachedReadFile(p);
      if (content) { identity = content.substring(0, 500); break; }
    }

    // Build work context from active/blocked missions
    let workContext = '';
    if (activeEnvelopes && activeEnvelopes.length > 0) {
      const summaries = activeEnvelopes.map(e =>
        `${e.status === 'blocked' ? '🚫 BLOCKED' : '🔵 ACTIVE'}: "${(e.instruction || '').substring(0, 80)}"`
      ).join('\n');
      workContext = `\nYour current work:\n${summaries}`;
    }

    // Build recent mission context
    let recentContext = '';
    if (recentMissions.length > 0) {
      const summaries = recentMissions.map(m =>
        `• "${m.instruction}" → ${m.status}${m.project_id ? ` [${m.project_id}]` : ''}`
      ).join('\n');
      recentContext = `\nYour recent work:\n${summaries}`;
    }

    // Build project context
    let projectContext = '';
    if (Object.keys(PROJECTS).length > 0) {
      const projectNames = Object.values(PROJECTS)
        .map(p => `• ${p.name || p.id}: ${(p.description || '').substring(0, 80)}`)
        .join('\n');
      projectContext = `\nProjects you work on:\n${projectNames}`;
    }

    // Extract the actual current message from the composite intake
    const ackMessage = extractCurrentMessage(intakeText);

    const systemPrompt = [
      `You are a team member acknowledging an incoming message. Write a BRIEF (1 sentence, max 20 words) acknowledgment. Be natural, warm, and varied — never robotic. Reference what the person asked about if you can.`,
      workContext,
      recentContext,
      projectContext,
      `\nIMPORTANT: If the user's message relates to your recent or current work, acknowledge the CONTINUITY — say something like "Picking back up on the sync pipeline" or "Taking another look at this." Don't treat it as brand new if you recognize it from recent history.`,
      `\nYour personality:\n${identity || 'Helpful and professional.'}`,
    ].filter(Boolean).join('\n');

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
          { role: 'user', content: `[BRAIN-ORCHESTRATED]\nAcknowledge this message briefly:\n"${ackMessage.substring(0, 300)}"` },
        ],
        max_tokens: 60,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content && content.length > 2 && content.length < 200) {
        return content;
      }
    }
  } catch (e) {
    log('DEBUG', `ACK generation failed (using fallback): ${e.message}`);
  }
  // Fallback: random generic ack
  return ACK_FALLBACKS[Math.floor(Math.random() * ACK_FALLBACKS.length)];
}

// ---- Extract current message from composite intake ----
// Ears format: "[Chat messages since...]\ncontext...\n[Current message - respond to this]\nUser: actual message"
function extractCurrentMessage(intakeText) {
  if (!intakeText) return intakeText || '';
  const marker = '[Current message - respond to this]';
  const idx = intakeText.indexOf(marker);
  if (idx !== -1) {
    return intakeText.substring(idx + marker.length).trim();
  }
  return intakeText;
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

  // Phase 3: Active envelope scan (moved before ACK for mission-aware acknowledgments)
  const activeEnvelopes = await scanActiveEnvelopes();

  // (Quick ack moved to after classify — see below)

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

  // Create envelope based on classification — info_only and new_task both route through new_mission
  const classification = (decision.classification === 'new_task' || decision.classification === 'info_only')
    ? 'new_mission' : (decision.classification || 'new_mission');

  // Quick ack — generate text now, inject as C→T after M envelope is created
  let pendingAckText = null;
  if (intake.source && intake.source !== 'brain' && intake.source !== 'system' && !intake.quick_ack_sent
      && classification === 'new_mission' && decision.classification !== 'info_only') {
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
        log('INFO', `Process route: '${processId}' detected — routing to executeProcess`);
        const processResult = await executeProcess(intake, decision, memoryContext, processId);
        if (processResult !== 'fallback_to_decide') return;
        log('INFO', `Process '${processId}' fell back to decide loop — continuing with normal flow`);
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
      log('WARN', `Dedup guard: suppressing new_mission — similar active envelope ${duplicate.id} exists. Forcing attach.`);
      decision.classification = 'attach';
      decision.attach_to = duplicate.id;
      await handleAttach(intake, decision, memoryContext);
      return;
    }
  }

  // Phase 3: Handle attach classification (follow-up to existing work)
  if (classification === 'attach') {
    await handleAttach(intake, decision, memoryContext);
    return;
  }

  // Handle continue classification (resume a blocked mission)
  if (classification === 'continue') {
    await handleContinue(intake, decision, memoryContext);
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
    project_id: decision.project_id || null,
    context: decision.context || null,
    source_text: sourceText || null, // Raw user message — preserved verbatim for child dispatches
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

  // Inject ack as first C→T under the mission
  if (pendingAckText) {
    await createCT(envelope, {
      checkpointTitle: 'Acknowledge receipt',
      taskTitle: 'Write acknowledgment',
      taskOutput: pendingAckText,
      taskIntent: 'ack',
      deliveryStatus: 'pending',
    });
    await firestoreWrite('work', envelope.id, envelope);
    log('INFO', `Ack injected as C→T under ${envelopeId}`);
  }

  // Process the envelope (pass memory context to avoid re-recall)
  await processEnvelope(envelope, memoryContext);
}

// ---- Attach handler: follow-up to existing work ----
async function handleAttach(intake, decision, memoryContext) {
  const targetId = decision.attach_to;
  log('INFO', `Attach: intake ${intake.id} → target ${targetId}`);

  if (!targetId) {
    log('WARN', `Attach missing attach_to field, treating as new_task`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  const targetEnv = await firestoreRead('work', targetId);
  if (!targetEnv) {
    log('WARN', `Attach target ${targetId} not found, treating as new_task`);
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
    return processIntakeAsNewTask(intake, decision, memoryContext, targetId);
  }

  // For blocked envelopes, delegate to handleContinue (which knows how to reopen)
  if (targetEnv.status === 'blocked') {
    log('INFO', `Attach target ${targetId} is blocked — routing to handleContinue`);
    decision.continue_mission = targetId;
    return handleContinue(intake, decision, memoryContext);
  }

  // For failed missions, create a child task linked to the mission
  if (targetEnv.status === 'failed') {
    log('INFO', `Attach target ${targetId} is failed — creating linked follow-up task`);
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
    project_id: decision.project_id || null,
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
async function handleContinue(intake, decision, memoryContext) {
  const targetId = decision.continue_mission || decision.continue_envelope;
  log('INFO', `Continue: intake ${intake.id} → resuming blocked mission ${targetId}`);

  if (!targetId) {
    log('WARN', `Continue missing continue_mission field, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  const mission = await firestoreRead('work', targetId);
  if (!mission) {
    log('WARN', `Continue target ${targetId} not found, treating as new_mission`);
    return processIntakeAsNewTask(intake, decision, memoryContext);
  }

  // Only reopen blocked or complete missions (not active — that's an attach/status check)
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
  mission.delivery_status = 'internal'; // Reset — will become 'pending' when re-completed
  mission._unblock_attempted = false; // Reset retry cap for new attempt
  mission.updated_at = now();

  await firestoreWrite('work', targetId, mission);
  await writeHistory(targetId, prevStatus, 'active', 'brain',
    `Resumed via continue: ${intake.text.substring(0, 100)}`);
  log('INFO', `Mission ${targetId} reopened from ${prevStatus} → active`);

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

  // Deliver confirmation
  await deliverStatusUpdate(targetId, `✅ Cancelled mission: "${target.instruction.substring(0, 100)}"`);
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
    const action = decision.action;
    log('INFO', `Cortex decision: action=${action} (iteration ${iteration})`);

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
        taskOutput: decision.synthesis || decision.response,
        taskIntent: 'synthesize',
        deliveryStatus: envelope.parent_id ? 'internal' : 'pending',
      });

      envelope.output = decision.synthesis || decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) envelope.delivery_status = 'pending';
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Synthesized response');
      log('INFO', `Envelope ${envelope.id} complete (synthesize)`);

      // Phase 3: Write completed work to memory
      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);

      // Phase 3C: Context promotion — suggest new context entries for the parent project
      if (envelope.project_id && envelope.type === 'M' && envelope.context) {
        await suggestContextPromotions(envelope);
      }

      return;
    }

    if (action === 'synthesize_with_failure') {
      // Self-unblock attempt: before accepting failure, check if Cortex can find an alternative
      if (!envelope._unblock_attempted && iteration < MAX_ITERATIONS - 2) {
        log('INFO', `Self-unblock attempt for ${envelope.id} — asking Cortex for alternative approach`);
        envelope._unblock_attempted = true;
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
        envelope.output = decision.synthesis || decision.response;
        envelope.status = 'complete';
        envelope.completed_at = now();
        envelope.updated_at = now();
        if (!envelope.parent_id) envelope.delivery_status = 'pending';
        await firestoreWrite('work', envelope.id, envelope);
        await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Completed (self-unblock resolved the failure)');
        log('INFO', `Envelope ${envelope.id} complete (synthesize_with_failure → self-unblock succeeded)`);
        await writeMemory(envelope);
        await cleanupSharedWorkspace(envelope.id);
        return;
      }

      if (envelope.type === 'M') {
        // Missions get blocked status — they stay alive for resumption
        envelope.output = decision.synthesis || decision.response;
        envelope.status = 'blocked';
        envelope.blocker = decision.failure_summary || decision.synthesis || 'Unknown blocker';
        envelope.blocker_type = decision.blocker_type || 'other';
        envelope.blocked_at = now();
        envelope.updated_at = now();
        if (!envelope.parent_id) envelope.delivery_status = 'pending';
        await firestoreWrite('work', envelope.id, envelope);
        await writeHistory(envelope.id, 'active', 'blocked', 'brain',
          `Blocked (self-unblock exhausted): ${(decision.failure_summary || '').substring(0, 200)}`);
        log('INFO', `Envelope ${envelope.id} BLOCKED (synthesize_with_failure → blocked: ${(decision.failure_summary || '').substring(0, 80)})`);
        await writeMemory(envelope);
        return;
      }

      // Non-mission envelopes (tasks) still complete normally with failure
      envelope.output = decision.synthesis || decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) envelope.delivery_status = 'pending';
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
      envelope.output = decision.escalation_message || decision.blocker_description || decision.blocker || decision.synthesis || decision.response || 'Blocked on external dependency.';
      envelope.status = 'blocked';
      envelope.blocker = decision.blocker || 'Unknown blocker';
      envelope.blocker_type = decision.blocker_type || 'other';
      envelope.blocked_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) envelope.delivery_status = 'pending';
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
      if (!envelope.parent_id) envelope.delivery_status = 'pending';
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
      return executeProcess(null, decision, memoryContext || {}, processId, envelope);
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
          const taskCriteria = task.accept_criteria || '';
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
            const fallbackNotif = `⏸ **Approval needed**\n\n**${taskDesc.substring(0, 200)}**\n\n${taskCriteria ? `Criteria: ${taskCriteria}\n\n` : ''}Reply \`approve\` or \`reject\` here, or use the dashboard.`;
            const cleanNotif = await summarizeForDelivery('approval_request', fallbackNotif, {
              steps: rawStepData,
              title: taskDesc.substring(0, 200),
              processName: decision.process_name || '',
              customMessage: taskCriteria || '',
            });
            const notifOutput = `⏸ **Approval needed**\n\n${cleanNotif}\n\nReply \`approve\` or \`reject\` here, or use the dashboard.`;

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
              instruction: `Create a new responsibility using the responsibility-manage tool:\n\nresponsibility-manage create --name "${taskDesc.replace(/"/g, '\\"')}" --instruction "${(taskCriteria || taskDesc).replace(/"/g, '\\"')}"\n\nThis is a process step of type 'spawn_responsibility'.`,
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

          // ---- Delegation: route through delegation envelope ----
          if (stepType === 'delegation') {
            log('INFO', `CP${cpNum} Task ${taskNum}: Delegation to '${task._specialty || taskAgent}'`);
            // Delegation dispatches work the same as standard but tag the intent
            // The agent receiving it treats it as a delegated work item
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

          // Dispatch to agent
          let result = await callAgent(taskAgent, {
            instruction: taskDesc,
            accept_criteria: taskCriteria,
            _missionId: envelope.id,  // mission-scoped shared workspace
            context_summary: [...allResults, ...cpResults].length > 0
              ? (await Promise.all([...allResults, ...cpResults].map(async r => `Step ${r.step} (${r.agent}): ${await smartSummarize(r.result || '', CTX_AGENT_STEP, 'Summarize this prior step result briefly. Keep key outputs and state changes.')}`))).join('\n')
              : undefined,
            prior_results_context: [...allResults, ...cpResults].length > 0
              ? (await Promise.all([...allResults, ...cpResults].map(async r => `## Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${await smartSummarize(r.result || '', CTX_AGENT_STEP, 'Summarize this completed step. Keep deliverables, changes made, and any issues encountered.')}`))).join('\n\n')
              : undefined,
          });

          // Retry once on failure
          if (!result.success) {
            log('WARN', `CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
            result = await callAgent(taskAgent, {
              instruction: `${taskDesc}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.`,
              accept_criteria: taskCriteria,
              _missionId: envelope.id,
            });
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

          const stepResult = {
            step: `${cpNum}.${taskNum}`,
            agent: taskAgent,
            task: taskDesc.substring(0, 200),
            result: result.success
              ? await smartSummarize(result.output || '', CTX_AGENT_STEP, 'Summarize this checkpoint task result. Keep key outputs, file paths, and resource names.')
              : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${await smartSummarize(result.output || '(no output)', CTX_AGENT_STEP, 'Summarize this failed task output. Keep error details and partial progress.')}`,
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

// ---- Shared workspace management (Phase 5) ----
async function initSharedWorkspace(envelopeId) {
  try {
    const { execSync } = await import('child_process');
    execSync(`mkdir -p ${CORE_DIR}/shared/${envelopeId}`, { timeout: 3000 });
  } catch (e) {
    log('WARN', `Failed to init shared workspace for ${envelopeId}: ${e.message}`);
  }
}

async function cleanupSharedWorkspace(envelopeId) {
  try {
    const { execSync } = await import('child_process');
    execSync(`rm -rf ${CORE_DIR}/shared/${envelopeId}`, { timeout: 3000 });
  } catch (e) {
    log('WARN', `Failed to cleanup shared workspace for ${envelopeId}: ${e.message}`);
  }
}

// ---- History ----
let _historyCounter = 0; // intra-ms tiebreaker
let _historyLastMs = 0;
async function writeHistory(envelopeId, prevStatus, newStatus, agent, detail) {
  const ms = Date.now();
  if (ms === _historyLastMs) { _historyCounter++; } else { _historyCounter = 0; _historyLastMs = ms; }
  const historyId = `${ms}-${_historyCounter}`;
  await firestoreWrite(`work/${envelopeId}/history`, historyId, {
    seq: ms,
    prev_status: prevStatus,
    new_status: newStatus,
    agent,
    timestamp: now(),
    detail: (detail || '').substring(0, 1000),
  });
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

      // All delegated children are done — resume the waiting envelope
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

  // Load projects from Firestore
  await loadProjects();
  log('INFO', `Projects loaded: ${Object.keys(PROJECTS).length} active`);

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
        // Recalculate next-fire times
        _respNextFire = {};
        for (const r of RESPONSIBILITIES) {
          if (r.enabled) _respNextFire[r.id] = cronNextFire(r.schedule);
        }
      });
    }
  }

  // Initial poll
  await pollIntake();
}

// ---- Phase 7A: Cron expression parser ----
function cronMatch(expression, date) {
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = expression.trim().split(/\s+/);
  const min = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const dow = date.getUTCDay(); // 0=Sun

  return fieldMatches(minExpr, min, 0, 59)
    && fieldMatches(hourExpr, hour, 0, 23)
    && fieldMatches(domExpr, dom, 1, 31)
    && fieldMatches(monExpr, mon, 1, 12)
    && fieldMatches(dowExpr, dow, 0, 6);
}

function fieldMatches(expr, value, rangeMin, rangeMax) {
  if (expr === '*') return true;
  // */N step
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    return value % step === 0;
  }
  // Comma-separated values: 1,5,10
  const parts = expr.split(',');
  for (const part of parts) {
    // Range: 1-5
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function cronNextFire(expression) {
  // Calculate next fire time by scanning forward minute-by-minute (max 48h)
  const now_ = new Date();
  const check = new Date(now_);
  check.setUTCSeconds(0, 0);
  check.setUTCMinutes(check.getUTCMinutes() + 1); // start from next minute
  const maxMs = 48 * 60 * 60 * 1000;
  while (check.getTime() - now_.getTime() < maxMs) {
    if (cronMatch(expression, check)) return check;
    check.setUTCMinutes(check.getUTCMinutes() + 1);
  }
  return null; // no match within 48h
}

// ---- Phase 7A: Responsibility scheduler ----
const _respLastFired = {}; // id → timestamp
let _respNextFire = {};    // id → Date

// ---- Phase 3A: Approval gate resume handler ----
let approvalCheckCount = 0;

async function checkApprovedApprovals() {
  approvalCheckCount++;
  // Only check every 5th poll cycle (~15s)
  if (approvalCheckCount % 5 !== 0) return;

  try {
    const token = await getAuthToken();
    if (!token || !PRIME_ID) return;

    // Query for approved or rejected approvals
    for (const targetStatus of ['approved', 'rejected']) {
      const queryUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/approvals:runQuery`;
      const resp = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'approvals' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'EQUAL',
                value: { stringValue: targetStatus },
              },
            },
            limit: 5,
          },
        }),
      });
      if (!resp.ok) continue;

      const results = await resp.json();
      for (const row of results) {
        if (!row.document) continue;
        const fields = row.document.fields || {};
        const approvalId = row.document.name.split('/').pop();
        const envelopeId = fields.envelopeId?.stringValue;
        const processed = fields._processed?.booleanValue;

        if (!envelopeId || processed) continue;

        log('INFO', `Approval ${approvalId} ${targetStatus} — resuming envelope ${envelopeId}`);

        // Mark approval as processed to avoid re-processing
        const approvalDocPath = row.document.name.split('/documents/')[1];
        await fetch(`${FIRESTORE_BASE}/${approvalDocPath}?updateMask.fieldPaths=_processed`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { _processed: { booleanValue: true } } }),
        }).catch(() => {});

        // Load the paused envelope
        const envDoc = await firestoreRead('work', envelopeId);
        if (!envDoc || envDoc.status !== 'awaiting_approval') {
          log('WARN', `Approval ${approvalId}: envelope ${envelopeId} not in awaiting_approval state (${envDoc?.status})`);
          continue;
        }

        const meta = envDoc.source_meta || {};
        const pausedCheckpoints = meta.paused_checkpoints;
        const pausedCpIndex = meta.paused_checkpoint_index;
        const pausedTaskIndex = meta.paused_task_index;
        const pausedAllResults = meta.paused_all_results || [];

        if (!pausedCheckpoints || pausedCpIndex === undefined || pausedTaskIndex === undefined) {
          log('WARN', `Approval ${approvalId}: missing resume state on envelope`);
          continue;
        }

        if (targetStatus === 'rejected') {
          // Cancel remaining tasks and mark as failed
          envDoc.status = 'failed';
          envDoc.output = `Process rejected at approval gate (approval ${approvalId})`;
          envDoc.error = fields.reason?.stringValue || 'Approval rejected by user';
          envDoc.completed_at = now();
          envDoc.updated_at = now();
          if (!envDoc.parent_id) envDoc.delivery_status = 'pending';
          await firestoreWrite('work', envelopeId, envDoc);
          await writeHistory(envelopeId, 'awaiting_approval', 'failed', 'brain', `Approval rejected`);
          log('INFO', `Envelope ${envelopeId} rejected at approval gate`);
          continue;
        }

        // Approved — resume execution
        if (envDoc.process_id) {
          // Process work: use deterministic resumption (no Cortex loop)
          log('INFO', `Approved: resuming process plan for ${envelopeId}`);
          await resumeProcessPlan(envDoc);
        } else {
          // Non-process work: resume through Cortex decide loop (legacy)
          log('INFO', `Resuming checkpoint plan from CP${pausedCpIndex + 1} task ${pausedTaskIndex + 2}`);

          envDoc.status = 'active';
          envDoc.updated_at = now();
          // Clean up paused state
          delete envDoc.source_meta.paused_approval_id;
          delete envDoc.source_meta.paused_checkpoints;
          delete envDoc.source_meta.paused_checkpoint_index;
          delete envDoc.source_meta.paused_task_index;
          delete envDoc.source_meta.paused_all_results;
          await firestoreWrite('work', envelopeId, envDoc);

          // Resume processing the envelope through the normal Cortex loop
          const memory = await recallMemory(envDoc.instruction, {
            instruction: envDoc.instruction,
            context_summary: (envDoc.context_summary || '').substring(0, 500),
          });
          await processEnvelope(envDoc, memory);
        }
      }
    }
  } catch (e) {
    log('DEBUG', `Approval check error: ${e.message}`);
  }
}

// ---- Phase 3C: Context promotion (suggest + approve) ----

async function suggestContextPromotions(envelope) {
  if (!envelope.project_id || !envelope.context) return;

  try {
    const project = PROJECTS[envelope.project_id];
    if (!project) return;

    const projectContext = project.context || {};
    const missionContext = envelope.context || {};

    // Find NEW context entries in mission that aren't in project
    const newEntries = {};
    for (const [key, entry] of Object.entries(missionContext)) {
      if (!projectContext[key] && entry && typeof entry === 'object') {
        newEntries[key] = entry;
      }
    }

    if (Object.keys(newEntries).length === 0) return;

    log('INFO', `Context promotion: ${Object.keys(newEntries).length} new entries from mission ${envelope.id} for project ${envelope.project_id}`);

    const token = await getAuthToken();
    if (!token) return;

    if (PROJECT_PROMOTION_AUTO) {
      // Auto-promote: merge directly into project context
      const projectUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/projects/${envelope.project_id}`;
      const merged = mergeContextPackets(projectContext, newEntries);
      const contextFields = {};
      for (const [k, v] of Object.entries(merged)) {
        if (v && typeof v === 'object') {
          const entryFields = {};
          if (v.kind) entryFields.kind = { stringValue: v.kind };
          if (v.ref) entryFields.ref = { stringValue: v.ref };
          if (v.name) entryFields.name = { stringValue: v.name };
          if (v.summary) entryFields.summary = { stringValue: v.summary };
          contextFields[k] = { mapValue: { fields: entryFields } };
        }
      }
      await fetch(`${projectUrl}?updateMask.fieldPaths=context`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          context: { mapValue: { fields: contextFields } },
        }}),
      });
      log('INFO', `Auto-promoted ${Object.keys(newEntries).length} context entries to project ${envelope.project_id}`);
    } else {
      // Write promotion candidates for dashboard approval
      for (const [key, entry] of Object.entries(newEntries)) {
        const promoId = generateId('promo');
        const promoUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/projects/${envelope.project_id}/promotions/${promoId}`;
        await fetch(promoUrl, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            key: { stringValue: key },
            entry: { mapValue: { fields: {
              ...(entry.kind ? { kind: { stringValue: entry.kind } } : {}),
              ...(entry.ref ? { ref: { stringValue: entry.ref } } : {}),
              ...(entry.name ? { name: { stringValue: entry.name } } : {}),
              ...(entry.summary ? { summary: { stringValue: entry.summary } } : {}),
            }}},
            source_mission_id: { stringValue: envelope.id },
            suggested_at: { stringValue: now() },
            status: { stringValue: 'pending' },
          }}),
        });
      }
      log('INFO', `Wrote ${Object.keys(newEntries).length} promotion candidates for project ${envelope.project_id}`);
    }
  } catch (e) {
    log('DEBUG', `Context promotion error: ${e.message}`);
  }
}

function startResponsibilityScheduler() {
  if (RESPONSIBILITIES.length === 0) {
    log('INFO', 'No responsibilities configured, scheduler idle');
    return;
  }

  // Calculate initial next-fire times
  for (const r of RESPONSIBILITIES) {
    if (r.enabled) {
      _respNextFire[r.id] = cronNextFire(r.schedule);
      const nextStr = _respNextFire[r.id]
        ? _respNextFire[r.id].toISOString()
        : 'none (no match in 48h)';
      log('INFO', `Responsibility ${r.id}: next fire ${nextStr}`);
    }
  }

  // Check every 60 seconds
  setInterval(async () => {
    const now_ = new Date();
    for (const r of RESPONSIBILITIES) {
      if (!r.enabled) continue;
      const nextFire = _respNextFire[r.id];
      if (!nextFire || now_ < nextFire) continue;

      // Min spacing check
      const lastFired = _respLastFired[r.id];
      const minSpacingMs = (r.min_spacing_minutes || 15) * 60 * 1000;
      if (lastFired && (now_.getTime() - lastFired) < minSpacingMs) {
        log('INFO', `Responsibility ${r.id} skipped (min spacing ${r.min_spacing_minutes}m)`);
        _respNextFire[r.id] = cronNextFire(r.schedule);
        continue;
      }

      // Fire!
      log('INFO', `Responsibility ${r.id} firing: ${r.name}`);
      _respLastFired[r.id] = now_.getTime();
      _respNextFire[r.id] = cronNextFire(r.schedule);

      try {
        await fireResponsibility(r);
      } catch (e) {
        log('ERROR', `Responsibility ${r.id} fire failed: ${e.message}`);
      }
    }
  }, 60_000);
}

async function fireResponsibility(resp) {
  // Phase 3B: If responsibility has a processRef, execute the process directly
  if (resp.processRef) {
    await ensureProcessesLoaded();
    const process = PROCESSES[resp.processRef];
    if (process) {
      log('INFO', `Responsibility ${resp.id}: executing linked process '${process.name}' v${process.version || 1}`);

      // Build parameters: merge process defaults → responsibility overrides
      const parameters = {};
      for (const [key, def] of Object.entries(process.parameters || {})) {
        if (def && typeof def === 'object' && def.default !== undefined) {
          parameters[key] = def.default;
        }
      }
      Object.assign(parameters, resp.processParameters || {});

      // Validate required parameters
      const requiredParams = Object.entries(process.parameters || {})
        .filter(([, def]) => def && typeof def === 'object' && def.required && !def.default)
        .map(([key]) => key);
      const missingParams = requiredParams.filter(k => !(k in parameters));
      if (missingParams.length > 0) {
        log('WARN', `Responsibility ${resp.id}: process '${process.name}' missing required params: ${missingParams.join(', ')} — falling through to normal mission`);
        // Fall through to normal responsibility firing below
      } else {
        // Convert process to checkpoint plan
        const cpPlan = processToCheckpointPlan(process, parameters);
        if (cpPlan) {
          // Create R envelope
          const respEnvId = generateId('w');
          const respEnvelope = {
            id: respEnvId,
            type: 'R',
            parent_id: null,
            owner: AGENT_EMAIL || AGENT_ID,
            status: 'complete',
            intent: 'responsibility',
            title: resp.name || resp.id,
            instruction: resp.instruction,
            accept_criteria: resp.context?.success_criteria || null,
            context_summary: `Process: ${process.name} v${process.version || 1}`,
            output: `Responsibility ${resp.id} fired at ${now()} → process ${process.id}`,
            children: [],
            context_forward: null,
            error: null,
            source_channel: 'scheduler',
            source_meta: { responsibility_id: resp.id, responsibility_name: resp.name, schedule: resp.schedule, process_id: process.id },
            created_at: now(),
            started_at: now(),
            completed_at: now(),
            updated_at: now(),
            iteration: 0,
          };
          await firestoreWrite('work', respEnvId, respEnvelope);

          // Create M mission with process already loaded
          const missionId = generateId('w');
          const missionEnvelope = {
            id: missionId,
            type: 'M',
            parent_id: respEnvId,
            owner: AGENT_EMAIL || AGENT_ID,
            status: 'active',
            intent: 'execute',
            title: `Execute: ${resp.name || resp.id}`,
            instruction: resp.instruction,
            accept_criteria: resp.context?.success_criteria || null,
            context_summary: `Executing process: ${process.name}`,
            output: null,
            children: [],
            context_forward: null,
            error: null,
            source_channel: 'scheduler',
            source_meta: { responsibility_id: resp.id, responsibility_name: resp.name, fired_at: now(), process_id: process.id },
            process_id: process.id,
            process_version: process.version || 1,
            created_at: now(),
            started_at: now(),
            completed_at: null,
            updated_at: now(),
            iteration: 0,
            delivery_status: 'internal',
            memory_context: null,
          };

          // Merge process context template
          if (process.contextTemplate && typeof process.contextTemplate === 'object') {
            const templateCtx = {};
            for (const [key, entry] of Object.entries(process.contextTemplate)) {
              if (entry && typeof entry === 'object') {
                const processed = { ...entry };
                if (processed.name) processed.name = processed.name.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
                if (processed.summary) processed.summary = processed.summary.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
                templateCtx[key] = processed;
              }
            }
            missionEnvelope.context = templateCtx;
          }

          respEnvelope.children.push(missionId);
          await firestoreWrite('work', respEnvId, respEnvelope);
          await firestoreWrite('work', missionId, missionEnvelope);
          await writeHistory(missionId, null, 'active', 'scheduler', `Process ${process.id} from responsibility ${resp.id}`);

          // Increment process execution count
          try {
            const token = await getAuthToken();
            if (token) {
              const procUrl = `${FIRESTORE_BASE}/primes/${PRIME_ID}/processes/${process.id}`;
              const currentCount = process.execution_count || 0;
              await fetch(procUrl + '?updateMask.fieldPaths=execution_count&updateMask.fieldPaths=last_executed_at', {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: {
                  execution_count: { integerValue: String(currentCount + 1) },
                  last_executed_at: { stringValue: now() },
                }}),
              });
            }
          } catch (e) { log('DEBUG', `Process execution count update failed: ${e.message}`); }

          // Recall memory then execute the checkpoint plan directly
          const memory = await recallMemory(resp.instruction, {
            instruction: resp.instruction,
            context_summary: `Process: ${process.name}`,
          });
          missionEnvelope.memory_context = memory;
          await firestoreWrite('work', missionId, missionEnvelope);
          await processEnvelope(missionEnvelope, memory);

          log('INFO', `Responsibility ${resp.id} → process ${process.id} execution started`);
          return;
        }
      }
    } else {
      log('WARN', `Responsibility ${resp.id}: processRef '${resp.processRef}' not found, falling through to normal mission`);
    }
  }

  // Build rich context summary from the responsibility definition
  const contextParts = [];
  if (resp.context?.purpose) contextParts.push(`PURPOSE: ${resp.context.purpose}`);
  if (resp.context?.process?.length) {
    contextParts.push(`PROCESS:\n${resp.context.process.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  }
  if (resp.context?.reference_files?.length) {
    contextParts.push(`REFERENCE FILES: ${resp.context.reference_files.join(', ')}`);
  }
  if (resp.context?.success_criteria) {
    contextParts.push(`SUCCESS CRITERIA: ${resp.context.success_criteria}`);
  }
  if (resp.context?.prior_learnings) {
    contextParts.push(`PRIOR LEARNINGS: ${resp.context.prior_learnings}`);
  }
  const contextSummary = contextParts.join('\n\n');

  // Create type=R Responsibility envelope
  const respEnvId = generateId('w');
  const respEnvelope = {
    id: respEnvId,
    type: 'R',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'complete', // R is just a container, mark complete immediately
    intent: 'responsibility',
    title: resp.name || resp.id,
    instruction: resp.instruction,
    accept_criteria: resp.context?.success_criteria || null,
    context_summary: contextSummary,
    output: `Responsibility ${resp.id} fired at ${now()}`,
    children: [],
    context_forward: null,
    error: null,
    source_channel: 'scheduler',
    source_meta: {
      responsibility_id: resp.id,
      responsibility_name: resp.name,
      schedule: resp.schedule,
    },
    created_at: now(),
    started_at: now(),
    completed_at: now(),
    updated_at: now(),
    iteration: 0,
  };

  await firestoreWrite('work', respEnvId, respEnvelope);
  await writeHistory(respEnvId, null, 'complete', 'scheduler', `Responsibility ${resp.id} fired`);

  // Create type=M Mission child — this enters the normal Cortex loop
  const missionId = generateId('w');
  const missionEnvelope = {
    id: missionId,
    type: 'M',
    parent_id: respEnvId,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'pending',
    intent: 'execute',
    title: `Execute: ${resp.name || resp.id}`,
    instruction: resp.instruction,
    accept_criteria: resp.context?.success_criteria || null,
    context_summary: contextSummary,
    output: null,
    children: [],
    context_forward: null,
    error: null,
    source_channel: 'scheduler',
    source_meta: {
      responsibility_id: resp.id,
      responsibility_name: resp.name,
      fired_at: now(),
    },
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: null, // Will be recalled during processEnvelope
  };

  // Track child on R envelope
  respEnvelope.children.push(missionId);
  await firestoreWrite('work', respEnvId, respEnvelope);

  await firestoreWrite('work', missionId, missionEnvelope);
  await writeHistory(missionId, null, 'pending', 'scheduler', `Mission from responsibility ${resp.id}`);
  log('INFO', `Created R:${respEnvId} → M:${missionId} for responsibility ${resp.id}`);

  // Recall memory with rich context, then process
  const memory = await recallMemory(resp.instruction, {
    instruction: resp.instruction,
    context_summary: contextSummary.substring(0, 500),
  });
  missionEnvelope.memory_context = memory;
  await firestoreWrite('work', missionId, missionEnvelope);

  // Process the mission through the normal Cortex loop
  await processEnvelope(missionEnvelope, memory);
}

main().catch(e => {
  log('ERROR', `Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
