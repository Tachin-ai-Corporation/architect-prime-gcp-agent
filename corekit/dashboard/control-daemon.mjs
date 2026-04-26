#!/usr/bin/env node
// ============================================================
// control-daemon.mjs — Firestore-polling message bridge for Prime
//
// Node.js daemon that polls Firestore for user messages and
// routes them to the OpenClaw gateway. Uses an async-first model:
//
//   1. Submit to gateway with 15s observation window (fast path).
//   2. If response completes within window → deliver directly.
//   3. If agent is dispatching (tool calls seen) → send ack,
//      enter heartbeat monitor loop. Agent delivers its own
//      response via channel-respond → dashboard-respond.
//   4. Monitor heartbeat every 15s. If stale >90s → stall recovery.
//
// Runs inside the Docker container via docker exec.
// Conversation history (20 turns) enables session continuity.
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

async function routeMessage(text) {
  const t0 = Date.now();

  // Add user message to conversation history
  conversationHistory.push({ role: 'user', content: text });

  // Trim history to prevent context overflow
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }

  // --- Fast path: try streaming with 15s observation window ---
  // If we get a complete response in 15s, use it directly (identity, fleet)
  // If still processing after 15s, detach and enter async monitor
  const fastResult = await callGatewayFast([...conversationHistory], t0);

  if (fastResult.error) {
    conversationHistory.pop();
    return { reply: fastResult.error, mode: 'error' };
  }

  if (fastResult.complete) {
    // Fast path: full response arrived within observation window
    conversationHistory.push({ role: 'assistant', content: fastResult.content });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Response received (fast path)', {
      elapsed_s: parseFloat(elapsed),
      chars: fastResult.content.length,
      history_depth: conversationHistory.length
    });
    return { reply: fastResult.content, mode: 'fast' };
  }

  // --- Async path: agent is doing dispatch work ---
  // Agent will deliver its own response via channel-respond
  log('Entering async monitor (agent dispatching)', {
    elapsed_s: parseFloat(((Date.now() - t0) / 1000).toFixed(1)),
    partialChars: fastResult.content?.length || 0
  });

  return { reply: null, mode: 'async' };
}

// Fast gateway call: streaming with observation window
// Returns { complete: true, content } if done, or { complete: false } if still working
const OBSERVATION_WINDOW = 15_000; // 15s — enough for simple responses
async function callGatewayFast(messages, t0) {
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
        stream: true
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('Gateway HTTP error', { status: res.status, body: errText.slice(0, 200) });
      clearTimeout(hardTimeout);
      return { error: `⚠ Gateway error (HTTP ${res.status})` };
    }

    // Read SSE stream with observation window
    const result = await readSSEWithWindow(res, t0);
    clearTimeout(hardTimeout);
    return result;
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

// Read SSE stream with observation window:
// - If stream completes within OBSERVATION_WINDOW → return full content
// - If stream has tool_calls (dispatch) → detach after window, let agent deliver via channel-respond
async function readSSEWithWindow(res, t0) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let buffer = '';
  let firstChunkLogged = false;
  let toolCallSeen = false;
  let streamDone = false;

  const windowEnd = Date.now() + OBSERVATION_WINDOW;

  try {
    while (Date.now() < windowEnd) {
      // Use a short read timeout so we can check the window
      const readPromise = reader.read();
      const timeoutPromise = new Promise(resolve =>
        setTimeout(() => resolve({ done: false, value: null, timeout: true }), 2000)
      );
      const { done, value, timeout } = await Promise.race([readPromise, timeoutPromise]);

      if (timeout) continue; // Check window again
      if (done) { streamDone = true; break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed === 'data: [DONE]') {
          streamDone = true;
          break;
        }

        if (trimmed.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const delta = chunk.choices?.[0]?.delta;

            if (delta?.tool_calls) toolCallSeen = true;

            if (delta?.content) {
              content += delta.content;
              if (!firstChunkLogged) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                log('Streaming started', { first_chunk_s: parseFloat(elapsed) });
                firstChunkLogged = true;
              }
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
      if (streamDone) break;
    }
  } catch (err) {
    log('SSE read error', { error: err.message });
  } finally {
    // Release the reader — if stream is still active, this detaches cleanly
    try { reader.cancel(); } catch {}
    reader.releaseLock();
  }

  // Decide: fast path (complete) or async path (still working)
  if (streamDone && content.trim().length > 5) {
    return { complete: true, content };
  }

  if (toolCallSeen || !streamDone) {
    // Agent is dispatching brain-exec or still thinking — async path
    return { complete: false, content };
  }

  // Stream ended but content is very short (thinking marker or empty)
  if (content.trim().length <= 5) {
    return { complete: false, content };
  }

  return { complete: true, content };
}

// ---- Async Task Monitor ----
// After entering async path, poll for agent-delivered response
const MONITOR_INTERVAL = 15_000;  // Check every 15s
const MONITOR_STALE = 90_000;     // 90s no heartbeat = stalled
const MONITOR_MAX = 480_000;      // 8 min absolute ceiling

async function monitorTask(taskId, msgPath) {
  const start = Date.now();
  let lastSeen = start;

  while (Date.now() - start < MONITOR_MAX) {
    await new Promise(r => setTimeout(r, MONITOR_INTERVAL));

    // Check Firestore for agent-delivered response (new message from 'prime')
    // This is the primary signal — agent called channel-respond → dashboard-respond
    const taskDoc = await readTaskDoc(taskId);

    if (taskDoc?.status === 'complete') {
      log('Task completed by agent', { taskId, elapsed_ms: Date.now() - start });
      await markProcessed(msgPath);
      return;
    }

    // Check heartbeat freshness
    if (taskDoc?.heartbeat) {
      const beatTime = new Date(taskDoc.heartbeat).getTime();
      if (beatTime > lastSeen) lastSeen = beatTime;
    }

    const staleDuration = Date.now() - lastSeen;
    if (staleDuration > MONITOR_STALE) {
      log('Task stalled', { taskId, staleDuration, elapsed_ms: Date.now() - start });
      await writeResponse('⚠ Request appears stalled. The agent may be processing — if no response arrives shortly, please retry.');
      await markProcessed(msgPath);
      writeTask(taskId, { status: 'stalled' }).catch(() => {});
      return;
    }

    log('Monitor heartbeat OK', { taskId, staleDuration, elapsed_ms: Date.now() - start });
  }

  // Absolute ceiling reached
  log('Task timeout (ceiling)', { taskId, elapsed_ms: Date.now() - start });
  await writeResponse('⚠ Request exceeded maximum processing time. Please retry with a simpler request.');
  await markProcessed(msgPath);
  writeTask(taskId, { status: 'timeout' }).catch(() => {});
}

// Read task document from Firestore
async function readTaskDoc(taskId) {
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `${FIRESTORE_URL}/primes/${PRIME_ID}/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const doc = await res.json();
    const fields = doc.fields || {};
    return {
      status: fields.status?.stringValue,
      heartbeat: fields.heartbeat?.stringValue,
      completedAt: fields.completedAt?.stringValue
    };
  } catch {
    return null;
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
    max_history: MAX_HISTORY,
    architecture: 'async-first v1'
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

        // Route message with observation window
        const result = await routeMessage(msg.text);

        if (result.mode === 'fast' || result.mode === 'error') {
          // Fast path: got a complete response, write it directly
          log('Reply (fast)', { text: result.reply.split('\n')[0].slice(0, 80), taskId });
          await writeResponse(result.reply);
          await markProcessed(msg.path);

          const elapsed = Date.now() - t0;
          writeTask(taskId, {
            status: 'complete',
            completedAt: new Date().toISOString(),
            totalMs: elapsed,
            responsePreview: result.reply.slice(0, 200)
          }).catch(() => {});
          log('Completed (fast)', { taskId, elapsed_ms: elapsed });

        } else if (result.mode === 'async') {
          // Async path: agent is dispatching, send ack + monitor
          await writeResponse('🔄 Working on it...');
          writeTask(taskId, { status: 'executing' }).catch(() => {});
          log('Async path entered, monitoring', { taskId });

          // Monitor the task — blocks until agent delivers or stall detected
          await monitorTask(taskId, msg.path);
          log('Async task monitoring complete', { taskId, elapsed_ms: Date.now() - t0 });
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

