#!/usr/bin/env node
// ============================================================
// control-daemon.mjs — Firestore-polling message bridge for Prime
//
// Node.js daemon that polls Firestore for user messages and
// routes them to the OpenClaw gateway using non-streaming calls.
//
// Non-streaming mode: the /v1/chat/completions endpoint (stream:false)
// waits for the full model turn — including tool execution — and
// returns the final visible text in one JSON response. This avoids
// the SSE streaming issues where tool-call responses are not
// surfaced through the stream.
//
// Runs inside the Docker container via docker exec.
// Conversation history (4 turns) enables session continuity.
//
// Run:
//   docker exec -e GCP_PROJECT_ID=xxx -e PRIME_ID=xxx \
//     openclaw-gateway node /home/node/.openclaw/bin/control-daemon.mjs
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ---- Config ----
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5', 10) * 1000;
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID;
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const HTTP_TIMEOUT = 600_000; // 600s — research dispatches can take 3-5min
const MAX_HISTORY = 4;  // Keep last N turns — Cortex only needs recent context for classification

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
  // Match the proven bash query: single fieldFilter, no composite index needed
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'messages' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'processed' },
          op: 'EQUAL',
          value: { booleanValue: false }
        }
      },
      limit: 50
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
    .filter(d => {
      const fields = d.document?.fields;
      return fields?.text?.stringValue && fields?.sender?.stringValue === 'admin';
    })
    .map(d => ({
      text: d.document.fields.text.stringValue,
      path: d.document.name,
      timestamp: d.document.fields.timestamp?.timestampValue || ''
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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

// ---- Task Tracking (Firestore) ----
async function writeTask(taskId, fields) {
  const token = await getAccessToken();
  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') firestoreFields[k] = { stringValue: v };
    else if (typeof v === 'number') firestoreFields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
  }
  await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/tasks?documentId=${taskId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: firestoreFields })
  }).catch(() => {
    // Update existing doc if create fails (task already exists)
    const paths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
    return fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/tasks/${taskId}?${paths}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: firestoreFields })
    });
  }).catch(() => {});
}

// Write TASK.json to workspace so agent + brain-exec can update heartbeat
const WORKSPACE_DIR = '/home/node/.openclaw/workspace';
const TASK_JSON_PATH = `${WORKSPACE_DIR}/TASK.json`;
const STATUS_JSON_PATH = `${WORKSPACE_DIR}/STATUS.json`;

function writeTaskFile(taskId) {
  try {
    writeFileSync(TASK_JSON_PATH, JSON.stringify({
      taskId,
      channel: 'dashboard',
      channelMeta: { primeId: PRIME_ID, projectId: GCP_PROJECT },
      status: 'executing',
      heartbeat: new Date().toISOString(),
      receivedAt: new Date().toISOString()
    }));
  } catch {
    // Non-critical: agent can still respond without TASK.json
  }
}

// Read agent STATUS.json to check if agent is currently busy
function readAgentStatus() {
  try {
    if (!existsSync(STATUS_JSON_PATH)) return null;
    const raw = readFileSync(STATUS_JSON_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function timeSince(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// ---- Gateway Call (non-streaming) ----
// POST to /v1/chat/completions with stream:false.
// Waits for the full model turn including tool execution and returns
// the final visible text in the JSON response.
async function callGateway(messages, t0) {
  const controller = new AbortController();
  const hardTimeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openclaw/cortex',
        messages,
        stream: false
      }),
      signal: controller.signal
    });

    clearTimeout(hardTimeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('Gateway HTTP error', { status: res.status, body: errText.slice(0, 200) });
      return { error: `⚠ Gateway error (HTTP ${res.status})` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Gateway response', {
      elapsed_s: parseFloat(elapsed),
      chars: content.length,
      tokens: data.usage?.total_tokens
    });
    return { content };
  } catch (err) {
    clearTimeout(hardTimeout);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Gateway error', { error: err.message, elapsed_s: parseFloat(elapsed) });

    if (err.name === 'AbortError') {
      return { error: `⚠ Response timed out (${HTTP_TIMEOUT / 1000}s).` };
    }
    return { error: `⚠ Gateway error: ${err.message}` };
  }
}

// ---- Message Routing ----
async function routeMessage(text) {
  const t0 = Date.now();

  // Add user message to conversation history
  conversationHistory.push({ role: 'user', content: text });

  // Trim history to prevent context overflow
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }

  // Call gateway (non-streaming) — waits for the full model turn
  const result = await callGateway([...conversationHistory], t0);

  if (result.error) {
    conversationHistory.pop();
    return { reply: result.error, mode: 'error' };
  }

  const content = result.content?.trim() || '';
  if (content.length > 0) {
    conversationHistory.push({ role: 'assistant', content });
    return { reply: content, mode: 'complete' };
  }

  // Model returned no visible content (tool calls only, no text)
  return { reply: '', mode: 'empty' };
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
    max_history: MAX_HISTORY,
    architecture: 'non-streaming v2'
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
        const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const t0 = Date.now();
        log('Received', { text: msg.text.slice(0, 100), taskId });

        // Check if agent is currently busy (status-aware response)
        const agentStatus = readAgentStatus();
        if (agentStatus && agentStatus.state && agentStatus.state !== 'idle' && agentStatus.state !== 'classifying') {
          const since = agentStatus.since ? timeSince(agentStatus.since) : 'unknown';
          const statusMsg = `🔄 Currently: ${agentStatus.state}` +
            (agentStatus.detail ? ` (${agentStatus.detail})` : '') +
            `\n   Task: ${agentStatus.task || 'working'}` +
            `\n   Since: ${since} ago` +
            `\n\nYour message has been queued and will be processed next.`;
          log('Agent busy, status response', { state: agentStatus.state, detail: agentStatus.detail });
          await writeResponse(statusMsg);
          await markProcessed(msg.path);
          continue;
        }

        // Write initial Task document (fire-and-forget)
        writeTask(taskId, {
          userMessage: msg.text.slice(0, 500),
          status: 'submitted',
          receivedAt: new Date().toISOString()
        }).catch(() => {});

        // Write TASK.json to workspace (for channel-respond + heartbeat)
        writeTaskFile(taskId);

        // Route message — blocks until gateway returns full response
        const result = await routeMessage(msg.text);

        const elapsed = Date.now() - t0;

        if (result.mode === 'complete') {
          // Got a full response from the model
          log('Reply', { text: result.reply.split('\n')[0].slice(0, 80), taskId });
          await writeResponse(result.reply);
          await markProcessed(msg.path);
          writeTask(taskId, {
            status: 'complete',
            completedAt: new Date().toISOString(),
            totalMs: elapsed,
            responsePreview: result.reply.slice(0, 200)
          }).catch(() => {});
          log('Completed', { taskId, elapsed_ms: elapsed });

        } else if (result.mode === 'empty') {
          // Model processed but returned no visible text — send ack
          log('Empty response from model — sending ack', { taskId });
          await writeResponse('🔄 Processing your request...');
          await markProcessed(msg.path);
          writeTask(taskId, { status: 'dispatched' }).catch(() => {});
          log('Dispatched (empty)', { taskId, elapsed_ms: elapsed });

        } else if (result.mode === 'error') {
          // Gateway or model error
          if (result.reply) {
            await writeResponse(result.reply);
          } else {
            await writeResponse('⚠ I wasn\'t able to process that request. Please try again.');
          }
          await markProcessed(msg.path);
          log('Error', { taskId, reply: result.reply?.slice(0, 80), elapsed_ms: elapsed });
        }
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
