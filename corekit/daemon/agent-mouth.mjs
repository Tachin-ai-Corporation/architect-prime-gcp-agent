#!/usr/bin/env node
// ============================================================
// agent-mouth.mjs v2 — JSONL-Native Output Processing
//
// Tails the OpenClaw JSONL session transcript to detect final
// agent responses structurally. Replaces log-file scraping.
//
// Features:
//   - JSONL tailer with byte offset tracking
//   - Turn state machine (IDLE → WORKING → ACKED → UPDATED → DONE)
//   - Status updates (ack at 5s, update at 120s) voiced by LLM
//   - Final response delivery via existing LLM classify pipeline
//
// Run:
//   CHANNEL=gchat node agent-mouth.mjs
//   CHANNEL=dashboard node agent-mouth.mjs
// ============================================================
import { readFileSync, writeFileSync, appendFileSync, existsSync,
         statSync, openSync, readSync, closeSync } from 'fs';
import { dirname } from 'path';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const AGENT_DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME || '';
const AGENT_FIRST_NAME = process.env.AGENT_FIRST_NAME || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';
const POLL_INTERVAL = 2000;
const AGENT_VOICE_NAME = AGENT_DISPLAY_NAME || AGENT_FIRST_NAME || '';

// Identity lockdown
const IDENTITY_LOCK_PATH = '/home/node/.openclaw/.identity-lock';
try {
  const locked = readFileSync(IDENTITY_LOCK_PATH, 'utf8').trim();
  if (locked && AGENT_USER_EMAIL && locked !== AGENT_USER_EMAIL) {
    console.error(`[mouth] FATAL: email mismatch (${AGENT_USER_EMAIL} vs ${locked})`);
    process.exit(99);
  }
} catch {}

// Vertex AI config
const VERTEX_PROJECT = process.env.GCP_PROJECT_ID;
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

// Firestore URL
const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

// TASK.json (written by ears)
const TASK_JSON = '/home/node/.openclaw/workspace/TASK.json';

// ---- Contracts ----
let CONTRACTS = { mouth: {}, agents: {} };
try {
  CONTRACTS = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
} catch {}
const MOUTH_CFG = CONTRACTS.mouth || {};
const LLM_ENABLED = MOUTH_CFG.llm_enabled !== false;
const LLM_MODEL = MOUTH_CFG.model || 'gemini-2.5-flash';
const LLM_MAX_TOKENS = MOUTH_CFG.maxTokens || 2000;
const LLM_TEMPERATURE = MOUTH_CFG.temperature ?? 0.1;
const STATUS_ENABLED = MOUTH_CFG.status_updates?.enabled !== false;
// Exponential backoff schedule: first ack fast, then progressively longer
// Default: 10s, 5min, 10min, 30min, 2hr
const STATUS_SCHEDULE = MOUTH_CFG.status_updates?.schedule_ms
  || [10_000, 300_000, 600_000, 1_800_000, 7_200_000];
const DELIVERY_TIMEOUT = 600_000;

// ---- Prompts (loaded from files) ----
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
function loadPrompt(name) {
  for (const base of [SCRIPT_DIR, '/home/node/.openclaw/bin']) {
    try { return readFileSync(`${base}/${name}`, 'utf8'); } catch {}
  }
  return '';
}
const CLASSIFY_PROMPT_TEMPLATE = loadPrompt('mouth-classify-prompt.md');
const STATUS_PROMPTS_RAW = loadPrompt('mouth-status-prompts.md');

// Parse ack/update prompts from the status prompts file by splitting on ## headings
function parseStatusPrompts(raw) {
  const sections = raw.split(/^## /m).filter(Boolean);
  let ack = '', update = '';
  for (const s of sections) {
    if (s.startsWith('Initial Ack')) ack = s.replace(/^[^\n]*\n+/, '').trim();
    else if (s.startsWith('Two-Minute')) update = s.replace(/^[^\n]*\n+/, '').trim();
  }
  return { ack, update };
}
const STATUS_PROMPTS = parseStatusPrompts(STATUS_PROMPTS_RAW);

// ---- Logging ----
const MOUTH_LOG = '/var/log/agent-mouth.log';
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-mouth', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(MOUTH_LOG, line); } catch {}
}

// ---- GCE Metadata Token ----
let _metaToken = null, _metaExpiry = 0;
async function getAccessToken() {
  if (_metaToken && Date.now() < _metaExpiry) return _metaToken;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } });
  const data = await res.json();
  _metaToken = data.access_token;
  _metaExpiry = Date.now() + (data.expires_in - 120) * 1000;
  return _metaToken;
}

// ---- DWD Token ----
let _dwdToken = null, _dwdExpiry = 0;
const DWD_SCOPES = 'https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly';
async function getDwdToken() {
  if (_dwdToken && Date.now() < _dwdExpiry) return _dwdToken;
  const metaBase = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
  const mh = { 'Metadata-Flavor': 'Google' };
  const vmSaEmail = await fetch(`${metaBase}/email`, { headers: mh }).then(r => r.text());
  const metaTokenData = await fetch(`${metaBase}/token`, { headers: mh }).then(r => r.json());
  const signerSa = DWD_SIGNER_SA || vmSaEmail;
  const now = Math.floor(Date.now() / 1000);
  const claim = JSON.stringify({
    iss: signerSa, sub: AGENT_USER_EMAIL, scope: DWD_SCOPES,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const signRes = await fetch(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${signerSa}:signJwt`, {
    method: 'POST', headers: { Authorization: `Bearer ${metaTokenData.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: claim })
  });
  if (!signRes.ok) throw new Error(`signJwt failed (${signRes.status})`);
  const { signedJwt } = await signRes.json();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`DWD failed: ${tokenData.error_description || tokenData.error}`);
  _dwdToken = tokenData.access_token;
  _dwdExpiry = Date.now() + 3500_000;
  return _dwdToken;
}

// ---- GChat Space Discovery ----
let _gchatSpaces = [], _gchatLastDiscovery = 0;
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

// ---- GChat Markdown ----
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
// JSONL TAILER
// ================================================================
const STATE_DIR = '/home/node/.openclaw';
const AGENT_ID = CONTRACTS.agents?.defaultId || 'cortex';
const SESSION_DIR = `${STATE_DIR}/agents/${AGENT_ID}/sessions`;

let fileOffset = 0;
let currentFile = null;

function resolveActiveSessionFile() {
  try {
    const idx = JSON.parse(readFileSync(`${SESSION_DIR}/sessions.json`, 'utf8'));
    let latest = null;
    for (const [, entry] of Object.entries(idx)) {
      if (!latest || (entry.updatedAt || 0) > (latest.updatedAt || 0)) {
        latest = entry;
      }
    }
    if (!latest?.sessionId) return null;
    return `${SESSION_DIR}/${latest.sessionId}.jsonl`;
  } catch { return null; }
}

function tailJSONL() {
  const sessionFile = resolveActiveSessionFile();

  // Handle session rotation
  if (sessionFile !== currentFile) {
    currentFile = sessionFile;
    fileOffset = 0;
    if (currentFile && existsSync(currentFile)) {
      fileOffset = statSync(currentFile).size; // seek to end on first attach
    }
    log('Session file changed', { file: currentFile, offset: fileOffset });
    return [];
  }

  if (!currentFile || !existsSync(currentFile)) return [];
  const stat = statSync(currentFile);
  if (stat.size <= fileOffset) return [];

  // Read new bytes
  const fd = openSync(currentFile, 'r');
  const buf = Buffer.alloc(stat.size - fileOffset);
  readSync(fd, buf, 0, buf.length, fileOffset);
  closeSync(fd);
  fileOffset = stat.size;

  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {} // skip partial writes
  }
  return entries;
}

// ================================================================
// TURN STATE MACHINE
// ================================================================
let turn = { status: 'IDLE', startedAt: null, originalQuestion: null,
             dispatchedAgents: [], completedAgents: [],
             candidateFinal: null, candidateAt: null,
             statusIndex: 0, lastStatusAt: null };

function resetTurn() {
  turn = { status: 'IDLE', startedAt: null, originalQuestion: null,
           dispatchedAgents: [], completedAgents: [],
           candidateFinal: null, candidateAt: null,
           statusIndex: 0, lastStatusAt: null };
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
}

function extractAgentName(tc) {
  const name = tc.name || '';
  if (name === 'sessions_spawn' || name === 'sessions_send') {
    try {
      const input = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments || {});
      return input.agentId || input.agent || null;
    } catch { return null; }
  }
  if (name === 'exec' || name === 'Bash') {
    const cmdText = typeof tc.arguments === 'string' ? tc.arguments : (tc.arguments?.command || '');
    const m = cmdText.match(/brain-exec\s+(?:--plan-exec\s+)?(\S+)/);
    return m ? m[1] : null;
  }
  return null;
}

function processEntry(entry) {
  if (entry.type !== 'message') return;
  const msg = entry.message;
  if (!msg?.role || !msg.content) return;

  // User message → new turn (only if we're idle or done)
  if (msg.role === 'user') {
    if (turn.status === 'IDLE' || turn.status === 'DONE') {
      turn = {
        status: 'WORKING', startedAt: Date.now(),
        originalQuestion: extractText(msg.content),
        dispatchedAgents: [], completedAgents: [],
        candidateFinal: null, candidateAt: null,
        statusIndex: 0, lastStatusAt: null
      };
      log('Turn started', { question: turn.originalQuestion.slice(0, 100) });
    }
    // If already WORKING/ACKED — this is a sub-agent internal message, ignore
    return;
  }

  if (turn.status === 'IDLE' || turn.status === 'DONE') return;

  if (msg.role === 'assistant') {
    const toolCalls = (msg.content || []).filter(c => c.type === 'toolCall');
    const textBlocks = (msg.content || []).filter(c => c.type === 'text');

    if (toolCalls.length > 0) {
      // Dispatching — NOT final
      turn.candidateFinal = null;
      turn.candidateAt = null;
      for (const tc of toolCalls) {
        const agent = extractAgentName(tc);
        if (agent && !turn.dispatchedAgents.includes(agent)) {
          turn.dispatchedAgents.push(agent);
          log('Agent dispatched', { agent });
        }
      }
      return;
    }

    if (textBlocks.length > 0 && toolCalls.length === 0) {
      // Candidate final response
      turn.candidateFinal = extractText(textBlocks);
      turn.candidateAt = Date.now();
      return;
    }
  }

  if (msg.role === 'toolResult') {
    turn.candidateFinal = null;
    turn.candidateAt = null;
    // Track completed agent from toolName
    const tn = msg.toolName || '';
    if (tn === 'sessions_spawn' || tn === 'sessions_yield') {
      // Sub-agent lifecycle, completion tracked by next text
    }
    return;
  }
}

function checkFinalResponse() {
  if (!turn.candidateFinal || !turn.candidateAt) return false;
  // Wait one poll cycle (2s) to confirm nothing else follows
  return (Date.now() - turn.candidateAt) >= 2000;
}

// ================================================================
// STATUS UPDATES
// ================================================================
function buildActivitySummary() {
  const d = turn.dispatchedAgents, c = turn.completedAgents;
  const phases = [];
  if (c.includes('temporal-research')) phases.push('finished looking things up');
  else if (d.includes('temporal-research')) phases.push('looking things up');
  if (c.includes('motor')) phases.push('finished the main work');
  else if (d.includes('motor')) phases.push('working on it');
  if (d.includes('cerebellum')) phases.push('reviewing');
  if (phases.length === 0) return 'thinking it through';
  return phases.join(', ');
}

function fillTemplate(template, vars) {
  let t = template;
  for (const [k, v] of Object.entries(vars)) t = t.replaceAll(`{${k}}`, v || '');
  return t;
}

async function callLLM(systemPrompt, userText, jsonMode = false) {
  const token = await getAccessToken();
  const loc = VERTEX_LOCATION;
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${loc}/publishers/google/models/${LLM_MODEL}:generateContent`;
  const genConfig = { temperature: LLM_TEMPERATURE, maxOutputTokens: LLM_MAX_TOKENS };
  if (jsonMode) genConfig.responseMimeType = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: genConfig
    })
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function fireStatusUpdate(type) {
  if (!STATUS_ENABLED) return;
  const summary = buildActivitySummary();
  const vars = { agent_name: AGENT_VOICE_NAME, activity_summary: summary, original_question: turn.originalQuestion || '' };
  const template = type === 'ack' ? STATUS_PROMPTS.ack : STATUS_PROMPTS.update;

  let updateText;
  if (LLM_ENABLED && template) {
    try {
      updateText = await callLLM(fillTemplate(template, vars), `Question: "${turn.originalQuestion}"`);
    } catch (err) {
      log('Status LLM failed, using fallback', { type, error: err.message });
    }
  }
  if (!updateText) {
    updateText = type === 'ack'
      ? 'Working on it, one moment.'
      : "Still on it — this one's taking a bit longer.";
  }

  await deliver(updateText);
  log('Status update sent', { type, text: updateText.slice(0, 60) });
}

// ================================================================
// DELIVERY
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
// FINAL RESPONSE — LLM CLASSIFY + DELIVER
// ================================================================
async function classifyAndDeliver(rawText) {
  const task = readTaskJson();
  const question = task?.text || turn.originalQuestion || '';

  if (!LLM_ENABLED) {
    await deliver(rawText);
    log('Delivered raw (LLM disabled)', { chars: rawText.length });
    await writeTaskLog(task, 'delivered', rawText.length, 'raw');
    markTaskComplete(task?.taskId);
    return;
  }

  try {
    const prompt = CLASSIFY_PROMPT_TEMPLATE.replace('{agent_name}', AGENT_VOICE_NAME);
    const input = question ? `HUMAN SAID: ${question}\n\nBRAIN OUTPUT:\n${rawText}` : `BRAIN OUTPUT:\n${rawText}`;
    const result = await callLLM(prompt, input, true);

    // Parse JSON response — with fallback
    let parsed;
    try {
      // Try extracting JSON from potential markdown wrapping
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'deliver', text: rawText };
    } catch {
      parsed = { action: 'deliver', text: rawText };
    }

    const action = parsed.action || 'deliver';
    const text = parsed.text || rawText;

    // Deterministic overrides
    const hasEscalate = /\[ESCALATE\]/i.test(rawText);
    if (hasEscalate && action !== 'escalate') parsed.action = 'escalate';

    if (action === 'deliver' || action === 'escalate') {
      await deliver(text);
      log('Delivered', { channel: CHANNEL, chars: text.length, action });
      await writeTaskLog(task, 'delivered', text.length, action);
    } else {
      log('Suppressed (internal)', { chars: rawText.length });
      await writeTaskLog(task, 'suppressed', 0, 'internal');
    }
  } catch (err) {
    log('Classify error — delivering raw', { error: err.message });
    await deliver(rawText);
    await writeTaskLog(task, 'delivered', rawText.length, 'fallback');
  }

  markTaskComplete(task?.taskId);
}

// ================================================================
// TASK LIFECYCLE
// ================================================================
function readTaskJson() {
  try { return JSON.parse(readFileSync(TASK_JSON, 'utf8')); } catch { return null; }
}

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

let taskStartTime = 0;
async function writeTaskLog(task, status, outputChars, classified, errorMsg) {
  if (!task || !FIRESTORE_URL) return;
  try {
    const token = await getAccessToken();
    let agentHostname = '';
    try {
      agentHostname = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/name',
        { headers: { 'Metadata-Flavor': 'Google' } }).then(r => r.text());
      agentHostname = agentHostname.replace(/^fleet-/, '').replace(/^prime-/, '');
    } catch {}

    const primeId = PRIME_ID || agentHostname;
    const isPrime = CHANNEL === 'dashboard';
    const taskId = task.taskId || `t-${Date.now()}`;
    const docPath = isPrime
      ? `${FIRESTORE_URL}/primes/${primeId}/tasks/${taskId}`
      : `${FIRESTORE_URL}/primes/${primeId}/fleet/${agentHostname}/tasks/${taskId}`;

    const body = { fields: {
      taskId: { stringValue: taskId },
      agentId: { stringValue: process.env.AGENT_ID || 'unknown' },
      agentName: { stringValue: agentHostname },
      agentEmail: { stringValue: AGENT_USER_EMAIL },
      channel: { stringValue: task.channel || CHANNEL },
      requester: { stringValue: 'human' },
      text: { stringValue: (task.text || '').slice(0, 500) },
      status: { stringValue: status },
      classified: { stringValue: classified || 'unknown' },
      startedAt: task.timestamp ? { stringValue: task.timestamp } : { nullValue: null },
      deliveredAt: { stringValue: new Date().toISOString() },
      durationMs: { integerValue: String(Date.now() - taskStartTime) },
      outputChars: { integerValue: String(outputChars || 0) },
      error: errorMsg ? { stringValue: errorMsg } : { nullValue: null },
    } };

    const res = await fetch(docPath, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) log('task-log-write error', { status: res.status, taskId });
    else log('task-log-write OK', { taskId, status });
  } catch (err) { log('task-log-write error', { error: err.message }); }
}

// ================================================================
// MAIN LOOP
// ================================================================
async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }
  log('Starting Mouth v2 (JSONL)', { channel: CHANNEL, agent: AGENT_ID, poll_ms: POLL_INTERVAL,
    llm: LLM_ENABLED, status_updates: STATUS_ENABLED, schedule: STATUS_SCHEDULE });

  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });

  // Initial session file resolution
  resolveActiveSessionFile();
  log('Entering polling loop...', { session_dir: SESSION_DIR });

  while (true) {
    try {
      // Tail JSONL for new entries
      const entries = tailJSONL();
      for (const entry of entries) processEntry(entry);

      // Track task start time from TASK.json
      const task = readTaskJson();
      if (task?.status === 'executing' && task.taskId) {
        if (!taskStartTime || task.timestamp !== new Date(taskStartTime).toISOString()) {
          taskStartTime = task.timestamp ? new Date(task.timestamp).getTime() : Date.now();
        }
      }

      // ── Check for confirmed final response ──
      if (turn.status !== 'IDLE' && turn.status !== 'DONE' && checkFinalResponse()) {
        log('Final response confirmed', { chars: turn.candidateFinal.length,
          agents: turn.dispatchedAgents, elapsed_s: Math.floor((Date.now() - turn.startedAt) / 1000) });
        await classifyAndDeliver(turn.candidateFinal);
        turn.status = 'DONE';
        try { writeFileSync('/var/run/agent-mouth-last-delivery', String(Date.now())); } catch {}
        setTimeout(() => resetTurn(), 500);
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      // ── Status updates (exponential backoff schedule) ──
      if (turn.status !== 'IDLE' && turn.status !== 'DONE' && turn.startedAt
          && turn.statusIndex < STATUS_SCHEDULE.length) {
        const elapsed = Date.now() - turn.startedAt;
        const nextThreshold = STATUS_SCHEDULE[turn.statusIndex];
        if (elapsed >= nextThreshold) {
          const type = turn.statusIndex === 0 ? 'ack' : 'update';
          await fireStatusUpdate(type);
          turn.statusIndex++;
          turn.lastStatusAt = Date.now();
          // Move to ACKED after first status, stay ACKED for subsequent
          if (turn.status === 'WORKING') turn.status = 'ACKED';
        }
      }

      // ── Timeout safety net ──
      if (turn.status !== 'IDLE' && turn.status !== 'DONE' && turn.startedAt
          && Date.now() - turn.startedAt > DELIVERY_TIMEOUT) {
        log('Turn timeout', { elapsed_s: DELIVERY_TIMEOUT / 1000 });
        await deliver("⚠ I'm still working on this, but it's taking longer than expected. I'll follow up when I'm done.");
        const task = readTaskJson();
        await writeTaskLog(task, 'timed_out', 0, 'timeout', 'delivery timeout');
        markTaskComplete(task?.taskId);
        resetTurn();
      }

    } catch (err) {
      log('Poll error', { error: err.message });
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => { log('FATAL', { error: err.message, stack: err.stack }); process.exit(1); });
