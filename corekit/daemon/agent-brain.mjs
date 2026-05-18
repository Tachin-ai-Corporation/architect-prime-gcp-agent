#!/usr/bin/env node
// ============================================================
// agent-brain.mjs — Brain v3 Orchestration Service
//
// Deterministic orchestration layer between Ears and Mouth.
// Processes Firestore intake records through the Cortex loop
// and manages envelopes (the R/C/M/T work hierarchy).
//
// Phase 1: intake → classify → short_circuit only
// Phase 2+: dispatch, synthesize, plan, delegate, etc.
//
// Design principles:
//   - LLMs think. Deterministic systems orchestrate.
//   - One envelope format, all scales.
//   - Firestore is the shared work repository.
//   - Memory is hardwired (Phase 3+).
//   - Agents are cognitive workers, not orchestrators.
//
// Run:
//   BRAIN_V3_ENABLED=true node agent-brain.mjs
// ============================================================
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

// ---- Feature gate ----
if (process.env.BRAIN_V3_ENABLED !== 'true') {
  console.log('[brain] BRAIN_V3_ENABLED is not true. Exiting.');
  process.exit(0);
}

// ---- Config ----
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';
const AGENT_EMAIL = process.env.AGENT_USER_EMAIL || '';
const GATEWAY_PORT = 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`;
const MAX_ITERATIONS = 12;
const LOG_FILE = '/var/log/agent-brain.log';

// ---- Contracts ----
let CONTRACTS = {};
try {
  CONTRACTS = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
} catch (e) {
  log('WARN', 'contracts.json not found, using defaults');
}
const CORTEX_ROUTE = CONTRACTS.agents?.gatewayRoute || 'openclaw/cortex';

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
    limit: 10,
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
  const userPrompt = buildUserPrompt(mode, payload);

  log('INFO', `Calling Cortex: mode=${mode}`);

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
    }),
    signal: AbortSignal.timeout(300_000), // 5 min
  });

  if (!resp.ok) {
    const text = await resp.text();
    log('ERROR', `Cortex HTTP error: ${resp.status} ${text.substring(0, 200)}`);
    return { error: `HTTP ${resp.status}`, raw: text };
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  log('DEBUG', `Cortex raw response (${content.length} chars)`);

  return parseJsonResponse(content);
}

function buildSystemPrompt(mode, payload) {
  return `You are Cortex, the guiding intelligence of agent "${AGENT_ID}".
You operate in structured JSON mode. You MUST respond with exactly one JSON block and nothing else.
Do not include markdown fences, explanatory text, or conversational preamble.

Mode: ${mode}

Agent registry (what agents you can dispatch to):
${JSON.stringify(REGISTRY.agents, null, 2)}`;
}

function buildUserPrompt(mode, payload) {
  if (mode === 'classify') {
    return JSON.stringify({
      mode: 'classify',
      inbound: payload.inbound,
      memory: payload.memory || {},
      active_envelopes: payload.active_envelopes || [],
    });
  }
  if (mode === 'decide') {
    return JSON.stringify({
      mode: 'decide',
      envelope: payload.envelope,
      memory: payload.memory || {},
      agent_registry: REGISTRY.agents,
      prior_results: payload.prior_results || [],
      iteration: payload.iteration || 1,
    });
  }
  return JSON.stringify(payload);
}

// ---- Response parser ----
function parseJsonResponse(raw) {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Try to extract JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      log('WARN', `JSON parse failed: ${e.message}`);
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

// ---- Intake processing ----
async function processIntake(intake) {
  log('INFO', `Processing intake: ${intake.id} from ${intake.source}`);

  // Claim the intake
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'claimed',
    claimed_at: now(),
  });

  // Call Cortex in classify mode
  const decision = await callCortex('classify', {
    inbound: {
      text: intake.text,
      source: intake.source,
      source_meta: intake.source_meta || {},
    },
    memory: {}, // Phase 1: empty. Phase 3: hardwired recall.
    active_envelopes: [], // Phase 1: empty. Phase 3: envelope scan.
  });

  if (decision.error) {
    log('ERROR', `Classify failed for intake ${intake.id}: ${JSON.stringify(decision)}`);
    return;
  }

  log('INFO', `Classify result: ${decision.classification || decision.action}`);

  // Create envelope based on classification
  const classification = decision.classification || 'new_task';
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
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=${envelope.type})`);

  // Write history entry
  await writeHistory(envelopeId, null, 'pending', 'brain', 'Created from intake ' + intake.id);

  // Process the envelope
  await processEnvelope(envelope);
}

// ---- Envelope processing (Phase 1: short_circuit only) ----
async function processEnvelope(envelope) {
  log('INFO', `Processing envelope: ${envelope.id} (type=${envelope.type}, status=${envelope.status})`);

  // Mark active
  envelope.status = 'active';
  envelope.started_at = now();
  envelope.updated_at = now();
  await firestoreWrite('work', envelope.id, envelope);
  await writeHistory(envelope.id, 'pending', 'active', 'brain', 'Processing started');

  // Cortex loop
  let priorResults = [];
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    envelope.iteration = iteration;

    const decision = await callCortex('decide', {
      envelope: {
        id: envelope.id,
        type: envelope.type,
        instruction: envelope.instruction,
        accept_criteria: envelope.accept_criteria,
        context_summary: envelope.context_summary,
      },
      memory: {}, // Phase 3
      prior_results: priorResults,
      iteration,
    });

    if (decision.error) {
      envelope.status = 'failed';
      envelope.error = `Cortex error: ${JSON.stringify(decision)}`;
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'failed', 'brain', envelope.error);
      log('ERROR', `Envelope ${envelope.id} failed: ${envelope.error}`);
      return;
    }

    const action = decision.action;
    log('INFO', `Cortex decision: action=${action} (iteration ${iteration})`);

    if (action === 'short_circuit') {
      // Direct response — no agent dispatch needed
      envelope.output = decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Short-circuit response');
      log('INFO', `Envelope ${envelope.id} complete (short_circuit)`);
      return;
    }

    if (action === 'synthesize') {
      // Synthesize final response from prior results
      envelope.output = decision.synthesis || decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Synthesized response');
      log('INFO', `Envelope ${envelope.id} complete (synthesize)`);
      return;
    }

    if (action === 'dispatch') {
      // Phase 2+: dispatch to agent
      // For Phase 1, treat as unsupported and fail gracefully
      log('WARN', `Dispatch requested but not yet implemented (Phase 2). Asking Cortex to short_circuit.`);
      priorResults.push({
        agent: decision.agent,
        result: `[SYSTEM] Dispatch to ${decision.agent} is not available in Phase 1. Please respond directly with short_circuit.`,
      });
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
}

// ---- History ----
let historySeq = 0;
async function writeHistory(envelopeId, prevStatus, newStatus, agent, detail) {
  historySeq++;
  await firestoreWrite(`work/${envelopeId}/history`, String(historySeq), {
    seq: historySeq,
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
// Phase 1: poll every 3 seconds for pending intake records.
let processing = false;

async function pollIntake() {
  if (processing) return;
  processing = true;

  try {
    const pending = await firestoreQuery('intake', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'pending' } },
    ]);

    for (const intake of pending) {
      try {
        await processIntake(intake);
      } catch (e) {
        log('ERROR', `Intake processing error: ${e.message}\n${e.stack}`);
      }
    }
  } catch (e) {
    log('ERROR', `Poll error: ${e.message}`);
  } finally {
    processing = false;
  }
}

// ---- Main ----
async function main() {
  log('INFO', '=== Brain v3 starting ===');
  log('INFO', `Agent: ${AGENT_ID} | Project: ${GCP_PROJECT} | Prime: ${PRIME_ID}`);
  log('INFO', `Gateway: ${GATEWAY_URL} | Route: ${CORTEX_ROUTE}`);
  log('INFO', `Registry agents: ${Object.keys(REGISTRY.agents).join(', ') || 'none loaded'}`);

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

  // Start intake polling
  const POLL_MS = CONTRACTS.brain?.poll_interval_ms || 3000;
  log('INFO', `Starting intake poll (every ${POLL_MS}ms)`);
  setInterval(pollIntake, POLL_MS);

  // Initial poll
  await pollIntake();
}

main().catch(e => {
  log('ERROR', `Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
