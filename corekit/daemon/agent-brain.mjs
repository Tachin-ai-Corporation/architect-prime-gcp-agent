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
import { readFileSync, appendFileSync, existsSync, watchFile } from 'fs';
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
const LOG_FILE = '/tmp/agent-brain.log';

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
  const userPrompt = `[BRAIN-ORCHESTRATED]\n${buildUserPrompt(mode, payload)}`;

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
      pending_intake_count: payload.pending_intake_count || 0,
      pending_queue: payload.pending_queue || [],
    });
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

  const userMessage = [
    `[BRAIN-ORCHESTRATED]`,
    instruction,
    context ? `\nContext: ${context}` : '',
    criteria ? `\nAcceptance criteria: ${criteria}` : '',
  ].filter(Boolean).join('\n');

  log('INFO', `Dispatching to ${agentId} via ${route}`);
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
      }),
      signal: AbortSignal.timeout(300_000),
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

    return { success: true, output: content, error: null, durationMs };
  } catch (e) {
    const durationMs = Date.now() - start;
    log('ERROR', `Agent ${agentId} dispatch error: ${e.message}`);
    return { success: false, output: null, error: e.message, durationMs };
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
    return {
      count: pending.length,
      queue: pending.map((item, i) => ({
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
  } catch (e) {
    log('WARN', `Memory write failed: ${e.message}`);
  }
}

// ---- Active envelope scan: query for in-progress work ----
async function scanActiveEnvelopes() {
  try {
    const active = await firestoreQuery('work', [
      { field: 'owner', op: 'EQUAL', value: { stringValue: AGENT_EMAIL || AGENT_ID } },
      { field: 'status', op: 'EQUAL', value: { stringValue: 'active' } },
    ]);
    const summaries = active
      .filter(env => !env.parent_id) // Only top-level envelopes
      .map(env => ({
        id: env.id,
        type: env.type,
        instruction: (env.instruction || '').substring(0, 120),
        status: env.status,
        updated_at: env.updated_at,
      }));
    if (summaries.length > 0) {
      log('INFO', `Active envelopes: ${summaries.length} found`);
    }
    return summaries;
  } catch (e) {
    log('WARN', `Active envelope scan failed: ${e.message}`);
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

// ---- Stale envelope cleanup ----
async function cleanupStaleEnvelopes() {
  log('INFO', 'Running stale envelope cleanup...');
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stale = await firestoreQuery('work', [
      { field: 'status', op: 'EQUAL', value: { stringValue: 'failed' } },
    ]);
    let cleaned = 0;
    for (const env of stale) {
      if (env.created_at && env.created_at < cutoff) {
        await firestoreWrite('work', env.id, { ...env, status: 'archived', updated_at: now() });
        cleaned++;
        log('INFO', `Archived stale envelope: ${env.id} (created ${env.created_at})`);
      }
    }
    log('INFO', `Stale cleanup complete: ${cleaned} archived, ${stale.length - cleaned} recent failures kept`);
  } catch (e) {
    log('WARN', `Stale cleanup error: ${e.message}`);
  }
}

// ---- Intake processing (Phase 3: memory + active scan + attach) ----
async function processIntake(intake) {
  log('INFO', `Processing intake: ${intake.id} from ${intake.source}`);

  // Claim the intake
  await firestoreWrite('intake', intake.id, {
    ...intake,
    status: 'claimed',
    claimed_at: now(),
  });

  // Phase 7A: Quick ack — immediately tell the user we received it
  if (intake.source && intake.source !== 'brain' && intake.source !== 'system') {
    const ackId = generateId('ack');
    await firestoreWrite('work', ackId, {
      id: ackId,
      type: 'T',
      parent_id: null,
      owner: AGENT_EMAIL || AGENT_ID,
      status: 'complete',
      intent: 'ack',
      instruction: 'Quick acknowledgment',
      output: `✅ Got it — working on this now.`,
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
    log('INFO', `Quick ack sent: ${ackId}`);
  }

  // Phase 3+: Dual memory recall
  // First recall: ambient context from raw inbound text (helps classify)
  const ambientMemory = await recallMemory(intake.text);

  // Phase 3: Active envelope scan (for follow-up detection)
  const activeEnvelopes = await scanActiveEnvelopes();

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

  // Create envelope based on classification
  const classification = decision.classification || 'new_task';

  // Phase 3: Handle attach classification (follow-up to existing work)
  if (classification === 'attach') {
    await handleAttach(intake, decision, memoryContext);
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
    created_at: now(),
    started_at: null,
    completed_at: null,
    updated_at: now(),
    iteration: 0,
    memory_context: memoryContext, // Phase 3: pass memory to processEnvelope
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
    targetEnv.updated_at = now();
    await firestoreWrite('work', targetId, targetEnv);
    await writeHistory(targetId, 'needs_input', 'active', 'brain', `Resumed with: ${intake.text.substring(0, 100)}`);
    await processEnvelope(targetEnv, memoryContext);
    return;
  }

  if (targetEnv.status === 'active' || targetEnv.status === 'waiting') {
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

  // For complete or other statuses, treat as a new follow-up task
  log('INFO', `Attach target ${targetId} is ${targetEnv.status}, creating follow-up task`);
  return processIntakeAsNewTask(intake, decision, memoryContext);
}

// ---- Helper: create new task from intake when attach falls through ----
async function processIntakeAsNewTask(intake, decision, memoryContext) {
  const envelopeId = generateId('w');
  const envelope = {
    id: envelopeId,
    type: 'T',
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
    memory_context: memoryContext,
  };

  await firestoreWrite('work', envelopeId, envelope);
  log('INFO', `Created envelope: ${envelopeId} (type=T, fallback from attach)`);
  await writeHistory(envelopeId, null, 'pending', 'brain', 'Created from intake ' + intake.id);
  await processEnvelope(envelope, memoryContext);
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

    const decision = await callCortex('decide', {
      envelope: {
        id: envelope.id,
        type: envelope.type,
        instruction: envelope.instruction,
        accept_criteria: envelope.accept_criteria,
        context_summary: envelope.context_summary,
      },
      memory,
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

    // Normalize: treat 'delegate' as 'dispatch' until Phase 6 formalizes delegation
    const action = (decision.action === 'delegate') ? 'dispatch' : decision.action;
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
      const hasUnresolvedFail = priorResults.some(r => r.success === false);
      if (hasUnresolvedFail && iteration < MAX_ITERATIONS - 1) {
        log('WARN', `Blocking premature synthesize — unresolved failures in prior_results (iteration ${iteration})`);
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
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain', 'Synthesized response');
      log('INFO', `Envelope ${envelope.id} complete (synthesize)`);

      // Phase 3: Write completed work to memory (synthesize only, not short_circuit)
      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);
      return;
    }

    if (action === 'synthesize_with_failure') {
      // Explicit failure acknowledgment — Cortex admits something didn't work
      envelope.output = decision.synthesis || decision.response;
      envelope.status = 'complete';
      envelope.completed_at = now();
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'complete', 'brain',
        `Synthesized with acknowledged failure: ${(decision.failure_summary || '').substring(0, 200)}`);
      log('INFO', `Envelope ${envelope.id} complete (synthesize_with_failure: ${(decision.failure_summary || '').substring(0, 80)})`);

      await writeMemory(envelope);
      await cleanupSharedWorkspace(envelope.id);
      return;
    }

    if (action === 'manage_responsibility') {
      // Phase 7A: Cortex self-manages responsibilities
      const op = decision.operation;
      const respFile = '/home/node/.openclaw/corekit/responsibilities-job.json';
      let config = { version: 1, responsibilities: [] };
      try { config = JSON.parse(readFileSync(respFile, 'utf8')); } catch { /* new file */ }

      let resultMsg = '';

      if (op === 'create') {
        const newResp = decision.responsibility;
        if (!newResp || !newResp.id || !newResp.schedule || !newResp.instruction) {
          priorResults.push({ agent: 'system', result: '[SYSTEM] manage_responsibility create requires responsibility with id, schedule, instruction, and context.' });
          continue;
        }
        // Enforce min_spacing_minutes default
        if (!newResp.min_spacing_minutes) newResp.min_spacing_minutes = 30;
        // Ensure enabled
        if (newResp.enabled === undefined) newResp.enabled = true;
        // Deduplicate
        config.responsibilities = config.responsibilities.filter(r => r.id !== newResp.id);
        config.responsibilities.push(newResp);
        resultMsg = `Responsibility "${newResp.name || newResp.id}" created with schedule "${newResp.schedule}". Next fire will be calculated on reload.`;
        log('INFO', `Responsibility created: ${newResp.id} (${newResp.schedule})`);

      } else if (op === 'update') {
        const targetId = decision.responsibility_id;
        const updates = decision.updates || {};
        const idx = config.responsibilities.findIndex(r => r.id === targetId);
        if (idx === -1) {
          priorResults.push({ agent: 'system', result: `[SYSTEM] Responsibility "${targetId}" not found.` });
          continue;
        }
        // Deep merge context if provided
        if (updates.context) {
          config.responsibilities[idx].context = { ...config.responsibilities[idx].context, ...updates.context };
          delete updates.context;
        }
        Object.assign(config.responsibilities[idx], updates);
        resultMsg = `Responsibility "${targetId}" updated.`;
        log('INFO', `Responsibility updated: ${targetId}`);

      } else if (op === 'remove') {
        const targetId = decision.responsibility_id;
        const before = config.responsibilities.length;
        config.responsibilities = config.responsibilities.filter(r => r.id !== targetId);
        if (config.responsibilities.length === before) {
          priorResults.push({ agent: 'system', result: `[SYSTEM] Responsibility "${targetId}" not found.` });
          continue;
        }
        resultMsg = `Responsibility "${targetId}" removed.`;
        log('INFO', `Responsibility removed: ${targetId}`);

      } else if (op === 'list') {
        const list = config.responsibilities.map(r => ({
          id: r.id,
          name: r.name,
          schedule: r.schedule,
          enabled: r.enabled,
          min_spacing_minutes: r.min_spacing_minutes,
          instruction: (r.instruction || '').substring(0, 200),
          has_process: !!(r.context?.process?.length),
          next_fire: _respNextFire[r.id]?.toISOString() || 'not scheduled',
        }));
        resultMsg = list.length > 0
          ? `Current responsibilities:\n${JSON.stringify(list, null, 2)}`
          : 'No responsibilities configured.';

      } else {
        priorResults.push({ agent: 'system', result: `[SYSTEM] Unknown manage_responsibility operation: ${op}. Use create, update, remove, or list.` });
        continue;
      }

      // Write config and reload scheduler
      if (op !== 'list') {
        const { writeFileSync } = await import('fs');
        writeFileSync(respFile, JSON.stringify(config, null, 2), 'utf8');
        loadResponsibilities();
        // Recalculate all next-fire times
        _respNextFire = {};
        for (const r of RESPONSIBILITIES) {
          if (r.enabled) _respNextFire[r.id] = cronNextFire(r.schedule);
        }
        log('INFO', `Responsibilities reloaded after ${op}: ${RESPONSIBILITIES.length} total`);
      }

      priorResults.push({ agent: 'system', result: resultMsg, success: true });
      log('INFO', `manage_responsibility ${op}: ${resultMsg.substring(0, 100)}`);
      continue;
    }

    if (action === 'needs_input') {
      // Phase 3: Block envelope and ask the human for clarification
      envelope.output = decision.question || decision.message || 'I need more information to proceed.';
      envelope.status = 'needs_input';
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'needs_input', 'brain', `Needs: ${decision.what_is_needed || 'clarification'}`);
      log('INFO', `Envelope ${envelope.id} blocked (needs_input)`);
      return;
    }

    if (action === 'dispatch') {
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

      // Call the agent
      const result = await callAgent(agentId, childEnvelope);

      // Update child envelope with result
      childEnvelope.output = result.output || result.error;
      childEnvelope.status = result.success ? 'complete' : 'failed';
      childEnvelope.error = result.error;
      childEnvelope.completed_at = now();
      childEnvelope.updated_at = now();
      await firestoreWrite('work', childId, childEnvelope);
      await writeHistory(childId, 'active', childEnvelope.status, agentId,
        result.success ? `Completed (${result.durationMs}ms)` : `Failed: ${result.error}`);

      // Feed result back to Cortex
      priorResults.push({
        agent: agentId,
        task: task.substring(0, 200),
        result: result.success
          ? (result.output || '').substring(0, 4000)
          : `[FAILED] ${result.error}`,
        success: result.success,
        durationMs: result.durationMs,
      });

      // Inject failure directive — force Cortex to investigate, not handwave
      if (!result.success) {
        priorResults.push({
          agent: 'system',
          result: `[FAILURE DIRECTIVE] The dispatch to ${agentId} FAILED. You MUST investigate and fix the root cause — do NOT synthesize a speculative or hopeful response. Options: (1) dispatch motor to debug (check logs, verify state, try alternate approach), (2) dispatch temporal-research for solutions, (3) retry with a corrected approach. If you have genuinely exhausted all options after multiple attempts, use "synthesize_with_failure" to honestly report what failed and why.`,
        });
      }

      log('INFO', `Child ${childId} ${result.success ? 'completed' : 'failed'} (${result.durationMs}ms)`);
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

        // Build instruction with context for the agent
        const contextForAgent = {
          instruction: stepTask,
          accept_criteria: stepCriteria,
          context_summary: planContext.length > 0
            ? planContext.map(r => `Step ${r.step} (${r.agent}): ${(r.result || '').substring(0, 500)}`).join('\n')
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
            ? (result.output || '').substring(0, 4000)
            : `[FAILED] ${result.error}`,
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
          result: `[FAILURE DIRECTIVE] Plan execution stopped at step ${planContext.length}/${steps.length} due to failure. You MUST investigate the root cause — do NOT synthesize a speculative success response. Options: (1) dispatch motor to debug the specific failure, (2) retry the failed step with a corrected approach, (3) dispatch temporal-research for solutions. If you have exhausted all options, use \"synthesize_with_failure\" with honest failure details. Plain \"synthesize\" is blocked when failures are unresolved.`,
        });
      }

      log('INFO', `Plan execution ${planFailed ? 'FAILED' : 'complete'}: ${planContext.length}/${steps.length} steps. Consulting Cortex for synthesis.`);
      continue; // Loop back to Cortex for synthesize decision
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
          created_at: now(),
          started_at: now(),
          completed_at: null,
          updated_at: now(),
          iteration: 0,
        };

        await firestoreWrite('work', cpId, cpEnvelope);
        await writeHistory(cpId, null, 'active', 'brain', `Checkpoint ${cpNum}/${checkpoints.length}: ${cpInstruction.substring(0, 60)}`);
        await initSharedWorkspace(cpId);

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

          // Dispatch to agent
          let result = await callAgent(taskAgent, {
            instruction: taskDesc,
            accept_criteria: taskCriteria,
            context_summary: [...allResults, ...cpResults].length > 0
              ? [...allResults, ...cpResults].map(r => `Step ${r.step} (${r.agent}): ${(r.result || '').substring(0, 500)}`).join('\n')
              : undefined,
          });

          // Retry once on failure
          if (!result.success) {
            log('WARN', `CP${cpNum} Task ${taskNum} failed (${taskAgent}): ${result.error}. Retrying...`);
            result = await callAgent(taskAgent, {
              instruction: `${taskDesc}\n\n[RETRY] Previous attempt failed: ${result.error}. Try again with adjusted approach.`,
              accept_criteria: taskCriteria,
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
            result: result.success ? (result.output || '').substring(0, 4000) : `[FAILED] ${result.error}`,
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
        await cleanupSharedWorkspace(cpId);

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

    if (action === 'delegate') {
      // Phase 6: Inter-agent delegation — create Mission owned by delegate
      const delegateTo = decision.delegate_to;
      const delegationTask = decision.delegation_task || decision.task;
      const delegationCriteria = decision.accept_criteria || '';

      if (!delegateTo || !delegationTask) {
        log('ERROR', `Delegate action missing delegate_to or delegation_task`);
        priorResults.push({ agent: 'system', result: '[SYSTEM] delegate requires delegate_to and delegation_task fields.' });
        continue;
      }

      log('INFO', `Delegating to ${delegateTo}: ${delegationTask.substring(0, 80)}`);

      // Create delegated Mission envelope
      const delegatedId = generateId('w');
      const delegatedEnvelope = {
        id: delegatedId,
        type: 'M',
        parent_id: envelope.id,
        owner: delegateTo,
        status: 'pending',
        intent: 'delegated',
        instruction: delegationTask,
        accept_criteria: delegationCriteria,
        context_summary: decision.context || envelope.context_summary || null,
        output: null,
        children: [],
        context_forward: null,
        error: null,
        source_channel: 'brain',
        source_meta: {
          delegated_by: AGENT_EMAIL || AGENT_ID,
          delegated_from: envelope.id,
          reasoning: decision.reasoning || '',
        },
        created_at: now(),
        started_at: null,
        completed_at: null,
        updated_at: now(),
        iteration: 0,
      };

      await firestoreWrite('work', delegatedId, delegatedEnvelope);
      await writeHistory(delegatedId, null, 'pending', 'brain',
        `Delegated by ${AGENT_ID} to ${delegateTo}`);

      // Track on parent
      envelope.children.push(delegatedId);

      // Mark current envelope as waiting
      envelope.status = 'waiting';
      envelope.updated_at = now();
      await firestoreWrite('work', envelope.id, envelope);
      await writeHistory(envelope.id, 'active', 'waiting', 'brain',
        `Delegated to ${delegateTo}: ${delegationTask.substring(0, 60)}`);

      log('INFO', `Envelope ${envelope.id} waiting on delegation ${delegatedId} to ${delegateTo}`);

      // Courtesy notification (fire-and-forget)
      try {
        const { execSync } = await import('child_process');
        execSync(`chat-send "📋 Delegated task to ${delegateTo}: ${delegationTask.substring(0, 80).replace(/"/g, "'")}"`, { timeout: 10000 });
      } catch (e) {
        log('WARN', `Delegation notification failed: ${e.message}`);
      }

      return; // Exit cortex loop — will resume when delegation completes
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

  // Stale envelope cleanup
  await cleanupStaleEnvelopes();

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
