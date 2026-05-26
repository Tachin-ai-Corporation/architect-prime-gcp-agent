#!/usr/bin/env node
// ============================================================
// agent-ears.mjs — Deterministic Input Processing Service
//
// 100% deterministic — ZERO LLM calls.
// Polls channels for input, deduplicates, writes TASK.json,
// and fires gateway call (non-blocking).
//
// The Mouth service handles ALL output delivery.
//
// Channels:
//   - Firestore (Prime/Dashboard)
//   - Google Chat via DWD (Fleet)
//
// Run:
//   CHANNEL=gchat node agent-ears.mjs
//   CHANNEL=dashboard node agent-ears.mjs
// ============================================================
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { hostname as osHostname } from 'os';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';

// Agent hostname for Firestore path
// hostname() returns e.g. "fleet-chucknorris-tom"
// Strip "fleet-" and then "{primeId}-" to get "tom" matching Firestore doc IDs
let AGENT_HOSTNAME = '';
try {
  const raw = osHostname().replace(/^fleet-/, '');
  AGENT_HOSTNAME = PRIME_ID && raw.startsWith(`${PRIME_ID}-`)
    ? raw.slice(PRIME_ID.length + 1)
    : raw;
} catch {}

const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const HTTP_TIMEOUT = 600_000;

// Ears-specific config (from contracts or env)
let EARS_CONFIG = { firestore_poll_ms: 3000, gchat_poll_ms: 5000, dedup_window_ms: 300000, cooldown_ms: 2000 };
let CONTRACTS = { ears: {}, vertex: {} };
try {
  CONTRACTS = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
  if (CONTRACTS.ears) EARS_CONFIG = { ...EARS_CONFIG, ...CONTRACTS.ears };
} catch {}

const POLL_INTERVAL = CHANNEL === 'gchat' ? EARS_CONFIG.gchat_poll_ms : EARS_CONFIG.firestore_poll_ms;
const DEDUP_WINDOW = EARS_CONFIG.dedup_window_ms;
const COOLDOWN_MS = EARS_CONFIG.cooldown_ms;
const CONTEXT_WINDOW = EARS_CONFIG.gchat_context_messages || 5;

// Preprocessing config (LLM-based message repair for gchat)
const PREPROCESS_CFG = EARS_CONFIG.preprocess || {};
const PREPROCESS_ENABLED = PREPROCESS_CFG.enabled === true && CHANNEL === 'gchat';
const PREPROCESS_MODEL = PREPROCESS_CFG.model || 'gemini-2.5-flash';
const PREPROCESS_MAX_TOKENS = PREPROCESS_CFG.maxTokens || 2000;
const PREPROCESS_TEMPERATURE = PREPROCESS_CFG.temperature ?? 0.0;

// Vertex AI config
const VERTEX_PROJECT = process.env.GCP_PROJECT_ID;
const VERTEX_LOCATION = CONTRACTS.vertex?.location || process.env.GOOGLE_CLOUD_LOCATION || 'global';

// GChat-specific config
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const AGENT_MENTION = process.env.AGENT_MENTION || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';

// Identity lockdown: refuse to impersonate any email other than the locked one
const IDENTITY_LOCK_PATH = '/home/node/.openclaw/.identity-lock';
try {
  const lockedEmail = readFileSync(IDENTITY_LOCK_PATH, 'utf8').trim();
  if (lockedEmail && AGENT_USER_EMAIL && lockedEmail !== AGENT_USER_EMAIL) {
    console.error(`[ears] FATAL: AGENT_USER_EMAIL (${AGENT_USER_EMAIL}) does not match .identity-lock (${lockedEmail}). Refusing to start.`);
    process.exit(99);
  }
} catch {
  // No lock file yet — allowed during initial bootstrap
}

// Firestore URL (Prime)
const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

// Gateway auth token
let GATEWAY_TOKEN = 'no-token';
try {
  GATEWAY_TOKEN = readFileSync('/root/.openclaw/.gateway-token', 'utf8').trim();
} catch {
  try {
    const cfg = JSON.parse(readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
    GATEWAY_TOKEN = cfg.gateway?.auth?.token || 'no-token';
  } catch {}
}

// Gateway route from contracts.json
let GATEWAY_ROUTE = 'openclaw/cortex';
try {
  const contracts = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
  GATEWAY_ROUTE = contracts.agents?.gatewayRoute || GATEWAY_ROUTE;
} catch {}

// TASK.json path (for mouth tracking)
const TASK_JSON = '/home/node/.openclaw/workspace/TASK.json';

// ---- Shared state ----
const recentMessages = new Map();            // dedup by content hash
const lastSeen = new Map();                  // sender → timestamp (cooldown)
const conversationHistory = [];
const MAX_HISTORY = 4;

// ---- Logging ----
const EARS_LOG = '/var/log/agent-ears.log';
const PREPROCESS_LOG = '/var/log/agent-ears-preprocess.log';
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-ears', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(EARS_LOG, line); } catch {}
}

// ---- Preprocess Prompt ----
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
let PREPROCESS_PROMPT = '';
if (PREPROCESS_ENABLED) {
  for (const base of [SCRIPT_DIR, '/home/node/.openclaw/bin']) {
    try { PREPROCESS_PROMPT = readFileSync(`${base}/ears-preprocess-prompt.md`, 'utf8'); break; } catch {}
  }
  if (!PREPROCESS_PROMPT) log('WARN: preprocess enabled but prompt file not found');
}

// ---- LLM Call (Vertex AI, same pattern as mouth) ----
async function callLLM(systemPrompt, userText) {
  const token = await getAccessToken();
  const loc = VERTEX_LOCATION;
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${loc}/publishers/google/models/${PREPROCESS_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: PREPROCESS_TEMPERATURE,
        maxOutputTokens: PREPROCESS_MAX_TOKENS,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---- Message Preprocessing ----
async function preprocessMessage(text) {
  if (!PREPROCESS_ENABLED || !PREPROCESS_PROMPT) return text;

  try {
    const start = Date.now();
    const raw = await callLLM(PREPROCESS_PROMPT, text);
    const result = JSON.parse(raw);
    const elapsed = Date.now() - start;

    // Audit log — always write what came in and what goes out
    const audit = {
      ts: new Date().toISOString(),
      original: text.slice(0, 500),
      cleaned: (result.cleaned || text).slice(0, 500),
      repairs: result.repairs || [],
      confidence: result.confidence || 'unknown',
      elapsed_ms: elapsed
    };
    try { appendFileSync(PREPROCESS_LOG, JSON.stringify(audit) + '\n'); } catch {}

    if (result.repairs && result.repairs.length > 0) {
      log('Preprocess repaired message', {
        repairs: result.repairs,
        confidence: result.confidence,
        elapsed_ms: elapsed
      });
      return result.cleaned || text;
    }

    // No repairs needed
    return text;
  } catch (err) {
    log('Preprocess error (passing through raw)', { error: err.message });
    return text; // Never block on preprocess failure
  }
}

// ---- GCE Metadata Access Token ----
let _metaToken = null;
let _metaExpiry = 0;
async function getAccessToken() {
  if (_metaToken && Date.now() < _metaExpiry) return _metaToken;
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  const data = await res.json();
  _metaToken = data.access_token;
  _metaExpiry = Date.now() + (data.expires_in - 120) * 1000;
  return _metaToken;
}

// ---- DWD Token (Domain-Wide Delegation) ----
let _dwdToken = null;
let _dwdExpiry = 0;
const DWD_SCOPES = 'https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly';

async function getDwdToken() {
  if (_dwdToken && Date.now() < _dwdExpiry) return _dwdToken;
  const metaBase = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
  const mh = { 'Metadata-Flavor': 'Google' };
  const vmSaEmail = await fetch(`${metaBase}/email`, { headers: mh }).then(r => r.text());
  const metaTokenData = await fetch(`${metaBase}/token`, { headers: mh }).then(r => r.json());
  const metaToken = metaTokenData.access_token;
  const signerSa = DWD_SIGNER_SA || vmSaEmail;
  const now = Math.floor(Date.now() / 1000);
  const claim = JSON.stringify({
    iss: signerSa, sub: AGENT_USER_EMAIL, scope: DWD_SCOPES,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const signUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${signerSa}:signJwt`;
  const signRes = await fetch(signUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: claim })
  });
  if (!signRes.ok) {
    const err = await signRes.text();
    throw new Error(`signJwt failed (${signRes.status}): ${err.slice(0, 200)}`);
  }
  const { signedJwt } = await signRes.json();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`DWD token exchange failed: ${tokenData.error_description || tokenData.error}`);
  _dwdToken = tokenData.access_token;
  _dwdExpiry = Date.now() + 3500_000;
  return _dwdToken;
}

// ---- TASK.json (channel metadata for Mouth) ----
function writeTaskJson(msg, taskId) {
  const task = {
    taskId,
    channel: CHANNEL,
    text: msg.text,
    timestamp: new Date().toISOString(),
    status: 'executing',
    metadata: {
      ...msg.metadata,
      agentEmail: AGENT_USER_EMAIL,
      primeId: PRIME_ID,
      agentId: AGENT_ID,
    }
  };
  try { writeFileSync(TASK_JSON, JSON.stringify(task, null, 2)); } catch (err) {
    log('TASK.json write error', { error: err.message });
  }
}

// ---- Gateway Call (FIRE AND FORGET) ----
// We do NOT await the response. That's the Mouth's job.
function fireGateway(messages) {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GATEWAY_ROUTE, messages, stream: false }),
    signal: controller.signal
  })
  .then(res => {
    clearTimeout(hardTimeout);
    if (!res.ok) {
      res.text().then(t => log('Gateway HTTP error', { status: res.status, body: t.slice(0, 200) })).catch(() => {});
    } else {
      log('Gateway call completed');
    }
  })
  .catch(err => {
    clearTimeout(hardTimeout);
    if (err.name === 'AbortError') log('Gateway timeout', { timeout_s: HTTP_TIMEOUT / 1000 });
    else log('Gateway error', { error: err.message });
  });
}

// ================================================================
// CHANNEL ADAPTERS (input-only — no send/delivery methods)
// ================================================================

// ---- Firestore Poller (Prime/Dashboard) ----
async function pollFirestore() {
  const token = await getAccessToken();
  const body = { structuredQuery: { from: [{ collectionId: 'messages' }],
    where: { fieldFilter: { field: { fieldPath: 'processed' }, op: 'EQUAL', value: { booleanValue: false } } },
    limit: 50 } };
  const res = await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(d => { const f = d.document?.fields; return f?.text?.stringValue && f?.sender?.stringValue === 'admin'; })
    .map(d => ({ text: d.document.fields.text.stringValue, id: d.document.name,
      timestamp: d.document.fields.timestamp?.timestampValue || '', metadata: {} }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function markFirestoreConsumed(msg) {
  const token = await getAccessToken();
  await fetch(`https://firestore.googleapis.com/v1/${msg.id}?updateMask.fieldPaths=processed`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { processed: { booleanValue: true } } })
  });
}

// ---- Firestore Poller for Fleet Dashboard Messages ----
async function pollFirestoreDashboard() {
  if (!PRIME_ID || !AGENT_HOSTNAME) return [];
  const token = await getAccessToken();
  const body = { structuredQuery: { from: [{ collectionId: 'messages' }],
    where: { fieldFilter: { field: { fieldPath: 'processed' }, op: 'EQUAL', value: { booleanValue: false } } },
    limit: 50 } };
  const parentPath = `primes/${PRIME_ID}/fleet/${AGENT_HOSTNAME}`;
  const res = await fetch(`${FIRESTORE_URL}/${parentPath}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(d => { const f = d.document?.fields; return f?.text?.stringValue && f?.sender?.stringValue === 'admin'; })
    .map(d => ({ text: d.document.fields.text.stringValue, id: d.document.name,
      timestamp: d.document.fields.timestamp?.timestampValue || '',
      metadata: { source: 'dashboard' } }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function markFirestoreDashboardConsumed(msg) {
  const token = await getAccessToken();
  await fetch(`https://firestore.googleapis.com/v1/${msg.id}?updateMask.fieldPaths=processed`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { processed: { booleanValue: true } } })
  });
}

// ---- GChat Poller (Fleet) ----
let _gchatSpaces = [];
let _gchatLastDiscovery = 0;
let _gchatHighWater = '1970-01-01T00:00:00.000000Z';
const _gchatSeen = new Map();
const _stateDir = '/tmp/agent-ears-state';
try { mkdirSync(_stateDir, { recursive: true }); } catch {}
try { _gchatHighWater = readFileSync(`${_stateDir}/highwater`, 'utf8').trim(); } catch {}
try { const s = JSON.parse(readFileSync(`${_stateDir}/seen.json`, 'utf8')); for (const k of Object.keys(s)) _gchatSeen.set(k, true); } catch {}

async function discoverSpaces() {
  if (Date.now() - _gchatLastDiscovery < 300_000 && _gchatSpaces.length > 0) return;
  try {
    const token = await getDwdToken();
    const res = await fetch(`${CHAT_API}/spaces?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    _gchatSpaces = (data.spaces || []).map(s => s.name).filter(Boolean);
    _gchatLastDiscovery = Date.now();
    log('Discovered spaces', { count: _gchatSpaces.length });
  } catch (err) { log('Space discovery error', { error: err.message }); }
}

function getSenderName(msg) {
  const senderName = msg.sender?.displayName || '';
  // Detect agent's own messages (sent via DWD as the agent user)
  const agentDisplayName = process.env.AGENT_DISPLAY_NAME || '';
  if (agentDisplayName && senderName === agentDisplayName) return 'You';
  return senderName || 'Someone';
}

function cleanMentionText(text) {
  if (!text) return text;
  let clean = text;
  if (AGENT_MENTION) {
    clean = text.replace(new RegExp(`@?${AGENT_MENTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '').trim().replace(/\s+/g, ' ');
  }
  return clean || text;
}

function buildContextualMessage(targetMsg, priorMsgs) {
  const cleanTarget = cleanMentionText(targetMsg.text || targetMsg.argumentText || '');

  // Build context preamble from prior messages
  const contextLines = [];
  for (const m of priorMsgs) {
    const text = m.text || m.argumentText || '';
    if (!text.trim()) continue;
    const sender = getSenderName(m);
    contextLines.push(`${sender}: ${text}`);
  }

  let composite = '';
  if (contextLines.length > 0) {
    composite += '[Chat messages since your last reply - for context]\n';
    composite += contextLines.join('\n');
    composite += '\n\n';
  }
  composite += '[Current message - respond to this]\n';
  composite += `User: ${cleanTarget}`;

  return composite;
}

async function pollGChat() {
  await discoverSpaces();
  if (_gchatSpaces.length === 0) return [];
  const token = await getDwdToken();
  const messages = [];
  for (const space of _gchatSpaces) {
    try {
      const res = await fetch(`${CHAT_API}/${space}/messages?pageSize=10&orderBy=createTime%20desc`,
        { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      const allMsgs = (data.messages || []).reverse(); // chronological order

      for (let i = 0; i < allMsgs.length; i++) {
        const msg = allMsgs[i];
        const ct = msg.createTime || '';
        if (ct <= _gchatHighWater) continue;
        if (_gchatSeen.has(msg.name)) continue;
        const text = msg.text || msg.argumentText || '';
        if (!text || (AGENT_MENTION && !text.includes(AGENT_MENTION))) continue;

        // Gather prior messages as context (up to CONTEXT_WINDOW)
        const contextStart = Math.max(0, i - CONTEXT_WINDOW);
        const priorMsgs = allMsgs.slice(contextStart, i);
        const composite = buildContextualMessage(msg, priorMsgs);

        messages.push({ text: composite, id: msg.name, timestamp: ct, metadata: { space, email: AGENT_USER_EMAIL } });
      }
    } catch (err) { log('Chat poll error', { space, error: err.message }); }
  }
  return messages;
}

function markGChatConsumed(msg) {
  _gchatSeen.set(msg.id, true);
  if (_gchatSeen.size > 200) {
    const keys = [..._gchatSeen.keys()];
    for (let i = 0; i < keys.length - 200; i++) _gchatSeen.delete(keys[i]);
  }
  if (msg.timestamp > _gchatHighWater) _gchatHighWater = msg.timestamp;
  try { writeFileSync(`${_stateDir}/highwater`, _gchatHighWater); } catch {}
  try {
    const obj = {};
    for (const [k] of _gchatSeen) obj[k] = true;
    writeFileSync(`${_stateDir}/seen.json`, JSON.stringify(obj));
  } catch {}
}

// ---- Firestore Heartbeat ----
async function updateFirestoreStatus(status) {
  if (CHANNEL !== 'dashboard') return;
  try {
    const token = await getAccessToken();
    await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}?updateMask.fieldPaths=status`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: status } } })
    });
  } catch {}
}

// ---- Phase 3: Approval gate response detection ----
async function checkApprovalResponse(text) {
  // Extract the actual user message (after context lines)
  const lines = text.split('\n');
  const currentMsgLine = lines.find(l => l.startsWith('User: ')) || lines[lines.length - 1];
  const userText = currentMsgLine.replace(/^User:\s*/, '').trim().toLowerCase();

  // Match approval patterns
  const approvePatterns = ['approve', 'approved', 'yes', 'lgtm', 'go ahead', 'proceed', '👍'];
  const rejectPatterns = ['reject', 'rejected', 'no', 'deny', 'denied', 'stop', '👎'];

  let action = null;
  if (approvePatterns.some(p => userText === p || userText.startsWith(p + ' '))) {
    action = 'approved';
  } else if (rejectPatterns.some(p => userText === p || userText.startsWith(p + ' '))) {
    action = 'rejected';
  }

  if (!action) return false;

  // Check if there are any pending approvals
  try {
    const token = await getAccessToken();
    const queryUrl = `${FIRESTORE_URL}/primes/${PRIME_ID}/approvals:runQuery`;
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
              value: { stringValue: 'pending' },
            },
          },
          orderBy: [{ field: { fieldPath: 'requestedAt' }, direction: 'DESCENDING' }],
          limit: 1,
        },
      }),
    });
    if (!resp.ok) return false;

    const results = await resp.json();
    const pending = results.find(r => r.document);
    if (!pending) return false;

    // Update the most recent pending approval
    const docPath = pending.document.name.split('/documents/')[1];
    const reason = userText.length > 20 ? userText : undefined;

    await fetch(`${FIRESTORE_URL}/${docPath}?updateMask.fieldPaths=status&updateMask.fieldPaths=resolvedAt&updateMask.fieldPaths=resolvedBy${reason ? '&updateMask.fieldPaths=reason' : ''}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        status: { stringValue: action },
        resolvedAt: { stringValue: new Date().toISOString() },
        resolvedBy: { stringValue: `gchat:${AGENT_USER_EMAIL}` },
        ...(reason ? { reason: { stringValue: reason } } : {}),
      }}),
    });

    log(`Approval ${action} via GChat`, {
      approvalDoc: docPath,
      by: AGENT_USER_EMAIL,
    });
    return true;
  } catch (err) {
    log('Approval check error', { error: err.message });
    return false;
  }
}

// ================================================================
// MAIN LOOP
// ================================================================
async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }
  if (CHANNEL === 'dashboard' && !PRIME_ID) { console.error('PRIME_ID required for dashboard channel'); process.exit(1); }
  if (CHANNEL === 'gchat' && !AGENT_USER_EMAIL) { console.error('AGENT_USER_EMAIL required for gchat channel'); process.exit(1); }

  log('Starting', {
    channel: CHANNEL, agent: AGENT_ID, project: GCP_PROJECT,
    poll_interval_ms: POLL_INTERVAL,
    preprocess: PREPROCESS_ENABLED ? { model: PREPROCESS_MODEL, prompt_loaded: !!PREPROCESS_PROMPT } : false,
    ...(CHANNEL === 'gchat' ? { email: AGENT_USER_EMAIL, mention: AGENT_MENTION } : { primeId: PRIME_ID })
  });

  // Health checks
  if (CHANNEL === 'gchat') {
    try { await getDwdToken(); log('DWD healthcheck OK'); } catch (err) { log('DWD healthcheck FAILED', { error: err.message }); process.exit(1); }
  }

  await updateFirestoreStatus('online');
  const heartbeat = CHANNEL === 'dashboard' ? setInterval(() => updateFirestoreStatus('online').catch(() => {}), 60_000) : null;

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    if (heartbeat) clearInterval(heartbeat);
    if (CHANNEL === 'dashboard') await updateFirestoreStatus('offline').catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log('Entering polling loop...');

  while (true) {
    try {
      // Poll for messages
      let messages;
      if (CHANNEL === 'gchat') {
        const gchatMsgs = await pollGChat();
        const dashMsgs = await pollFirestoreDashboard();
        messages = [...gchatMsgs, ...dashMsgs];
      } else {
        messages = await pollFirestore();
      }

      // Expire stale dedup entries
      const now = Date.now();
      for (const [key, ts] of recentMessages) {
        if (now - ts > DEDUP_WINDOW) recentMessages.delete(key);
      }

      for (const msg of messages) {
        const dedupKey = msg.text.trim().toLowerCase();

        // Dedup
        if (recentMessages.has(dedupKey)) {
          log('Dedup — skipping', { text: msg.text.slice(0, 60) });
          if (msg.metadata?.source === 'dashboard') await markFirestoreDashboardConsumed(msg);
          else if (CHANNEL === 'gchat') markGChatConsumed(msg);
          else await markFirestoreConsumed(msg);
          continue;
        }

        // Cooldown
        const sender = msg.metadata?.email || 'admin';
        const lastTime = lastSeen.get(sender) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          log('Cooldown — skipping', { sender, text: msg.text.slice(0, 60) });
          if (msg.metadata?.source === 'dashboard') await markFirestoreDashboardConsumed(msg);
          else if (CHANNEL === 'gchat') markGChatConsumed(msg);
          else await markFirestoreConsumed(msg);
          continue;
        }

        recentMessages.set(dedupKey, now);
        lastSeen.set(sender, now);

        // Mark consumed IMMEDIATELY
        if (msg.metadata?.source === 'dashboard') await markFirestoreDashboardConsumed(msg);
        else if (CHANNEL === 'gchat') markGChatConsumed(msg);
        else await markFirestoreConsumed(msg);

        const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        log('Received', { text: msg.text.slice(0, 100), taskId });

        // LLM Preprocess: repair Chat-mangled text (gchat channel only)
        const cleanedText = await preprocessMessage(msg.text);
        if (cleanedText !== msg.text) {
          log('Preprocessed text changed', {
            original: msg.text.slice(0, 100),
            cleaned: cleanedText.slice(0, 100),
            taskId
          });
        }

        // ---- Phase 3: Approval gate detection ----
        // Check if this message is an approval response (approve/reject/yes/no)
        const approvalHandled = await checkApprovalResponse(cleanedText);
        if (approvalHandled) {
          log('Approval response handled', { text: cleanedText.slice(0, 60) });
          continue; // Skip normal intake processing
        }

        // ---- Brain v3: Write intake record to Firestore ----
        // Brain service picks this up, classifies it, creates envelopes,
        // and orchestrates the Cortex loop deterministically.
        const intakeId = `i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const intakeDoc = {
          id: { stringValue: intakeId },
          text: { stringValue: cleanedText },
          source: { stringValue: msg.metadata?.source === 'dashboard' ? 'dashboard' : CHANNEL },
          source_meta: { mapValue: { fields: {
            taskId: { stringValue: taskId },
            agentEmail: { stringValue: AGENT_USER_EMAIL },
            agentId: { stringValue: AGENT_ID },
            primeId: { stringValue: PRIME_ID },
            ...(msg.metadata?.spaceName ? { spaceName: { stringValue: msg.metadata.spaceName } } : {}),
            ...(msg.metadata?.threadName ? { threadName: { stringValue: msg.metadata.threadName } } : {}),
            ...(msg.metadata?.email ? { senderEmail: { stringValue: msg.metadata.email } } : {}),
          } } },
          status: { stringValue: 'pending' },
          created_at: { timestampValue: new Date().toISOString() },
        };

        try {
          const token = await getAccessToken();
          const intakeUrl = `${FIRESTORE_URL}/primes/${PRIME_ID}/intake/${intakeId}`;
          const resp = await fetch(intakeUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: intakeDoc }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            log('Intake write failed', { status: resp.status, error: errText.slice(0, 200) });
          } else {
            log('Intake written', { intakeId, taskId });
          }
        } catch (err) {
          log('Intake write error', { error: err.message, intakeId });
        }

        // Write TASK.json (for Mouth compatibility during transition)
        writeTaskJson({ ...msg, text: cleanedText }, taskId);

        // Touch health check file
        try { writeFileSync('/var/run/agent-ears-last-poll', String(Date.now())); } catch {}
      }
    } catch (err) {
      log('Poll error', { error: err.message });
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => {
  log('FATAL', { error: err.message, stack: err.stack });
  process.exit(1);
});
