#!/usr/bin/env node
// ============================================================
// agent-mouth.mjs — Output Classification and Delivery Service
//
// Sole delivery path for ALL agent output.
// Polls gateway logs for Cortex synthesis output, classifies
// with a strict LLM call (internal/external + reformat), and
// delivers to the originating channel.
//
// LLM function is STRICT:
//   1. Classify: internal (suppress) vs external (deliver)
//   2. Reword for human friendliness
//   3. Reformat for channel (GChat markdown, etc.)
//
// Run:
//   CHANNEL=gchat node agent-mouth.mjs
//   CHANNEL=dashboard node agent-mouth.mjs
// ============================================================
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'fs';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';
const POLL_INTERVAL = 2000; // 2s

// Timeout: if no output after this long, send error message
const DELIVERY_TIMEOUT = 300_000; // 5 minutes

const VERTEX_PROJECT = process.env.GCP_PROJECT_ID;
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

// Firestore URL
const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

// TASK.json path (written by ears)
const TASK_JSON = '/home/node/.openclaw/workspace/TASK.json';

// ---- Logging ----
const MOUTH_LOG = '/var/log/agent-mouth.log';
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-mouth', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(MOUTH_LOG, line); } catch {}
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

// ---- DWD Token ----
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
  if (!signRes.ok) throw new Error(`signJwt failed (${signRes.status})`);
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

// ---- GChat Space Discovery ----
let _gchatSpaces = [];
let _gchatLastDiscovery = 0;

async function getGChatSpace() {
  if (Date.now() - _gchatLastDiscovery < 300_000 && _gchatSpaces.length > 0) return _gchatSpaces[0];
  try {
    const token = await getDwdToken();
    const res = await fetch(`${CHAT_API}/spaces?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    _gchatSpaces = (data.spaces || []).map(s => s.name).filter(Boolean);
    _gchatLastDiscovery = Date.now();
  } catch (err) { log('Space discovery error', { error: err.message }); }
  return _gchatSpaces[0] || null;
}

// ---- GChat Markdown Conversion ----
function convertToGChatMarkdown(text) {
  if (!text) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    let c = part;
    c = c.replace(/^####\s+(.+)$/gm, '▸ *$1*');
    c = c.replace(/^###\s+(.+)$/gm, '▸ *$1*');
    c = c.replace(/^##\s+(.+)$/gm, '═ *$1*');
    c = c.replace(/^#\s+(.+)$/gm, '◆ *$1*');
    c = c.replace(/\*\*([^*]+?)\*\*/g, '*$1*');
    c = c.replace(/__([^_]+?)__/g, '_$1_');
    c = c.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '─────────────────────');
    c = c.replace(/^>\s?(.*)$/gm, '▎ $1');
    c = c.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    return c;
  }).join('');
}

// ================================================================
// OUTPUT DETECTION — Gateway Log File
// ================================================================

let lastLogOffset = 0;
let lastTaskId = null;
let taskStartTime = 0;

// Read TASK.json to track what we're waiting for
function readTaskJson() {
  try {
    const data = JSON.parse(readFileSync(TASK_JSON, 'utf8'));
    return data;
  } catch { return null; }
}

function getLatestGatewayOutput() {
  // Find the most recently modified log file in /tmp/openclaw/
  // The gateway doesn't rotate by calendar date — it keeps appending
  // to the file from when it was first created.
  const logDir = '/tmp/openclaw';
  let logPath = null;
  try {
    const files = readdirSync(logDir)
      .filter(f => f.startsWith('openclaw-') && f.endsWith('.log'))
      .map(f => ({ name: f, mtime: statSync(`${logDir}/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) logPath = `${logDir}/${files[0].name}`;
  } catch {}
  if (!logPath || !existsSync(logPath)) return null;

  let logContent;
  try { logContent = readFileSync(logPath, 'utf8'); } catch { return null; }
  if (logContent.length <= lastLogOffset) return null;

  const newContent = logContent.slice(lastLogOffset);
  lastLogOffset = logContent.length;

  // Parse log entries — find the LAST substantial text block
  // This is Cortex's final synthesis (the response to the user)
  const lines = newContent.split('\n').filter(l => l.trim());
  const textEntries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const text = entry['0'] || '';

      // Skip gateway/subsystem noise
      if (text.includes('"subsystem"')) continue;
      if (text.startsWith('{') && text.includes('_meta')) continue;
      if (text === 'No reply from agent.') continue;

      // Skip dispatch plan blocks (internal to cortex)
      if (text.startsWith('DISPATCH_PLAN:') || text.startsWith('PLANNING_ROUND_REQUIRED:')) continue;
      if (text.startsWith('PLAN_VALID')) continue;

      // Skip motor execution reports (internal)
      if (text.startsWith('## Step ') && text.includes('### Action Taken')) continue;

      // Keep substantial text that looks like a user-facing response
      if (text.length > 30) {
        textEntries.push(text);
      }
    } catch {}
  }

  if (textEntries.length === 0) return null;

  // The LAST substantial entry is typically the final synthesis
  const raw = textEntries[textEntries.length - 1];
  return stripThinking(raw);
}

function stripThinking(text) {
  if (!text) return text;
  if (text.includes('<think>') && text.includes('</think>')) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  return text;
}

// ================================================================
// STRICT LLM CLASSIFICATION
//
// This is the ONE LLM call. It is STRICT:
//   1. Is this internal (dispatch plan, motor output) or external (user response)?
//   2. If external: reword for human friendliness
//   3. Reformat for the channel
//
// NEVER drops messages — unknown → deliver raw.
// ================================================================

const CLASSIFY_PROMPT = `You are the output filter for an AI agent. Your job is STRICT and simple:

1. CLASSIFY the output as "deliver" or "suppress":
   - "deliver": This is a response meant for the human user
   - "suppress": This is internal agent thinking (dispatch plans, motor step reports, cerebellum checks)

2. If "deliver": REWORD the text to be human-friendly:
   - Remove any agent-internal references (PLAN.md, DISPATCH_PLAN, motor, cerebellum, prefrontal)
   - Keep the substance — just make it read like a helpful assistant response
   - Keep it concise — under 2000 characters
   - Preserve code blocks, links, and structured data exactly

3. RESPOND with JSON only:
   {"action": "deliver" | "suppress", "text": "<reworded text or empty>"}

RULES:
- If unsure, ALWAYS deliver. Never drop a user-facing message.
- If the text contains a clear user-facing answer, it's "deliver".
- Only suppress pure internal noise (step reports, plan blocks, validation).`;

async function classifyOutput(rawText) {
  try {
    const token = await getAccessToken();
    const url = `https://${VERTEX_LOCATION === 'global' ? '' : VERTEX_LOCATION + '-'}aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/gemini-2.5-flash:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CLASSIFY_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: rawText }] }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!res.ok) {
      log('Classify LLM HTTP error — delivering raw', { status: res.status });
      return { action: 'deliver', text: rawText };
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(text);
    return { action: parsed.action || 'deliver', text: parsed.text || rawText };
  } catch (err) {
    log('Classify error — delivering raw', { error: err.message });
    return { action: 'deliver', text: rawText }; // NEVER drop
  }
}

// ================================================================
// DELIVERY (all deterministic)
// ================================================================

async function deliverToFirestore(text) {
  const token = await getAccessToken();
  await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      text: { stringValue: text }, sender: { stringValue: 'prime' },
      timestamp: { timestampValue: new Date().toISOString() }, processed: { booleanValue: true }
    } })
  });
}

async function deliverToGChat(text) {
  const token = await getDwdToken();
  const space = await getGChatSpace();
  if (!space) { log('No space to deliver to'); return; }
  const formatted = convertToGChatMarkdown(text);
  const res = await fetch(`${CHAT_API}/${space}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: formatted })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    log('GChat deliver error', { status: res.status, body: err.slice(0, 200) });
  }
}

async function deliver(text) {
  if (CHANNEL === 'gchat') await deliverToGChat(text);
  else await deliverToFirestore(text);
}

// ================================================================
// TASK LIFECYCLE — Update TASK.json status
// ================================================================

function markTaskComplete(taskId) {
  try {
    const task = readTaskJson();
    if (task && task.taskId === taskId) {
      task.status = 'complete';
      task.completedAt = new Date().toISOString();
      writeFileSync(TASK_JSON, JSON.stringify(task, null, 2));
    }
  } catch {}
}

// ================================================================
// MAIN LOOP
// ================================================================

async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }

  log('Starting', { channel: CHANNEL, poll_interval_ms: POLL_INTERVAL });

  // Graceful shutdown
  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });

  log('Entering polling loop...');

  while (true) {
    try {
      // Check if there's a task executing
      const task = readTaskJson();
      const hasActiveTask = task && task.status === 'executing';

      if (hasActiveTask) {
        // Track task for timeout
        if (task.taskId !== lastTaskId) {
          lastTaskId = task.taskId;
          taskStartTime = Date.now();
          log('Tracking task', { taskId: task.taskId });
        }

        // Check for timeout
        if (Date.now() - taskStartTime > DELIVERY_TIMEOUT) {
          log('Task timeout — delivering error', { taskId: task.taskId, timeout_s: DELIVERY_TIMEOUT / 1000 });
          await deliver('⚠ I\'m still working on this, but it\'s taking longer than expected. I\'ll keep trying.');
          markTaskComplete(task.taskId);
          lastTaskId = null;
          continue;
        }

        // Poll for gateway output
        const rawOutput = getLatestGatewayOutput();
        if (rawOutput && rawOutput.length > 10) {
          log('Output detected', { chars: rawOutput.length, taskId: task.taskId });

          // Strict LLM classify: internal/external + reformat
          const result = await classifyOutput(rawOutput);

          if (result.action === 'deliver') {
            await deliver(result.text);
            log('Delivered', { channel: CHANNEL, chars: result.text.length, taskId: task.taskId });
            markTaskComplete(task.taskId);
            lastTaskId = null;
          } else {
            log('Suppressed (internal)', { taskId: task.taskId, chars: rawOutput.length });
            // Don't mark complete — keep polling for the real response
          }

          // Touch health check
          try { writeFileSync('/var/run/agent-mouth-last-delivery', String(Date.now())); } catch {}
        }
      } else {
        // No active task — still poll logs for stray output (safety net)
        const rawOutput = getLatestGatewayOutput();
        if (rawOutput && rawOutput.length > 50) {
          log('Stray output detected (no active task)', { chars: rawOutput.length });
          // Classify and deliver anyway — never lose output
          const result = await classifyOutput(rawOutput);
          if (result.action === 'deliver') {
            await deliver(result.text);
            log('Delivered stray output', { channel: CHANNEL, chars: result.text.length });
          }
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
