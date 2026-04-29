#!/usr/bin/env node
// ============================================================
// control-daemon.mjs — Firestore-polling message bridge for Prime
//
// Node.js daemon that polls Firestore for user messages and
// routes them to the OpenClaw gateway using non-streaming calls.
//
// Architecture:
//   - Fast path (identity, fleet): gateway returns content directly,
//     daemon writes it to Firestore.
//   - Dispatch path (research, execution): gateway returns empty
//     (Cortex yielded to sub-agent). Cortex delivers its own
//     synthesis via `channel-respond` → Firestore. Daemon sends
//     a "Processing..." ack and starts a watchdog to verify delivery.
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

// ---- Anti-spam state ----
// Fix 1: Dedup incoming messages — same text within 60s is collapsed
const recentMessages = new Map();  // text → timestamp
const DEDUP_WINDOW = 60_000;       // 60s

// Fix 2: Single-flight watchdog — only one active at a time
let activeWatchdogTaskId = null;

// Fix 3: Track consumed log offset — only scan new lines
let lastLogOffset = 0;

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

// ---- Thinking Block Stripping ----
// Gemini 3.1 emits <think>...</think> reasoning blocks in the response.
// OpenClaw strips the XML tags, leaving bare "think\n..." prefix with the
// response text concatenated after it. We strip the thinking portion.
function stripThinking(text) {
  if (!text) return text;

  // Pattern 1: <think>...</think> XML-style tags (if tags survive)
  if (text.includes('<think>') && text.includes('</think>')) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  // Pattern 2: bare "think\n..." prefix (OpenClaw stripped the XML tags)
  if (text.startsWith('think\n') || text.startsWith('think\r\n')) {
    const lines = text.split('\n');
    let lastThinkLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l === '' || l === 'think' || /^Thinking/i.test(l) ||
          /^\d+\.\s/.test(l) || /^\*\s/.test(l) || /^\*\*/.test(l) ||
          /^\*\s+\*/.test(l)) {
        lastThinkLine = i;
      }
    }
    const response = lines.slice(lastThinkLine + 1).join('\n').trim();
    if (response.length > 0) return response;
  }

  return text;
}

// ---- Extract synthesis from think blocks ----
// The LLM embeds its user-facing response INSIDE think blocks after yield.
// This function scans think entries for the formatted response content.
//
// Strategy:
// 1. Look for entries that contain the response (markdown, structured text)
// 2. Within those entries, find the user-facing portion (after "Here is/are",
//    before "Let's run exec" or similar meta-text)
// 3. Fall back to the longest entry's content if no clear boundary is found
function extractSynthesisFromThinking(entries) {
  // Process all entries — combine and look for the response
  for (const entry of entries) {
    const text = entry || '';

    // Strip "think\n" prefix if present
    let content = text;
    if (content.startsWith('think\n')) {
      content = content.slice(6);
    }

    // Look for user-facing response patterns within the think block
    // Split by newlines and find the response start
    const lines = content.split('\n');
    let responseStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // User-facing response markers
      if (/^Here (is|are|'s) (the |a |my )?/i.test(line) && !line.includes('execute') && !line.includes('`exec')) {
        responseStart = i;
        break;
      }
    }

    if (responseStart >= 0) {
      // Extract from response start to end of meaningful content
      const responseLines = [];
      for (let i = responseStart; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Stop at meta-text that signals end of response
        if (/^Let'?s (run|execute|format|compose|send|deliver)/i.test(trimmed)) break;
        if (/^I (will|should|need to|must) (now |)(run|execute|call|deliver|send)/i.test(trimmed)) break;
        if (/^Wait,/i.test(trimmed)) break;
        if (/^Since I/i.test(trimmed) && trimmed.includes('channel-respond')) break;
        if (trimmed.startsWith('```') && trimmed.includes('channel-respond')) break;

        responseLines.push(line);
      }

      const response = responseLines.join('\n').trim();
      if (response.length > 30) return response;
    }
  }

  return null;
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

  const rawContent = result.content?.trim() || '';
  const content = stripThinking(rawContent);

  // Check if the response is a "no reply" / empty — this happens when Cortex
  // calls sessions_yield to wait for a sub-agent. The HTTP call returns immediately
  // with no content, but the sub-agent is still running.
  // Agent-driven delivery: Cortex will call channel-respond to deliver the
  // synthesis directly to Firestore. The daemon just sends an ack and returns.
  const isNoReply = !content || content.length === 0 ||
    content.toLowerCase().includes('no reply') ||
    content.toLowerCase().includes('no response');

  if (!isNoReply && content.length > 0) {
    conversationHistory.push({ role: 'assistant', content });
    return { reply: content, mode: 'complete' };
  }

  // Cortex yielded — sub-agent is running. Cortex will deliver via channel-respond.
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('Yield detected — agent will deliver via channel-respond', { elapsed_s: parseFloat(elapsed) });
  return { reply: '', mode: 'dispatched-async' };
}

// ---- Watchdog: verify agent delivery ----
// Two-path delivery verification:
// 1. Check Firestore for a sender:prime message (channel-respond worked)
// 2. Parse OpenClaw log file for synthesis (LLM failed to call channel-respond)
//
// Anti-spam: only ONE watchdog runs at a time (single-flight), and the log
// parser tracks a byte offset so it never re-reads already-consumed entries.
async function watchdogCheck(taskId, dispatchedAt) {
  const WATCHDOG_INTERVAL = 15_000;  // 15s
  const WATCHDOG_MAX = 300_000;      // 5 min
  const start = Date.now();

  log('Watchdog started', { taskId, timeout_s: WATCHDOG_MAX / 1000 });

  // Snapshot the current log offset — only scan lines AFTER this point
  const logStartOffset = lastLogOffset;

  try {
    while (Date.now() - start < WATCHDOG_MAX) {
      await new Promise(r => setTimeout(r, WATCHDOG_INTERVAL));

      // ---- Path 1: Check Firestore for agent delivery ----
      try {
        const token = await getAccessToken();
        const body = {
          structuredQuery: {
            from: [{ collectionId: 'messages' }],
            where: {
              compositeFilter: {
                op: 'AND',
                filters: [
                  { fieldFilter: { field: { fieldPath: 'sender' }, op: 'EQUAL', value: { stringValue: 'prime' } } },
                  { fieldFilter: { field: { fieldPath: 'timestamp' }, op: 'GREATER_THAN', value: { timestampValue: dispatchedAt } } }
                ]
              }
            },
            orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
            limit: 1
          }
        };

        const res = await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}:runQuery`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();

        if (Array.isArray(data) && data.some(d => d.document?.fields?.sender?.stringValue === 'prime')) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          log('Watchdog: agent delivered via channel-respond', { taskId, elapsed_s: parseFloat(elapsed) });
          writeTask(taskId, {
            status: 'complete',
            completedAt: new Date().toISOString(),
            deliveredBy: 'agent'
          }).catch(() => {});
          return; // Success
        }
      } catch (err) {
        log('Watchdog Firestore poll error', { error: err.message });
      }

      // ---- Path 2: Parse NEW OpenClaw log entries for synthesis ----
      // Only scans bytes AFTER logStartOffset to avoid re-delivering old results.
      try {
        const today = new Date().toISOString().split('T')[0];
        const logPath = `/tmp/openclaw/openclaw-${today}.log`;
        const logContent = readFileSync(logPath, 'utf8');

        // Only look at content added SINCE this watchdog started
        const newContent = logContent.slice(logStartOffset);
        const lines = newContent.split('\n').filter(l => l.trim());

        // Find announcement + synthesis pair in the NEW portion
        let synthesisEntries = [];
        let foundAnnounce = false;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Combine all string values (announce can be in '0' or '1')
            const allText = Object.keys(entry)
              .filter(k => k !== '_meta' && typeof entry[k] === 'string')
              .map(k => entry[k])
              .join(' ');

            if (allText.includes('announce:v1:agent:')) {
              foundAnnounce = true;
              synthesisEntries = [];
              continue;
            }

            const text = entry['0'] || '';
            if (foundAnnounce && text.length > 50) {
              synthesisEntries.push(text);
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        if (synthesisEntries.length > 0) {
          const synthesis = extractSynthesisFromThinking(synthesisEntries);
          if (synthesis && synthesis.length > 30) {
            // Advance the global offset so no other watchdog re-reads these lines
            lastLogOffset = logContent.length;

            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            log('Watchdog: synthesis captured from log file', {
              taskId, elapsed_s: parseFloat(elapsed), chars: synthesis.length
            });
            await writeResponse(synthesis);
            conversationHistory.push({ role: 'assistant', content: synthesis });
            writeTask(taskId, {
              status: 'complete',
              completedAt: new Date().toISOString(),
              deliveredBy: 'watchdog-log'
            }).catch(() => {});
            return; // Success — delivered from log
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          log('Watchdog log parse error', { error: err.message });
        }
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log('Watchdog: no delivery yet', { taskId, elapsed_s: parseFloat(elapsed) });
    }

    // Timed out — write fallback error message
    log('Watchdog timeout — writing fallback error', { taskId });
    await writeResponse('⚠ I dispatched a sub-agent but wasn\'t able to deliver the result. Please try again.');
    writeTask(taskId, {
      status: 'watchdog-timeout',
      completedAt: new Date().toISOString()
    }).catch(() => {});
  } finally {
    // Release the single-flight guard
    activeWatchdogTaskId = null;
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

      // ---- Anti-spam: expire stale dedup entries ----
      const now = Date.now();
      for (const [key, ts] of recentMessages) {
        if (now - ts > DEDUP_WINDOW) recentMessages.delete(key);
      }

      for (const msg of messages) {
        const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const t0 = Date.now();

        // ---- Fix 1: Deduplicate incoming messages ----
        const dedupKey = msg.text.trim().toLowerCase();
        if (recentMessages.has(dedupKey)) {
          log('Dedup — skipping duplicate message', { text: msg.text.slice(0, 60) });
          await markProcessed(msg.path);
          continue;
        }
        recentMessages.set(dedupKey, Date.now());

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

        // Route message — blocks until gateway returns full response.
        // If it takes > ACK_TIMEOUT, send an ack so the user isn't waiting in the dark.
        const ACK_TIMEOUT = 15_000; // 15s — identity queries complete in ~10s, research takes 60-120s
        let ackSent = false;
        const ackTimer = setTimeout(async () => {
          ackSent = true;
          log('ACK timeout — sending processing notice', { taskId });
          await writeResponse('🔄 Processing your request...');
          await markProcessed(msg.path);
          writeTask(taskId, { status: 'processing' }).catch(() => {});
        }, ACK_TIMEOUT);

        const result = await routeMessage(msg.text);
        clearTimeout(ackTimer);

        const elapsed = Date.now() - t0;

        if (result.mode === 'complete') {
          // Got a full response from the model
          log('Reply', { text: result.reply.split('\n')[0].slice(0, 80), taskId, ackSent });
          await writeResponse(result.reply);
          if (!ackSent) await markProcessed(msg.path);
          writeTask(taskId, {
            status: 'complete',
            completedAt: new Date().toISOString(),
            totalMs: elapsed,
            responsePreview: result.reply.slice(0, 200)
          }).catch(() => {});
          log('Completed', { taskId, elapsed_ms: elapsed });

        } else if (result.mode === 'dispatched-async') {
          // Cortex yielded — sub-agent is running, Cortex will deliver via channel-respond
          if (!ackSent) {
            log('Async dispatch — sending processing ack', { taskId });
            await writeResponse('🔄 Processing your request...');
            await markProcessed(msg.path);
          }
          writeTask(taskId, { status: 'dispatched-async' }).catch(() => {});
          log('Dispatched async — watchdog starting', { taskId, elapsed_ms: elapsed });

          // ---- Fix 2: Single-flight watchdog ----
          if (activeWatchdogTaskId) {
            log('Watchdog already active, skipping', { existing: activeWatchdogTaskId, skipped: taskId });
          } else {
            activeWatchdogTaskId = taskId;
            const dispatchedAt = new Date().toISOString();
            watchdogCheck(taskId, dispatchedAt).catch(err => {
              log('Watchdog error', { taskId, error: err.message });
              activeWatchdogTaskId = null;
            });
          }

        } else if (result.mode === 'error') {
          // Gateway or model error
          if (result.reply) {
            await writeResponse(result.reply);
          } else {
            await writeResponse('⚠ I wasn\'t able to process that request. Please try again.');
          }
          if (!ackSent) await markProcessed(msg.path);
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
