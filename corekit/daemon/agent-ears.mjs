#!/usr/bin/env node
// ============================================================
// agent-ears.mjs — Deterministic Input Processing Service
//
// 100% deterministic — ZERO LLM calls.
// Polls channels for input, deduplicates, delivers to gateway.
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

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const HTTP_TIMEOUT = 600_000;

// Ears-specific config (from contracts or env)
let EARS_CONFIG = { firestore_poll_ms: 3000, gchat_poll_ms: 5000, dedup_window_ms: 300000, cooldown_ms: 2000 };
try {
  const contracts = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
  if (contracts.ears) EARS_CONFIG = { ...EARS_CONFIG, ...contracts.ears };
} catch {}

const POLL_INTERVAL = CHANNEL === 'gchat' ? EARS_CONFIG.gchat_poll_ms : EARS_CONFIG.firestore_poll_ms;
const DEDUP_WINDOW = EARS_CONFIG.dedup_window_ms;
const COOLDOWN_MS = EARS_CONFIG.cooldown_ms;

// GChat-specific config
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const AGENT_MENTION = process.env.AGENT_MENTION || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';

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

// ---- Shared state ----
const recentMessages = new Map();            // dedup by content hash
const lastSeen = new Map();                  // sender → timestamp (cooldown)
const conversationHistory = [];
const MAX_HISTORY = 4;

// ---- Logging ----
const EARS_LOG = '/var/log/agent-ears.log';
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-ears', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(EARS_LOG, line); } catch {}
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

// ---- Gateway Call (non-streaming) ----
async function callGateway(messages) {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GATEWAY_ROUTE, messages, stream: false }),
      signal: controller.signal
    });
    clearTimeout(hardTimeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('Gateway HTTP error', { status: res.status, body: errText.slice(0, 200) });
      return { error: `Gateway error (HTTP ${res.status})` };
    }
    // We don't process the response — that's the Mouth's job.
    // We just need to know the gateway accepted it.
    return { ok: true };
  } catch (err) {
    clearTimeout(hardTimeout);
    if (err.name === 'AbortError') return { error: `Gateway timeout (${HTTP_TIMEOUT / 1000}s)` };
    log('Gateway error', { error: err.message });
    return { error: err.message };
  }
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
      for (const msg of (data.messages || []).reverse()) {
        const ct = msg.createTime || '';
        if (ct <= _gchatHighWater) continue;
        if (_gchatSeen.has(msg.name)) continue;
        const text = msg.text || msg.argumentText || '';
        if (!text || (AGENT_MENTION && !text.includes(AGENT_MENTION))) continue;
        let clean = text;
        if (AGENT_MENTION) clean = text.replace(new RegExp(`@?${AGENT_MENTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '').trim().replace(/\s+/g, ' ');
        if (!clean) clean = text;
        messages.push({ text: clean, id: msg.name, timestamp: ct, metadata: { space, email: AGENT_USER_EMAIL } });
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

// ---- GChat ACK (deterministic — just sends a text message) ----
async function sendGChatAck(metadata) {
  const token = await getDwdToken();
  const space = metadata?.space || _gchatSpaces[0];
  if (!space) return;
  await fetch(`${CHAT_API}/${space}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '🔄 Processing your request...' })
  }).catch(err => log('ACK send error', { error: err.message }));
}

// ---- Firestore ACK ----
async function sendFirestoreAck() {
  const token = await getAccessToken();
  await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      text: { stringValue: '🔄 Processing your request...' }, sender: { stringValue: 'prime' },
      timestamp: { timestampValue: new Date().toISOString() }, processed: { booleanValue: true }
    } })
  }).catch(err => log('ACK send error', { error: err.message }));
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
  const ACK_TIMEOUT = 15_000;

  while (true) {
    try {
      // Poll for messages
      const messages = CHANNEL === 'gchat' ? await pollGChat() : await pollFirestore();

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
          if (CHANNEL === 'gchat') markGChatConsumed(msg); else await markFirestoreConsumed(msg);
          continue;
        }

        // Cooldown
        const sender = msg.metadata?.email || 'admin';
        const lastTime = lastSeen.get(sender) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          log('Cooldown — skipping', { sender, text: msg.text.slice(0, 60) });
          if (CHANNEL === 'gchat') markGChatConsumed(msg); else await markFirestoreConsumed(msg);
          continue;
        }

        recentMessages.set(dedupKey, now);
        lastSeen.set(sender, now);

        // Mark consumed IMMEDIATELY
        if (CHANNEL === 'gchat') markGChatConsumed(msg); else await markFirestoreConsumed(msg);
        log('Received', { text: msg.text.slice(0, 100) });

        // ACK timer — send "processing" after 15s if gateway hasn't responded
        let ackSent = false;
        const ackTimer = setTimeout(async () => {
          ackSent = true;
          if (CHANNEL === 'gchat') await sendGChatAck(msg.metadata);
          else await sendFirestoreAck();
          log('ACK sent (timeout)');
        }, ACK_TIMEOUT);

        // Build conversation and send to gateway
        conversationHistory.push({ role: 'user', content: msg.text });
        while (conversationHistory.length > MAX_HISTORY * 2) conversationHistory.shift();

        const result = await callGateway([...conversationHistory]);
        clearTimeout(ackTimer);

        if (result.error) {
          log('Gateway error', { error: result.error });
          conversationHistory.pop();
          // Still send ACK if not already sent
          if (!ackSent) {
            if (CHANNEL === 'gchat') await sendGChatAck(msg.metadata);
            else await sendFirestoreAck();
          }
        } else {
          log('Delivered to gateway');
          // The Mouth will pick up the response from the gateway.
          // We just need to send ACK if not already sent.
          if (!ackSent) {
            if (CHANNEL === 'gchat') await sendGChatAck(msg.metadata);
            else await sendFirestoreAck();
          }
        }

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
