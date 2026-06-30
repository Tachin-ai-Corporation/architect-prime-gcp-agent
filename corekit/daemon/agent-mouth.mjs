#!/usr/bin/env node
// ============================================================
// agent-mouth.mjs v2 — JSONL-Native Output Processing
//
// Tails the neural gateway's JSONL session transcript to detect final
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
import { readFileSync, writeFileSync, existsSync,
         statSync, openSync, readSync, closeSync } from 'fs';
import { dirname } from 'path';
import { hostname as osHostname } from 'os';
import { getGceToken } from '../corekit/lib/gce-auth.mjs';
import { getDwdToken as _getDwdTokenLib } from '../corekit/lib/dwd-auth.mjs';
import { parseJsonResponse } from '../corekit/lib/json-repair.mjs';
import { parseAddress, deliverToAddress, mirrorToDashboard, initChannel, toGChatMarkdown, discoverSpaces } from '../corekit/lib/channel.mjs';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const AGENT_DISPLAY_NAME = process.env.AGENT_DISPLAY_NAME || '';
const AGENT_FIRST_NAME = process.env.AGENT_FIRST_NAME || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';

// Agent hostname for Firestore path (fleet-{name} → {name})
let AGENT_HOSTNAME = '';
try {
  AGENT_HOSTNAME = osHostname().replace(/^fleet-/, '');
} catch {}

const POLL_INTERVAL = 2000;
const AGENT_VOICE_NAME = AGENT_DISPLAY_NAME || AGENT_FIRST_NAME || '';
const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';

// Identity lockdown
const IDENTITY_LOCK_PATH = CORE_DIR + '/.identity-lock';
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
const TASK_JSON = CORE_DIR + '/workspace/TASK.json';

// ---- Contracts ----
let CONTRACTS = { mouth: {}, agents: {} };
try {
  CONTRACTS = JSON.parse(readFileSync(CORE_DIR + '/corekit/contracts.json', 'utf8'));
} catch {}
const MOUTH_CFG = CONTRACTS.mouth || {};
const LLM_ENABLED = MOUTH_CFG.llm_enabled !== false;
const LLM_MODEL = MOUTH_CFG.model || 'gemini-2.5-flash';
const LLM_MAX_TOKENS = MOUTH_CFG.maxTokens || 8192;
const LLM_TEMPERATURE = MOUTH_CFG.temperature ?? 0.1;
const STATUS_ENABLED = MOUTH_CFG.status_updates?.enabled !== false;
// Exponential backoff schedule: first ack fast, then progressively longer
// Default: 10s, 5min, 10min, 30min, 2hr
const STATUS_SCHEDULE = MOUTH_CFG.status_updates?.schedule_ms
  || [10_000, 300_000, 600_000, 1_800_000, 7_200_000];
const DELIVERY_TIMEOUT = 600_000;

const CHAT_CONFIG = CONTRACTS.chat || {};
const REPLY_IN_THREAD = CHAT_CONFIG.reply_in_thread !== false;  // default true
const DASHBOARD_MIRROR = CONTRACTS.mouth?.dashboard_visibility_mirror !== false;  // default true

initChannel({ contracts: CONTRACTS, firestoreUrl: FIRESTORE_URL, primeId: PRIME_ID, agentHostname: AGENT_HOSTNAME });

// ---- Prompts (loaded from files) ----
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
function loadPrompt(name) {
  for (const base of [SCRIPT_DIR, CORE_DIR + '/bin']) {
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
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-mouth', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
}

// ---- DWD Token wrapper (delegates to shared lib) ----
const DWD_SCOPES = 'https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly';
async function getDwdToken() {
  return _getDwdTokenLib({
    signerServiceAccount: DWD_SIGNER_SA,
    subjectEmail: AGENT_USER_EMAIL,
    scopes: DWD_SCOPES,
  });
}

// GChat space discovery and markdown conversion now in channel.mjs

// ================================================================
// JSONL TAILER
// ================================================================
const STATE_DIR = CORE_DIR;
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
  return null;
}

function processEntry(entry) {
  if (entry.type !== 'message') return;
  const msg = entry.message;
  if (!msg?.role || !msg.content) return;

  // User message → new turn (only if we're idle or done)
  if (msg.role === 'user') {
    const text = extractText(msg.content);

    // Skip Brain-orchestrated sessions — these are delivered via v3 envelope path
    if (text.includes('[BRAIN-ORCHESTRATED]')) {
      log('Skipping Brain-orchestrated session', { preview: text.slice(0, 80) });
      return;
    }

    if (turn.status === 'IDLE' || turn.status === 'DONE') {
      turn = {
        status: 'WORKING', startedAt: Date.now(),
        originalQuestion: text,
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
  const token = await getGceToken();
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

  // Status updates use a default address (v2 legacy path)
  const statusAddr = await buildDefaultAddress();
  await deliver(updateText, statusAddr);
  log('Status update sent', { type, text: updateText.slice(0, 60) });
}

// ================================================================
// DEFAULT ADDRESS (legacy v2 fallback)
// ================================================================
async function buildDefaultAddress() {
  if (CHANNEL === 'gchat') {
    try {
      const token = await getDwdToken();
      const spaces = await discoverSpaces(token);
      if (spaces.length > 0) return { channel: 'gchat', space: spaces[0], thread: null };
    } catch (err) {
      log('Default address space discovery failed', { error: err.message });
    }
    return { channel: 'gchat', space: null, thread: null };
  }
  // Prime (CHANNEL=dashboard): fleet_agent=null → writes to primes/{id}/messages
  // Fleet (CHANNEL=gchat but falling through to dashboard delivery): uses AGENT_HOSTNAME
  return { channel: 'dashboard', fleet_agent: CHANNEL === 'dashboard' ? null : (AGENT_HOSTNAME || null) };
}

// ================================================================
// DELIVERY
// ================================================================
/**
 * Deliver a delegation message to the target agent via an Address.
 * Canon B-9: Mouth is the single point of all outbound communication.
 *
 * @param {string} text - The delegation marker text
 * @param {object} addr - Channel Address
 * @param {string} targetEmail - Target agent's email
 */
async function deliverDelegation(text, addr, targetEmail) {
  const token = await getDwdToken();
  await deliverToAddress(addr, text, {
    token,
    deliveryTarget: targetEmail,
    mentions: [targetEmail],
    replyInThread: false,  // delegations are flat space messages
    log,
  });
}

async function deliver(text, addr, mentions = []) {
  const token = addr?.channel === 'gchat' ? await getDwdToken() : await getGceToken();
  await deliverToAddress(addr, text, {
    token,
    replyInThread: REPLY_IN_THREAD,
    mentions,
    log,
  });

  // Dashboard visibility mirror — observability, not a reply destination
  if (addr?.channel === 'gchat' && DASHBOARD_MIRROR) {
    try {
      const gceToken = await getGceToken();
      await mirrorToDashboard(text, gceToken, { log });
    } catch (err) {
      log('Dashboard mirror failed', { error: err.message });
    }
  }
}

// ================================================================
// FINAL RESPONSE — LLM CLASSIFY + DELIVER
// ================================================================
async function classifyAndDeliver(rawText, overrideQuestion, addr, mentions = []) {
  const task = readTaskJson();
  const question = overrideQuestion || task?.text || turn.originalQuestion || '';

  // Extract pinger/sender email from task metadata or default
  let finalMentions = [...mentions];
  const senderEmail = task?.metadata?.senderEmail || task?.senderEmail;
  if (senderEmail && senderEmail !== 'unknown') {
    finalMentions.push(senderEmail);
  }
  finalMentions = [...new Set(finalMentions)];

  if (!LLM_ENABLED) {
    await deliver(rawText, addr, finalMentions);
    log('Delivered raw (LLM disabled)', { chars: rawText.length });
    await writeTaskLog(task, 'delivered', rawText.length, 'raw');
    markTaskComplete(task?.taskId);
    return;
  }

  try {
    const prompt = CLASSIFY_PROMPT_TEMPLATE.replaceAll('{agent_name}', AGENT_VOICE_NAME);

    // Build rich input with conversation context
    const parts = [];
    if (question) parts.push(`CONTEXT (what the human asked or what triggered this):\n${question}`);
    parts.push(`BRAIN OUTPUT:\n${rawText}`);
    const input = parts.join('\n\n');

    const result = await callLLM(prompt, input, true);

    let parsed;
    try {
      parsed = parseJsonResponse(result);
      if (parsed.error === 'parse_failed') parsed = { action: 'deliver', text: rawText };
    } catch {
      parsed = { action: 'deliver', text: rawText };
    }

    const action = parsed.action || 'deliver';

    // Determine voicing status — distinguish empty LLM response from identical text
    let finalText, voiceStatus;
    const llmText = parsed.text || null;

    if (!llmText) {
      // LLM returned empty/null text — retry with a direct voicing call
      log('Voicing returned empty text — retrying with direct prompt');
      try {
        const retryPrompt = `You are ${AGENT_VOICE_NAME}. Rephrase the following for Google Chat. Keep ALL factual content, links, and data intact. Just make it sound like you (${AGENT_VOICE_NAME}) are talking naturally to a colleague. Return ONLY the rephrased text, no JSON.`;
        const retryResult = await callLLM(retryPrompt, rawText, false);
        finalText = (retryResult && retryResult.length > 10) ? retryResult : rawText;
        voiceStatus = (retryResult && retryResult.length > 10) ? 'retry' : 'passthrough_empty';
      } catch {
        finalText = rawText;
        voiceStatus = 'passthrough_empty';
      }
    } else if (llmText === rawText) {
      finalText = llmText;
      voiceStatus = 'passthrough_identical';
    } else {
      finalText = llmText;
      voiceStatus = 'yes';
    }

    // Deterministic overrides
    const hasEscalate = /\[ESCALATE\]/i.test(rawText);
    if (hasEscalate && action !== 'escalate') parsed.action = 'escalate';

    if (action === 'deliver' || action === 'escalate') {
      await deliver(finalText, addr, finalMentions);
      log('Delivered', { channel: CHANNEL, chars: finalText.length, action,
        voiced: voiceStatus });
      await writeTaskLog(task, 'delivered', finalText.length, action);
    } else {
      log('Suppressed (internal)', { chars: rawText.length });
      await writeTaskLog(task, 'suppressed', 0, 'internal');
    }
  } catch (err) {
    log('Classify error — delivering raw', { error: err.message });
    await deliver(rawText, addr, finalMentions);
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
    const token = await getGceToken();
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
// BRAIN V3 — ENVELOPE POLLING
// ================================================================
const _deliveredEnvelopes = new Set();

async function pollBrainV3Envelopes() {
  if (!FIRESTORE_URL || !PRIME_ID) return;

  try {
    const token = await getGceToken();
    const ownerEmail = AGENT_USER_EMAIL || process.env.AGENT_ID || '';

    // ── Query: delivery_status=pending (returns only actionable items) ──
    const pendingQuery = {
      structuredQuery: {
        from: [{ collectionId: 'work' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'owner' }, op: 'EQUAL',
                value: { stringValue: ownerEmail } } },
              { fieldFilter: { field: { fieldPath: 'delivery_status' }, op: 'EQUAL',
                value: { stringValue: 'pending' } } },
            ]
          }
        },
        orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
        limit: 50,
      },
    };

    const queryUrl = `${FIRESTORE_URL}:runQuery`;

    let results = [];
    try {
      const res = await fetch(queryUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingQuery),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) results = data.filter(r => r.document?.fields);
      } else if (!pollBrainV3Envelopes._pendingIndexWarned) {
        const errText = await res.text().catch(() => '');
        log('Brain v3 delivery_status query needs index', { status: res.status, body: errText.slice(0, 300) });
        pollBrainV3Envelopes._pendingIndexWarned = true;
      }
    } catch (err) {
      log('Brain v3 pending query error', { error: err.message });
    }

    // Diagnostic: log every Nth poll cycle to show the poll is alive
    if (!pollBrainV3Envelopes._count) pollBrainV3Envelopes._count = 0;
    pollBrainV3Envelopes._count++;
    if (pollBrainV3Envelopes._count % 60 === 1) { // every ~5 minutes (60 * 5s)
      log('Brain v3 poll heartbeat', { cycle: pollBrainV3Envelopes._count, owner: ownerEmail,
        results: results.length, primeId: PRIME_ID, delivered_cache: _deliveredEnvelopes.size });
    }

    let delivered = 0;
    let skippedDelivered = 0;
    for (const r of results) {
      if (!r.document?.fields) continue;
      const f = r.document.fields;
      const envId = f.id?.stringValue;
      const output = f.output?.stringValue;
      const status = f.status?.stringValue;
      const deliveryStatus = f.delivery_status?.stringValue;
      const deliveredAt = f.delivered_at?.timestampValue || f.delivered_at?.stringValue;
      const parentId = f.parent_id?.stringValue || null;

      // Skip: no ID
      if (!envId) continue;
      // Skip: no output (log a warning and mark as delivered to avoid infinite polling)
      if (!output) {
        log('WARN', `Envelope ${envId} has no output — skipping delivery and marking delivered`, { envId });
        try {
          const token2 = await getGceToken();
          const docPath = `${FIRESTORE_URL}/work/${envId}?updateMask.fieldPaths=delivered_at&updateMask.fieldPaths=delivered_channel&updateMask.fieldPaths=delivery_status`;
          await fetch(docPath, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: {
              delivered_at: { timestampValue: new Date().toISOString() },
              delivered_channel: { stringValue: CHANNEL },
              delivery_status: { stringValue: 'delivered' },
            } }),
          });
        } catch (err) {
          log('Failed to mark empty output envelope delivered', { envId, error: err.message });
        }
        continue;
      }
      // Skip: already delivered (but NOT if brain explicitly reset delivery_status to pending for re-delivery)
      if (deliveryStatus === 'delivered') { skippedDelivered++; continue; }
      if (deliveredAt && deliveryStatus !== 'pending') { _deliveredEnvelopes.add(envId); skippedDelivered++; continue; }
      // Skip: explicitly internal (should never appear in query results, but defense-in-depth)
      if (deliveryStatus === 'internal') { skippedDelivered++; continue; }
      // Skip: archived envelopes — stale delivery_status from race condition
      if (status === 'archived') { skippedDelivered++; continue; }
      // Skip: child envelopes (C/T) — only top-level M envelopes should be delivered
      // Exception: intent='ack', 'notification', 'delegation_send', 'delegation_result'
      // are intentionally deliverable C/T pairs
      const envIntent = f.intent?.stringValue;
      if (parentId && envIntent !== 'ack' && envIntent !== 'notification'
          && envIntent !== 'delegation_send' && envIntent !== 'delegation_result') {
        log('Skipped child envelope (not top-level)', { envId, type: f.type?.stringValue, parentId });
        skippedDelivered++;
        continue;
      }
      // Re-deliver: if brain reset delivery_status to 'pending' on a previously-delivered envelope
      // (e.g., after self-unblock → re-block), clear cache so it gets re-delivered
      if (_deliveredEnvelopes.has(envId) && deliveryStatus === 'pending') {
        _deliveredEnvelopes.delete(envId);
        log('Re-delivering envelope (delivery_status reset to pending)', { envId, status });
      }
      // Skip: in-memory dedup
      if (_deliveredEnvelopes.has(envId)) { skippedDelivered++; continue; }

      // Mark as delivered immediately to prevent duplicates
      _deliveredEnvelopes.add(envId);

      log('Brain v3 envelope ready', { envId, status, type: f.type?.stringValue, chars: output.length });

      // Classify and deliver through the voicing pipeline
      // ALL envelope types go through LLM voicing — mouth always speaks in the agent's voice
      try {
        const envQuestion = f.instruction?.stringValue || f.context_summary?.stringValue || '';
        const envStatus = status || '';
        const envType = envIntent || '';

        // Build context prefix so the voicing LLM understands the envelope's nature
        let contextHint = '';
        if (envStatus === 'needs_input') {
          contextHint = '[This is a question or request for the human — the agent needs input to continue]\n\n';
        } else if (envStatus === 'blocked') {
          contextHint = '[The agent is blocked and needs help — escalate clearly]\n\n';
        } else if (envType === 'notification') {
          contextHint = '[This is a status notification — keep it brief and informational]\n\n';
        } else if (envType === 'ack') {
          contextHint = '[This is a quick acknowledgment — keep it very short]\n\n';
        }

        // Resolve delivery address from envelope
        const deliveryAddr = f.delivery_address?.mapValue?.fields;
        const sourceMeta = f.source_meta?.mapValue?.fields;
        const senderEmail = sourceMeta?.senderEmail?.stringValue || '';

        let addr = null;
        if (deliveryAddr) {
          const ch = deliveryAddr.channel?.stringValue || 'gchat';
          if (ch === 'gchat') {
            addr = { channel: 'gchat', space: deliveryAddr.space?.stringValue || null, thread: deliveryAddr.thread?.stringValue || null };
          } else {
            // Prime agents deliver to root messages, not fleet subcollection
            const fleetAgent = CHANNEL === 'dashboard' ? null : (deliveryAddr.fleet_agent?.stringValue || null);
            addr = { channel: 'dashboard', fleet_agent: fleetAgent };
          }
        }
        if (!addr) {
          // Legacy fallback: try source_meta, then fall back to first space
          if (sourceMeta) {
            addr = parseAddress(sourceMeta, CHANNEL);
          }
        }
        if (!addr || (addr.channel === 'gchat' && !addr.space)) {
          log('No delivery_address on envelope — constructing default', { envId });
          addr = await buildDefaultAddress();
        }

        // Delegation envelopes: deliver directly without voicing — markers are pre-formatted
        const deliveryTarget = f.delivery_target?.stringValue;

        let mentions = [];
        if (senderEmail && senderEmail !== 'unknown') {
          mentions.push(senderEmail);
        } else if (envStatus === 'needs_input' || envStatus === 'blocked') {
          mentions.push('all');
        }

        if (deliveryTarget && (envIntent === 'delegation_send' || envIntent === 'delegation_result')) {
          await deliverDelegation(output, addr, deliveryTarget);
          log('Delivered delegation envelope to target', { envId, target: deliveryTarget, intent: envIntent });
        } else {
          // Standard voicing pipeline for non-delegation envelopes
          await classifyAndDeliver(contextHint + output, envQuestion, addr, mentions);
          log('Delivered envelope output', { envId, status: envStatus, intent: envType });
        }

        // Mark envelope as delivered in Firestore (set both delivered_at AND delivery_status)
        const token2 = await getGceToken();
        const docPath = `${FIRESTORE_URL}/work/${envId}?updateMask.fieldPaths=delivered_at&updateMask.fieldPaths=delivered_channel&updateMask.fieldPaths=delivery_status`;
        const patchRes = await fetch(docPath, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            delivered_at: { timestampValue: new Date().toISOString() },
            delivered_channel: { stringValue: CHANNEL },
            delivery_status: { stringValue: 'delivered' },
          } }),
        });
        if (!patchRes.ok) {
          const patchBody = await patchRes.text().catch(() => '');
          throw new Error(`Firestore PATCH failed: ${patchRes.status} ${patchBody.slice(0, 200)}`);
        }
        delivered++;
      } catch (err) {
        log('Envelope delivery error', { envId, error: err.message });
      }
    }

    if (delivered > 0 || skippedDelivered > 10) {
      log('Brain v3 poll delivered', { count: delivered, skipped_delivered: skippedDelivered });
    }
  } catch (err) {
    log('Brain v3 poll error', { error: err.message });
  }
}

// ================================================================
// MAIN LOOP
// ================================================================
async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }
  log('Starting Mouth v3 (JSONL + Brain v3 envelopes)', { channel: CHANNEL, agent: AGENT_ID, poll_ms: POLL_INTERVAL,
    llm: LLM_ENABLED, status_updates: STATUS_ENABLED, schedule: STATUS_SCHEDULE });

  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });

  // Initial session file resolution
  resolveActiveSessionFile();
  log('Entering polling loop...', { session_dir: SESSION_DIR });

  // ── Dedicated Brain v3 envelope poll (independent of session loop) ──
  const V3_POLL_MS = 5000;
  let _v3Polling = false;
  setInterval(async () => {
    if (_v3Polling) return; // skip if previous poll still running
    _v3Polling = true;
    try {
      await pollBrainV3Envelopes();
    } catch (err) {
      log('Brain v3 interval error', { error: err.message });
    } finally {
      _v3Polling = false;
    }
  }, V3_POLL_MS);

  // Also fire one immediately
  pollBrainV3Envelopes().catch(err => log('Brain v3 initial poll error', { error: err.message }));

  while (true) {
    try {
      // Tail JSONL for new entries (v2 path — still works for direct gateway calls)
      const entries = tailJSONL();
      for (const entry of entries) processEntry(entry);

      // Track task start time from TASK.json
      const task = readTaskJson();
      if (task?.status === 'executing' && task.taskId) {
        if (!taskStartTime || task.timestamp !== new Date(taskStartTime).toISOString()) {
          taskStartTime = task.timestamp ? new Date(task.timestamp).getTime() : Date.now();
        }
      }

      // ── Check for confirmed final response (v2 JSONL path) ──
      if (turn.status !== 'IDLE' && turn.status !== 'DONE' && checkFinalResponse()) {
        log('Final response confirmed', { chars: turn.candidateFinal.length,
          agents: turn.dispatchedAgents, elapsed_s: Math.floor((Date.now() - turn.startedAt) / 1000) });
        const v2Addr = await buildDefaultAddress();
        await classifyAndDeliver(turn.candidateFinal, undefined, v2Addr);
        turn.status = 'DONE';
        try { writeFileSync('/var/run/agent-mouth-last-delivery', String(Date.now())); } catch {}
        setTimeout(() => resetTurn(), 500);
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        continue;
      }

      // ── Brain v3: Now runs on dedicated interval (see below) ──

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
        const timeoutAddr = await buildDefaultAddress();
        await deliver("⚠ I'm still working on this, but it's taking longer than expected. I'll follow up when I'm done.", timeoutAddr);
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
