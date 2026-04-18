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

// ---- Gateway Communication (Hybrid: SSE Streaming + Non-Stream Fallback) ----
async function routeMessage(text) {
  const t0 = Date.now();

  // Add user message to conversation history
  conversationHistory.push({ role: 'user', content: text });

  // Trim history to prevent context overflow
  while (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory.shift();
  }

  // Try streaming first (keeps connection alive for long dispatches)
  const streamResult = await callGateway([...conversationHistory], true, t0);

  if (streamResult.error) {
    conversationHistory.pop();
    return streamResult.error;
  }

  // If we got a real response (>5 chars), use it
  if (streamResult.content && streamResult.content.trim().length > 5) {
    conversationHistory.push({ role: 'assistant', content: streamResult.content });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Response received', {
      elapsed_s: parseFloat(elapsed),
      chars: streamResult.content.length,
      history_depth: conversationHistory.length,
      mode: 'streaming'
    });
    return streamResult.content;
  }

  // Got a thinking marker (<5 chars) — retry non-streaming
  // Non-streaming waits for the full turn including tool results
  log('Thinking marker detected, retrying non-streaming', {
    raw: streamResult.content?.trim(),
    elapsed_s: parseFloat(((Date.now() - t0) / 1000).toFixed(1))
  });

  const syncResult = await callGateway([...conversationHistory], false, t0);

  if (syncResult.error) {
    conversationHistory.pop();
    return syncResult.error;
  }

  if (syncResult.content) {
    conversationHistory.push({ role: 'assistant', content: syncResult.content });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Response received', {
      elapsed_s: parseFloat(elapsed),
      chars: syncResult.content.length,
      history_depth: conversationHistory.length,
      mode: 'non-streaming-fallback'
    });
    return syncResult.content;
  }

  conversationHistory.pop();
  return 'No response from OpenClaw. The query may need to be rephrased.';
}

// Unified gateway call — streaming or non-streaming
async function callGateway(messages, stream, t0) {
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
        model: 'openclaw/cortex',
        messages,
        stream
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log('Gateway HTTP error', { status: res.status, body: errText.slice(0, 200), stream });
      return { error: `⚠ Gateway error (HTTP ${res.status})` };
    }

    if (stream) {
      const content = await readSSEStream(res, t0);
      return { content };
    } else {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content
        || data.content || data.response || '';
      return { content };
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Gateway error', { error: err.message, elapsed_s: parseFloat(elapsed), stream });

    if (err.name === 'AbortError') {
      return { error: `⚠ Response timed out (${HTTP_TIMEOUT / 1000}s). The query may have been too complex.` };
    }
    return { error: `⚠ Gateway error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// Parse SSE (Server-Sent Events) stream from the gateway
async function readSSEStream(res, t0) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let buffer = '';
  let firstChunkLogged = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty/comment lines

        if (trimmed === 'data: [DONE]') {
          return content;
        }

        if (trimmed.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              content += delta;

              // Log first chunk to show we're streaming
              if (!firstChunkLogged) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                log('Streaming started', { first_chunk_s: parseFloat(elapsed) });
                firstChunkLogged = true;
              }
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return content;
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
