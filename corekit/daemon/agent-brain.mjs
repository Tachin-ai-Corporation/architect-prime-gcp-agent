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
import { readFileSync, appendFileSync, existsSync, watchFile } from 'fs';
import { randomBytes } from 'crypto';

// ---- Contracts (loaded first — config depends on it) ----
let CONTRACTS = {};
try {
  CONTRACTS = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
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
const MAX_ITERATIONS = CONTRACTS.brain?.max_iterations || 12;
const GATEWAY_TIMEOUT_MS = CONTRACTS.brain?.gateway_timeout_ms || 600_000;
const STALE_CLEANUP_HOURS = CONTRACTS.brain?.stale_cleanup_hours || 24;
const ARCHIVE_AGE_DAYS = CONTRACTS.brain?.archive_age_days || 7;
const ARCHIVE_INTERVAL_MS = CONTRACTS.brain?.archive_interval_ms || 1 * 60 * 60 * 1000; // 1h default
const NEEDS_INPUT_TIMEOUT_HOURS = CONTRACTS.brain?.needs_input_timeout_hours || 72;
const LOG_FILE = '/tmp/agent-brain.log';
const CORTEX_ROUTE = CONTRACTS.agents?.gatewayRoute || 'openclaw/cortex';

// ---- Context forwarding budgets (chars per prior step) ----
const CTX_DISPATCH_SUCCESS = CONTRACTS.brain?.ctx_dispatch_success || 4000;
const CTX_DISPATCH_FAILURE = CONTRACTS.brain?.ctx_dispatch_failure || 3000;
const CTX_AGENT_STEP = CONTRACTS.brain?.ctx_agent_step || 8000;
const CTX_CORTEX_STEP = CONTRACTS.brain?.ctx_cortex_step || 4000;

function smartTruncate(text, budget) {
  if (!text || text.length <= budget) return text;
  const headBudget = Math.floor(budget * 0.4);
  const tailBudget = Math.floor(budget * 0.4);
  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);
  const truncated = text.length - headBudget - tailBudget;
  return `${head}\n[...${truncated} chars truncated...]\n${tail}`;
}

// ---- Gateway token ----
let GATEWAY_TOKEN = 'no-token';
try {
  GATEWAY_TOKEN = readFileSync('/root/.openclaw/.gateway-token', 'utf8').trim();
} catch {
  try {
    GATEWAY_TOKEN = readFileSync('/home/node/.openclaw/.gateway-token', 'utf8').trim();
  } catch {
    // Fallback: read from openclaw.json config (same as agent-ears)
    try {
      const cfg = JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
      GATEWAY_TOKEN = cfg.gateway?.auth?.token || 'no-token';
    } catch {
      // Fallback: read from container env
      if (process.env.OPENCLAW_GATEWAY_TOKEN) {
        GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        log('WARN', 'No gateway token found');
      }
    }
  }
}

// ---- Agent registry ----
let REGISTRY = { agents: {} };
try {
  REGISTRY = JSON.parse(readFileSync('/home/node/.openclaw/corekit/agent-registry.json', 'utf8'));
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

// ---- Process registry (loaded from Firestore, refreshed periodically) ----
let PROCESSES = {}; // keyed by process id
let _processesLoadedAt = 0;
const PROCESSES_REFRESH_MS = 60_000;

async function loadProcesses() {
  try {
    const token = await getAuthToken();
    if (!token) return;
    const url = `${FIRESTORE_BASE}/primes/${PRIME_ID}/processes`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const processes = {};
    for (const doc of (data.documents || [])) {
      const p = firestoreDecode(doc.fields || {});
      if (p.id && p.status !== 'deprecated') {
        processes[p.id] = p;
      }
    }
    PROCESSES = processes;
    _processesLoadedAt = Date.now();
    if (Object.keys(processes).length > 0) {
      log('INFO', `Processes loaded: ${Object.keys(processes).join(', ')}`);
    }
  } catch (e) {
    log('WARN', `Failed to load processes: ${e.message}`);
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

// ---- Context Packet helpers ----
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
    '/home/node/.openclaw/corekit/responsibilities.json',
    '/home/node/.openclaw/corekit/responsibilities-job.json',
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
      obj[k] = (v.arrayValue.values || []).map(item => item.stringValue || item.integerValue || '');
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
      model: CORTEX_ROUTE,
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
    // OpenClaw may return content as [{type: "text", text: "..."}]
    content = msg.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
  }

  log('DEBUG', `Cortex raw response (${content.length} chars): ${content.substring(0, 300)}`);

  return parseJsonResponse(content);
}

function buildSystemPrompt(mode, payload) {
  const parts = [];

  // 1. Read SOUL.md — core decision-making guidance
  const soulPaths = [
    '/home/node/.openclaw/workspace-cortex/SOUL.md',
    '/home/node/.openclaw/workspace/SOUL.md',
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
    `/home/node/.openclaw/workspace-${AGENT_ID}/IDENTITY.md`,
    '/home/node/.openclaw/workspace-devops/IDENTITY.md',
    '/home/node/.openclaw/workspace/IDENTITY.md',
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
    `/home/node/.openclaw/workspace-${AGENT_ID}/MEMORY.md`,
    '/home/node/.openclaw/workspace-devops/MEMORY.md',
    '/home/node/.openclaw/workspace/MEMORY.md',
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
      classification_guidance: {
        blocked_missions: 'If a blocked mission exists and the user message addresses the blocker or asks to retry/fix/continue the work, classify as "continue" with continue_mission set to the mission ID. Do NOT classify as "attach" for blocked missions — use "continue" instead.',
        attach_vs_continue: '"attach" = follow-up info or new instruction for active/waiting work. "continue" = resume blocked/stalled work or retry after failure.',
        project_identification: 'If the work matches a known project from the project_registry, set project_id in your response. Not every piece of work belongs to a project.',
      },
    };
    if (Object.keys(PROJECTS).length > 0) {
      classifyPayload.project_registry = Object.values(PROJECTS).map(p => ({
        id: p.id, name: p.name, description: p.description,
        context_summary: JSON.stringify(p.context || {}),
      }));
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
      decidePayload.project = PROJECTS[envProjectId];
    }
    // Inject available processes so Cortex can suggest follow_process
    if (Object.keys(PROCESSES).length > 0) {
      decidePayload.available_processes = Object.values(PROCESSES).map(p => ({
        id: p.id, name: p.name, description: (p.description || '').substring(0, 200),
        step_count: (p.steps || []).length,
        parameters: p.parameters || {},
      }));
    }
    return JSON.stringify(decidePayload);
  }
  return JSON.stringify(payload);
}

// ---- Response parser (hardened for Phase 2) ----
function parseJsonResponse(raw) {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Strip OpenClaw Action: blocks that may follow JSON
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

  const route = agentInfo.route || `openclaw/${agentId}`;
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
        instruction: (e.instruction || '').substring(0, 120),
        output: (e.output || '').substring(0, 150),
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
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'stale_failed', updated_at: now() });
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
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'child_complete', updated_at: now() });
        completeCount++;
        continue;
      }
      // Top-level envelopes: require memory_written before archiving (safety gate)
      const envAge = env.completed_at || env.updated_at || env.created_at;
      if (envAge && envAge < completeCutoff) {
        if (env.memory_written) {
          // Memory confirmed written — safe to archive
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered', updated_at: now() });
          completeCount++;
        } else if (envAge < forceArchiveCutoff) {
          // Force-archive very old envelopes even without memory flag (safety fallback)
          log('WARN', `Force-archiving envelope without memory_written: ${env.id} (age > ${ARCHIVE_AGE_DAYS}d)`);
          await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'delivered_no_memory', updated_at: now() });
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
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'unanswered', updated_at: now() });
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
        await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'cancelled', updated_at: now() });
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
      await firestoreWrite('work', env.id, { ...env, status: 'archived', archived_reason: 'timed_out', updated_at: now() });
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
      `/home/node/.openclaw/workspace-${AGENT_ID}/IDENTITY.md`,
      '/home/node/.openclaw/workspace/IDENTITY.md',
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
    // (ears format: "[Chat messages since...]\ncontext...\n[Current message - respond to this]\nUser: actual message")
    let ackMessage = intakeText;
    const currentMsgMarker = '[Current message - respond to this]';
    const markerIdx = intakeText.indexOf(currentMsgMarker);
    if (markerIdx !== -1) {
      ackMessage = intakeText.substring(markerIdx + currentMsgMarker.length).trim();
    }

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
        model: CORTEX_ROUTE,
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

// ---- Intake processing (Phase 3: memory + active scan + attach) ----
async function processIntake(intake) {
  await ensureProjectsLoaded();
  await ensureProcessesLoaded();
  log('INFO', `Processing intake: ${intake.id} from ${intake.source}`);

  // Claim the intake
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'claimed',
    claimed_at: now(),
  });

  // Phase 3: Active envelope scan (moved before ACK for mission-aware acknowledgments)
  const activeEnvelopes = await scanActiveEnvelopes();

  // Phase 7A: Quick ack — immediately tell the user we received it (with mission + recent context)
  if (intake.source && intake.source !== 'brain' && intake.source !== 'system' && !intake.quick_ack_sent) {
    const recentMissions = await scanRecentMissions(5);
    const ackText = await generateAck(intake.text || '', activeEnvelopes, recentMissions);
    const ackId = generateId('ack');
    await firestoreWrite('work', ackId, {
      id: ackId,
      type: 'T',
      parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'complete',
      intent: 'ack',
      instruction: 'Quick acknowledgment',
      output: ackText,
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
      delivery_status: 'pending',
    });
    log('INFO', `Quick ack sent: ${ackId} — "${ackText.substring(0, 60)}"`);

    // Set in-memory and write to Firestore to prevent multiple ACKs if this intake retries
    intake.quick_ack_sent = true;
    await firestoreWrite('intake', intake.id, {
      ...intake,
      status: 'claimed',
      claimed_at: now(),
      quick_ack_sent: true,
    });
  }

  // Phase 3+: Dual memory recall
  // First recall: ambient context from raw inbound text (helps classify)
  const ambientMemory = await recallMemory(intake.text);

  // Call Cortex in classify mode (with ambient memory)
  const decision = await callCortex('classify', {
    inbound: {
      text: intake.text,
      source: intake.source,
      source_meta: intake.source_meta || {},
    },
    memory: ambientMemory,
    active_envelopes: activeEnvelopes,
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

  // Handle short_circuit from classify — respond immediately, no envelope needed
  if (decision.action === 'short_circuit' && decision.response) {
    const scId = generateId('w');
    await firestoreWrite('work', scId, {
      id: scId,
      type: 'T',
      parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'complete',
      intent: 'short_circuit',
      instruction: intake.text,
      accept_criteria: null,
      context_summary: null,
      output: decision.response,
      children: [],
      context_forward: null,
      error: null,
      source_channel: intake.source,
      source_meta: intake.source_meta || {},
      created_at: now(),
      started_at: now(),
      completed_at: now(),
      updated_at: now(),
      iteration: 0,
      delivery_status: 'pending',
    });
    log('INFO', `Classify short_circuit: ${scId} — responded directly`);
    return;
  }

  // Create envelope based on classification
  const classification = decision.classification || 'new_task';

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
    type: classification === 'new_mission' ? 'M' : 'T',
    parent_id: null,
    owner: AGENT_EMAIL || AGENT_ID,
    status: 'pending',
    intent: decision.intent || 'decide',
    instruction: decision.instruction || intake.text,
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
    instruction: decision.instruction || intake.text,
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

    const decision = await callCortex('decide', {
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

    // ---- Normalize LLM response variants ----
    // Cortex sometimes returns alternative formats (e.g., "dispatches" array,
    // missing "action" with "agent" present, "instruction" instead of "task").
    // Normalize to the canonical flat format before the action switch.
    if (!decision.action && decision.dispatches && Array.isArray(decision.dispatches) && decision.dispatches.length > 0) {
      const d = decision.dispatches[0];
      decision.action = 'dispatch';
      decision.agent = d.agent;
      decision.task = d.task || d.instruction;
      decision.intent = d.intent;
      decision.accept_criteria = d.accept_criteria || d.criteria;
      log('INFO', `Normalized dispatches[] format → dispatch to ${decision.agent}`);
    }
    if (!decision.action && decision.agent && (decision.task || decision.instruction)) {
      decision.action = 'dispatch';
      decision.task = decision.task || decision.instruction;
      log('INFO', `Normalized flat-no-action format → dispatch to ${decision.agent}`);
    }
    if (!decision.action && decision.response) {
      // Cortex returned a response without action — treat as short_circuit
      decision.action = 'short_circuit';
      log('INFO', `Normalized response-no-action → short_circuit`);
    }

    const action = decision.action;
    log('INFO', `Cortex decision: action=${action} (iteration ${iteration})`);

    if (action === 'short_circuit') {
      envelope.output = decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Short-circuit response');
      log('INFO', `Envelope ${envelope.id} complete (short_circuit)`);
      await cleanupSharedWorkspace(envelope.id);
      return;
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

      envelope.output = decision.synthesis || decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      if (!envelope.parent_id) envelope.delivery_status = 'pending';
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Synthesized response');
      log('INFO', `Envelope ${envelope.id} complete (synthesize)`);

      // Phase 3: Write completed work to memory (synthesize only, not short_circuit)
      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);
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
          result: `[SELF-UNBLOCK CHECK] Before accepting this failure, try to find an alternative approach. Can you resolve this yourself using a different method? If YES: use "dispatch" to try the alternative. If NO — this is a genuine external dependency you cannot work around — use "blocked" action with a concrete blocker description. Do NOT use synthesize_with_failure; use "blocked" instead.`,
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

    if (action === 'continue') {
      // Continue a timed-out task — re-dispatch with continuation context
      const lastTimedOut = [...priorResults].reverse().find(r => r.timedOut);
      if (!lastTimedOut) {
        priorResults.push({ agent: 'system', result: '[SYSTEM] No timed-out task to continue. Use "dispatch" instead.' });
        continue;
      }
      const agentId = lastTimedOut.agent || 'motor';
      const guidance = decision.guidance || '';
      const continuationTask = [
        `[CONTINUATION] A previous attempt at this task timed out. Before doing anything, CHECK what was already accomplished (files written, containers built, services deployed) so you don't redo completed work.`,
        ``,
        `Original task: ${lastTimedOut.task}`,
        guidance ? `\nAdditional guidance: ${guidance}` : '',
      ].filter(Boolean).join('\n');

      // Rewrite decision to look like a dispatch and fall through
      decision.agent = agentId;
      decision.task = continuationTask;
      // Fall through to dispatch handler below
    }

    if (action === 'dispatch' || action === 'continue') {
      const agentId = decision.agent;
      const task = decision.task || decision.instruction || '';
      const criteria = decision.accept_criteria || '';

      if (!agentId) {
        log('ERROR', `Dispatch missing agent field`);
        priorResults.push({ agent: 'system', result: '[SYSTEM] Dispatch requires an "agent" field.' });
        continue;
      }

      // Create child Task envelope
      const childId = generateId('w');
      const childEnvelope = {
        id: childId,
        type: 'T',
        parent_id: envelope.id,
        owner: AGENT_EMAIL || AGENT_ID,
        status: 'active',
        intent: decision.intent || 'execute',
        instruction: task,
        accept_criteria: criteria,
        context_summary: envelope.context_summary || null,
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: 'brain',
        source_meta: { dispatched_by: envelope.id },
        project_id: envelope.project_id || null,
        created_at: now(),
        started_at: now(),
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      await firestoreWrite('work', childId, childEnvelope);
      await writeHistory(childId, null, 'active', 'brain', `Dispatched to ${agentId}`);

      // Track child on parent
      envelope.children.push(childId);
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);

      log('INFO', `Dispatching child ${childId} to ${agentId}: ${task.substring(0, 100)}`);

      // Prepend project context for dispatches (all agent types, not just motor)
      if (envelope.project_id) {
        const projCtx = buildProjectContext(envelope.project_id, envelope.context);
        if (projCtx) {
          childEnvelope.instruction = `[PROJECT CONTEXT]\n${projCtx}\n[END PROJECT CONTEXT]\n\n${childEnvelope.instruction}`;
        }
      }

      // Call the agent
      const result = await callAgent(agentId, childEnvelope);

      // Update child envelope with result
      childEnvelope.output = result.output || result.error;
      childEnvelope.status = result.success ? 'complete' : (result.timedOut ? 'timed_out' : 'failed');
      childEnvelope.error = result.error;
      childEnvelope.completed_at = now();
      childEnvelope.updated_at = now();
      await firestoreWrite('work', childId, childEnvelope);

      // Context backfill: if motor created resources, update null-ref context entries
      if (agentId === 'motor' && result.success && envelope.context) {
        await backfillContextRefs(envelope, result.output);
      }

      await writeHistory(childId, 'active', childEnvelope.status, agentId,
        result.success ? `Completed (${result.durationMs}ms)` : (result.timedOut ? `Timed out (${result.durationMs}ms)` : `Failed: ${result.error}`));

      // Feed result back to Cortex
      priorResults.push({
        agent: agentId,
        task: task.substring(0, 200),
        result: result.success
          ? smartTruncate(result.output || '', CTX_CORTEX_STEP)
          : result.timedOut
            ? `[TIMED OUT after ${Math.round(result.durationMs / 1000)}s] ${result.error}`
            : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_DISPATCH_FAILURE)}`,
        success: result.success,
        durationMs: result.durationMs,
        timedOut: result.timedOut || false,
      });

      // Inject context — different for timeouts vs hard failures
      if (result.timedOut) {
        priorResults.push({
          agent: 'system',
          result: `[TIMEOUT] The dispatch to ${agentId} timed out after ${Math.round(result.durationMs / 1000)}s. ` +
            `The work may have partially completed on the system. Options:\n` +
            `(1) "continue" — re-dispatch to ${agentId} with instructions to CHECK what was already done and continue from where it left off\n` +
            `(2) "dispatch" — try a DIFFERENT, simpler approach (break the task into smaller steps)\n` +
            `(3) "synthesize_with_failure" — bail if this genuinely cannot be completed\n\n` +
            `IMPORTANT: If you choose "continue", provide a "guidance" field with any hints about what to check first. ` +
            `If you choose "dispatch", use a simpler instruction that avoids the timeout.`,
        });
      } else if (!result.success) {
        const sourceInfo = envelope.source_channel
          ? `The task came from ${envelope.source_channel}${envelope.source_meta?.space_name ? ' (' + envelope.source_meta.space_name + ')' : ''} — that is where you should escalate.`
          : '';
        priorResults.push({
          agent: 'system',
          result: `[FAILURE DIRECTIVE] The dispatch to ${agentId} FAILED. You MUST investigate and fix the root cause — do NOT synthesize a speculative or hopeful response. Options: (1) dispatch motor to debug (check logs, verify state, try alternate approach), (2) dispatch temporal-research for solutions, (3) retry with a corrected approach. If you have genuinely exhausted all options after multiple attempts, use the "blocked" action with a concrete blocker description (blocker, blocker_type, escalation_message) — your escalation MUST state exactly what you need (permissions, access, information, resources), who can provide it, and what specific action to take. Do NOT just report the problem — come back with what you need to unblock the work.\n\nPERMISSION ERRORS: If the failure is a GCP IAM permission denied error, your escalation_message MUST include: (a) the exact service account that needs the permission, (b) the specific IAM role(s) required, (c) the target GCP project, and (d) the exact gcloud command to grant it (e.g. "gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:SA@PROJECT.iam.gserviceaccount.com --role=roles/ROLE_NAME"). ${sourceInfo}`,
        });
      }

      log('INFO', `Child ${childId} ${result.success ? 'completed' : (result.timedOut ? 'timed out' : 'failed')} (${result.durationMs}ms)`);
      continue;
    }

    if (action === 'plan') {
      // Phase 4: Multi-step plan — execute steps sequentially with context accumulation
      const steps = decision.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        log('ERROR', `Plan has no steps`);
        priorResults.push({ agent: 'system', result: '[SYSTEM] Plan requires a non-empty "steps" array.' });
        continue;
      }

      log('INFO', `Plan received: ${steps.length} steps`);

      let planContext = []; // Accumulated results from plan steps
      let planFailed = false;

      for (let si = 0; si < steps.length; si++) {
        const step = steps[si];
        const stepNum = si + 1;
        const stepAgent = step.agent;
        const stepTask = step.task || step.instruction || '';
        const stepCriteria = step.accept_criteria || '';

        if (!stepAgent) {
          log('WARN', `Plan step ${stepNum} missing agent, skipping`);
          planContext.push({ step: stepNum, agent: 'unknown', result: '[SKIPPED] No agent specified', success: false });
          continue;
        }

        // Create child Task envelope for this plan step
        const stepChildId = generateId('w');
        const stepChild = {
          id: stepChildId,
          type: 'T',
          parent_id: envelope.id,
          owner: AGENT_EMAIL || AGENT_ID,
          status: 'active',
          intent: step.intent || 'execute',
          instruction: stepTask,
          accept_criteria: stepCriteria,
          context_summary: planContext.length > 0
            ? `Prior plan steps:\n${planContext.map(r => `Step ${r.step} (${r.agent}): ${(r.result || '').substring(0, 300)}`).join('\n')}`
            : envelope.context_summary || null,
          output: null,
          children: [],
          context_forward: null,
          error: null,
          source_channel: 'brain',
          source_meta: { dispatched_by: envelope.id, plan_step: stepNum, plan_total: steps.length },
          project_id: envelope.project_id || null,
          created_at: now(),
          started_at: now(),
          completed_at: null,
          updated_at: now(),
          iteration: 0,
        };

        await firestoreWrite('work', stepChildId, stepChild);
        await writeHistory(stepChildId, null, 'active', 'brain', `Plan step ${stepNum}/${steps.length}: ${stepAgent}`);

        // Track child on parent
        envelope.children.push(stepChildId);
        envelope.updated_at = now();
        await firestoreWrite('work', envelope.id, envelope);

        log('INFO', `Plan step ${stepNum}/${steps.length}: dispatching to ${stepAgent} — ${stepTask.substring(0, 80)}`);

        // Prepend project context for plan steps (all agent types)
        if (envelope.project_id) {
          const projCtx = buildProjectContext(envelope.project_id, envelope.context);
          if (projCtx) {
            stepChild.instruction = `[PROJECT CONTEXT]\n${projCtx}\n[END PROJECT CONTEXT]\n\n${stepChild.instruction}`;
          }
        }


        // Build instruction with context for the agent
        const contextForAgent = {
          instruction: stepTask,
          accept_criteria: stepCriteria,
          context_summary: planContext.length > 0
            ? planContext.map(r => `Step ${r.step} (${r.agent}): ${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n')
            : undefined,
          prior_results_context: planContext.length > 0
            ? planContext.map(r => `## Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n\n')
            : undefined,
        };

        // Dispatch to the agent
        let result = await callAgent(stepAgent, contextForAgent);

        // Retry once on failure
        if (!result.success) {
          log('WARN', `Plan step ${stepNum} failed (${stepAgent}): ${result.error}. Retrying...`);
          const retryInstruction = {
            instruction: `${stepTask}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.`,
            accept_criteria: stepCriteria,
            context_summary: contextForAgent.context_summary,
          };
          result = await callAgent(stepAgent, retryInstruction);
        }

        // Update child envelope with result
        stepChild.output = result.output || result.error;
        stepChild.status = result.success ? 'complete' : 'failed';
        stepChild.error = result.error;
        stepChild.completed_at = now();
        stepChild.updated_at = now();
        await firestoreWrite('work', stepChildId, stepChild);
        await writeHistory(stepChildId, 'active', stepChild.status, stepAgent,
          result.success ? `Completed (${result.durationMs}ms)` : `Failed: ${result.error}`);

        planContext.push({
          step: stepNum,
          agent: stepAgent,
          task: stepTask.substring(0, 200),
          result: result.success
            ? smartTruncate(result.output || '', CTX_AGENT_STEP)
            : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_AGENT_STEP)}`,
          success: result.success,
          durationMs: result.durationMs,
        });

        log('INFO', `Plan step ${stepNum} ${result.success ? 'completed' : 'FAILED'} (${result.durationMs}ms)`);

        if (!result.success) {
          // Step failed even after retry — consult Cortex with failure context
          log('WARN', `Plan step ${stepNum} failed after retry, consulting Cortex`);
          planFailed = true;
          break;
        }
      }

      // Feed all plan results back to Cortex for synthesis (or failure handling)
      priorResults.push(...planContext.map(r => ({
        agent: r.agent,
        task: r.task,
        result: r.result,
        success: r.success,
        durationMs: r.durationMs,
        plan_step: r.step,
      })));

      if (planFailed) {
        // Add failure directive — force investigation, not handwaving
        priorResults.push({
          agent: 'system',
          result: `[FAILURE DIRECTIVE] Plan execution stopped at step ${planContext.length}/${steps.length} due to failure. You MUST investigate the root cause — do NOT synthesize a speculative success response. Options: (1) dispatch motor to debug the specific failure, (2) retry the failed step with a corrected approach, (3) dispatch temporal-research for solutions. If you have exhausted all options, use the "blocked" action with a concrete blocker description (blocker, blocker_type, escalation_message) — your escalation MUST state exactly what you need (permissions, access, information, resources), who can provide it, and what specific action to take. Do NOT just report the problem — come back with what you need to unblock the work. Plain "synthesize" is blocked when failures are unresolved.`,
        });
      }

      log('INFO', `Plan execution ${planFailed ? 'FAILED' : 'complete'}: ${planContext.length}/${steps.length} steps. Consulting Cortex for synthesis.`);
      continue; // Loop back to Cortex for synthesize decision
    }

    if (action === 'follow_process') {
      // Process execution: load process, validate parameters, convert to checkpoint_plan
      const processId = decision.processId || decision.process_id;
      await ensureProcessesLoaded();
      const process = PROCESSES[processId];

      if (!process) {
        log('ERROR', `follow_process: process '${processId}' not found`);
        priorResults.push({ agent: 'system', result: `[SYSTEM] Process '${processId}' not found. Available processes: ${Object.keys(PROCESSES).join(', ') || 'none'}` });
        continue;
      }

      const parameters = decision.parameters || {};

      // Validate required parameters
      const requiredParams = Object.entries(process.parameters || {})
        .filter(([, def]) => def && typeof def === 'object' && def.required && !def.default)
        .map(([key]) => key);
      const missingParams = requiredParams.filter(k => !(k in parameters));
      if (missingParams.length > 0) {
        log('WARN', `follow_process: missing required parameters: ${missingParams.join(', ')}`);
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Process '${process.name}' requires parameters that were not provided: ${missingParams.join(', ')}. Use needs_input to ask the user, or provide default values.`,
        });
        continue;
      }

      // Fill defaults for missing optional parameters
      for (const [key, def] of Object.entries(process.parameters || {})) {
        if (!(key in parameters) && def && typeof def === 'object' && def.default !== undefined) {
          parameters[key] = def.default;
        }
      }

      // Convert process to checkpoint_plan format
      const cpPlan = processToCheckpointPlan(process, parameters);
      if (!cpPlan) {
        priorResults.push({ agent: 'system', result: `[SYSTEM] Process '${process.name}' has no steps defined.` });
        continue;
      }

      log('INFO', `follow_process: executing '${process.name}' v${process.version || 1} with ${cpPlan.checkpoints.length} checkpoints`);

      // Merge process context template into envelope context
      if (process.contextTemplate && typeof process.contextTemplate === 'object') {
        const templateCtx = {};
        for (const [key, entry] of Object.entries(process.contextTemplate)) {
          if (entry && typeof entry === 'object') {
            // Substitute parameters in context template values
            const processed = { ...entry };
            if (processed.name) processed.name = processed.name.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
            if (processed.summary) processed.summary = processed.summary.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
            templateCtx[key] = processed;
          }
        }
        envelope.context = mergeContextPackets(envelope.context, templateCtx);
        await firestoreWrite('work', envelope.id, { ...envelope, context: envelope.context, updated_at: now() });
      }

      // Tag envelope with process metadata
      envelope.process_id = processId;
      envelope.process_version = process.version || 1;
      await firestoreWrite('work', envelope.id, envelope);

      // Increment execution count
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

      // Fall through to checkpoint_plan by overwriting action and decision
      decision = cpPlan;
      action = 'checkpoint_plan';
      // Note: falls through to checkpoint_plan handler below
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

          if (!taskAgent) {
            log('WARN', `Checkpoint ${cpNum} task ${taskNum} missing agent, skipping`);
            cpResults.push({ step: `${cpNum}.${taskNum}`, agent: 'unknown', result: '[SKIPPED]', success: false });
            continue;
          }

          // Create Task envelope under Checkpoint
          const taskId = generateId('w');
          const taskEnvelope = {
            id: taskId,
            type: 'T',
            parent_id: cpId,
            owner: AGENT_EMAIL || AGENT_ID,
            status: 'active',
            intent: task.intent || 'execute',
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
            source_meta: { dispatched_by: cpId, checkpoint: cpNum, task_step: taskNum },
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
              ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n')
              : undefined,
            prior_results_context: [...allResults, ...cpResults].length > 0
              ? [...allResults, ...cpResults].map(r => `## Step ${r.step} (${r.agent}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(r.result || '', CTX_AGENT_STEP)}`).join('\n\n')
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
              ? smartTruncate(result.output || '', CTX_AGENT_STEP)
              : `[FAILED] ${result.error}\n\n[AGENT OUTPUT]\n${smartTruncate(result.output || '(no output)', CTX_AGENT_STEP)}`,
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
        priorResults.push({
          agent: 'system',
          result: `[SYSTEM] Checkpoint plan stopped at checkpoint ${allResults.filter(r => r.step.startsWith(String(checkpoints.length))).length > 0 ? checkpoints.length : Math.ceil(allResults.length / 2)}/${checkpoints.length} due to failure. You may: adjust and retry, synthesize with partial results, or escalate (needs_input).`,
        });
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

    // Unknown action — fail
    envelope.status = 'failed';
    envelope.error = `Unknown Cortex action: ${action}`;
    envelope.completed_at = now();
    envelope.updated_at = now();
    await firestoreWrite('work', envelope.id, envelope);
    await writeHistory(envelope.id, 'active', 'failed', 'brain', envelope.error);
    log('ERROR', `Envelope ${envelope.id} failed: unknown action ${action}`);
    return;
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
const CONTEXT_TOKEN_BUDGET = CONTRACTS.brain?.context_token_budget || 400_000;
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
    execSync(`mkdir -p /home/node/.openclaw/shared/${envelopeId}`, { timeout: 3000 });
  } catch (e) {
    log('WARN', `Failed to init shared workspace for ${envelopeId}: ${e.message}`);
  }
}

async function cleanupSharedWorkspace(envelopeId) {
  try {
    const { execSync } = await import('child_process');
    execSync(`rm -rf /home/node/.openclaw/shared/${envelopeId}`, { timeout: 3000 });
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
        try {
          await firestoreWrite('intake', intake.id, { ...intake, status: 'pending', claimed_at: null });
          log('INFO', `Intake ${intake.id} reverted to pending for retry after exception`);
        } catch (revertErr) {
          log('ERROR', `Failed to revert intake ${intake.id} to pending: ${revertErr.message}`);
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
  log('INFO', `Gateway: ${GATEWAY_URL} | Route: ${CORTEX_ROUTE}`);
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
  const POLL_MS = CONTRACTS.brain?.poll_interval_ms || 3000;
  log('INFO', `Starting intake poll (every ${POLL_MS}ms)`);
  setInterval(async () => {
    await pollIntake();
    await checkWaitingEnvelopes();
  }, POLL_MS);

  // Phase 7A: Start Responsibility scheduler
  startResponsibilityScheduler();

  // Phase 7A: Watch responsibility config for hot-reload
  for (const f of [
    '/home/node/.openclaw/corekit/responsibilities.json',
    '/home/node/.openclaw/corekit/responsibilities-job.json',
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
