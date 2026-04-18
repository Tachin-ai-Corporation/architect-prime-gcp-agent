#!/usr/bin/env node
// ============================================================
// control-daemon.mjs — Firestore-polling message bridge for Prime
//
// Node.js rewrite of the bash control-daemon. Uses HTTP chat
// completions endpoint with conversation history for session
// continuity. Runs inside the Docker container via docker exec.
//
// Benefits over bash version:
//   - Conversation history across turns (session persistence)
//   - Structured JSON logging
//   - Proper error handling (no string escaping issues)
//   - Dispatch latency tracking
//
// Run:
//   docker exec -e GCP_PROJECT_ID=xxx -e PRIME_ID=xxx \
//     openclaw-gateway node /home/node/.openclaw/bin/control-daemon.mjs
// ============================================================
import { readFileSync } from 'fs';

// ---- Config ----
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10) * 1000;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID;
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const HTTP_TIMEOUT = 300_000; // 300s — brain dispatch chains can take 80-120s
const MAX_HISTORY = 20; // Keep last N turns for context

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

// Conversation history for session continuity
const conversationHistory = [];

// ---- Logging ----
function log(msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    svc: 'control-daemon',
    msg,
    ...meta
  };
  console.log(JSON.stringify(entry));
}

// ---- GCE Metadata Access Token ----
let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    const data = await res.json();
    _cachedToken = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
    return _cachedToken;
  } catch (err) {
    log('Failed to get access token', { error: err.message });
    throw err;
  }
}

// ---- Firestore Operations ----
async function pollMessages() {
  const token = await getAccessToken();
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'messages' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'sender' }, op: 'EQUAL', value: { stringValue: 'admin' } } },
            { fieldFilter: { field: { fieldPath: 'processed' }, op: 'EQUAL', value: { booleanValue: false } } }
          ]
        }
      },
      orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'ASCENDING' }],
      limit: 5
    }
  };

  const res = await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data
    .filter(d => d.document?.fields?.text?.stringValue)
    .map(d => ({
      text: d.document.fields.text.stringValue,
      path: d.document.name,
      timestamp: d.document.fields.timestamp?.timestampValue || ''
    }));
}

async function markProcessed(docPath) {
  const token = await getAccessToken();
  await fetch(`https://firestore.googleapis.com/v1/${docPath}?updateMask.fieldPaths=processed`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { processed: { booleanValue: true } } })
  });
}

async function writeResponse(text) {
  const token = await getAccessToken();
  await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        text: { stringValue: text },
        sender: { stringValue: 'prime' },
        timestamp: { timestampValue: new Date().toISOString() },
        processed: { booleanValue: true }
      }
    })
  });
}

async function updateStatus(status) {
  const token = await getAccessToken();
  await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}?updateMask.fieldPaths=status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { status: { stringValue: status } } })
  }).catch(() => {});
}

// ---- Gateway Communication ----
async function routeMessage(text) {
  const t0 = Date.now();

  // Add user message to conversation history
  conversationHistory.push({ role: 'user', content: text });

  // Trim history to prevent context overflow
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [...conversationHistory]
      }),
      signal: controller.signal
    });

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content
      || data.content
      || data.response
      || '';

    if (content) {
      // Add assistant response to conversation history
      conversationHistory.push({ role: 'assistant', content });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      log('Response received', {
        elapsed_s: parseFloat(elapsed),
        chars: content.length,
        history_depth: conversationHistory.length
      });

      return content;
    }

    log('Empty content from gateway', { raw: JSON.stringify(data).slice(0, 200) });
    return '⚠ Empty response from OpenClaw gateway.';
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Gateway error', { error: err.message, elapsed_s: parseFloat(elapsed) });

    // Remove the failed user message from history
    conversationHistory.pop();

    if (err.name === 'AbortError') {
      return '⚠ Response timed out (300s). The query may have been too complex.';
    }
    return `⚠ Gateway error: ${err.message}`;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Heartbeat ----
let heartbeatInterval;
function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    updateStatus('online').catch(() => {});
  }, 60_000);
}

// ---- Main Loop ----
async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }
  if (!PRIME_ID) { console.error('PRIME_ID required'); process.exit(1); }

  log('Starting', {
    prime: PRIME_ID,
    project: GCP_PROJECT,
    poll_interval_s: POLL_INTERVAL / 1000,
    token: GATEWAY_TOKEN.slice(0, 8) + '...',
    max_history: MAX_HISTORY
  });

  await updateStatus('online');
  log('Status: ONLINE');
  startHeartbeat();

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    clearInterval(heartbeatInterval);
    await updateStatus('offline').catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log('Entering polling loop...');

  while (true) {
    try {
      const messages = await pollMessages();

      for (const msg of messages) {
        log('Received', { text: msg.text.slice(0, 100) });

        const reply = await routeMessage(msg.text);

        log('Reply', { text: reply.split('\n')[0].slice(0, 80) });

        await writeResponse(reply);
        await markProcessed(msg.path);
        log('Completed', { doc: msg.path.split('/').pop() });
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
