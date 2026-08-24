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
import { getGceToken } from '../security/gce-auth.mjs';
import { threadKeyFor, appendTurn } from '../work/thread-ledger.mjs';
import { getDwdToken as _getDwdTokenLib } from '../security/dwd-auth.mjs';
import { isDelegationPing, isDelegationMarker, isDelegationResultMarker } from '../work/delegation.mjs';
import { makeAddress, serializeAddress, discoverSpaces as _discoverSpacesLib, resolveAgentUserId } from '../providers/channel.mjs';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';

// Agent hostname for Firestore path (fleet-{name} → {name})
let AGENT_HOSTNAME = '';
try {
  AGENT_HOSTNAME = osHostname().replace(/^fleet-/, '');
} catch {}

let GATEWAY_URL;  // set after CONTRACTS load
const HTTP_TIMEOUT = 600_000;

// Ears-specific config (from contracts or env)
let EARS_CONFIG = { firestore_poll_ms: 3000, gchat_poll_ms: 5000, dedup_window_ms: 300000, cooldown_ms: 2000 };
const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
let CONTRACTS = { ears: {}, vertex: {} };
try {
  CONTRACTS = JSON.parse(readFileSync(CORE_DIR + '/corekit/contracts.json', 'utf8'));
  if (CONTRACTS.ears) EARS_CONFIG = { ...EARS_CONFIG, ...CONTRACTS.ears };
} catch {}
GATEWAY_URL = `http://127.0.0.1:${CONTRACTS.gateway?.port || 18789}/v1/chat/completions`;

const POLL_INTERVAL = CHANNEL === 'gchat' ? EARS_CONFIG.gchat_poll_ms : EARS_CONFIG.firestore_poll_ms;
const DEDUP_WINDOW = EARS_CONFIG.dedup_window_ms;
const COOLDOWN_MS = EARS_CONFIG.cooldown_ms;
const CONTEXT_WINDOW = EARS_CONFIG.gchat_context_messages || 5;
const MAX_PAGES_PER_POLL = EARS_CONFIG.max_pages_per_poll || 5;
const NEW_SPACE_SEED = EARS_CONFIG.new_space_seed || 'now';
const MENTION_MATCH = EARS_CONFIG.mention_match || 'annotation';
const CHAT_CONFIG = CONTRACTS.chat || {};

// Preprocessing config (LLM-based message repair for gchat)
const PREPROCESS_CFG = EARS_CONFIG.preprocess || {};
const PREPROCESS_ENABLED = PREPROCESS_CFG.enabled === true && CHANNEL === 'gchat';
const PREPROCESS_MODEL = PREPROCESS_CFG.model || 'gemini-3.6-flash';
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
const IDENTITY_LOCK_PATH = CORE_DIR + '/.identity-lock';
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
  GATEWAY_TOKEN = readFileSync(CORE_DIR + '/.gateway-token', 'utf8').trim();
} catch {}

// Gateway route from contracts
const GATEWAY_ROUTE = CONTRACTS.agents?.gatewayRoute || 'brain/cortex';

// TASK.json path (for mouth tracking)
const TASK_JSON = CORE_DIR + '/workspace/TASK.json';

// ---- Shared state ----
const recentMessages = new Map();            // dedup by content hash
const lastSeen = new Map();                  // sender → timestamp (cooldown)
const conversationHistory = [];
const MAX_HISTORY = 4;

// ---- Logging ----
const PREPROCESS_LOG = '/var/log/agent-ears-preprocess.log';
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-ears', ch: CHANNEL, msg, ...meta }) + '\n';
  process.stderr.write(line);
}

// ---- Preprocess Prompt ----
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
let PREPROCESS_PROMPT = '';
if (PREPROCESS_ENABLED) {
  for (const base of [SCRIPT_DIR, CORE_DIR + '/bin']) {
    try { PREPROCESS_PROMPT = readFileSync(`${base}/ears-preprocess-prompt.md`, 'utf8'); break; } catch {}
  }
  if (!PREPROCESS_PROMPT) log('WARN: preprocess enabled but prompt file not found');
}

// ---- LLM Call (Vertex AI, same pattern as mouth) ----
async function callLLM(systemPrompt, userText) {
  const token = await getGceToken();
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

// ---- DWD Token wrapper (delegates to shared lib) ----
// C-27/B-33: ears is INBOUND only — it lists/reads messages, never POSTs. It
// holds read scopes only; the send-capable chat.messages scope belongs to the
// mouth alone.
const DWD_SCOPES = 'https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly';

async function getDwdToken() {
  return _getDwdTokenLib({
    signerServiceAccount: DWD_SIGNER_SA,
    subjectEmail: AGENT_USER_EMAIL,
    scopes: DWD_SCOPES,
  });
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
  const token = await getGceToken();
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
  const token = await getGceToken();
  await fetch(`https://firestore.googleapis.com/v1/${msg.id}?updateMask.fieldPaths=processed`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { processed: { booleanValue: true } } })
  });
}

// ---- GChat Poller (Fleet) ----
let _gchatSpaces = [];
let _gchatLastDiscovery = 0;
let _gchatCursors = {};  // { [spaceName]: highWaterTimestamp }
const _gchatSeen = new Map();
let _agentUserId = null;  // resolved at boot — 'users/12345'
// Persist under /var/lib (survives reboots) not /tmp (ephemeral)
const _stateDir = '/var/lib/agent-ears-state';
try { mkdirSync(_stateDir, { recursive: true }); } catch {}
// Also check legacy /tmp location for in-place upgrades
const _legacyStateDir = '/tmp/agent-ears-state';
try {
  const raw = readFileSync(`${_stateDir}/cursors.json`, 'utf8');
  _gchatCursors = JSON.parse(raw);
  log('Loaded per-space cursors', { spaces: Object.keys(_gchatCursors).length });
} catch {
  // Legacy: try old highwater file, seed all known spaces to that value
  try {
    const hw = readFileSync(`${_stateDir}/highwater`, 'utf8').trim();
    if (hw) {
      log('Migrating legacy highwater to per-space cursors', { highwater: hw });
      // Will be populated per-space on first poll
      _gchatCursors.__legacy = hw;
    }
  } catch {}
}
try {
  let s;
  try { s = JSON.parse(readFileSync(`${_stateDir}/seen.json`, 'utf8')); } catch {
    s = JSON.parse(readFileSync(`${_legacyStateDir}/seen.json`, 'utf8'));
  }
  for (const k of Object.keys(s)) _gchatSeen.set(k, true);
} catch {}

async function discoverSpaces() {
  if (Date.now() - _gchatLastDiscovery < 300_000 && _gchatSpaces.length > 0) return;
  const token = await getDwdToken();
  _gchatSpaces = await _discoverSpacesLib(token);
  _gchatLastDiscovery = Date.now();
  log('Discovered spaces', { count: _gchatSpaces.length });

  // Seed cursors for newly-discovered spaces
  for (const sp of _gchatSpaces) {
    if (!_gchatCursors[sp]) {
      _gchatCursors[sp] = NEW_SPACE_SEED === 'now' ? new Date().toISOString() : '';
      log('Seeded cursor for new space', { space: sp, seed: _gchatCursors[sp] ? 'now' : 'epoch' });
    }
  }
  // Apply legacy highwater to spaces that don't have cursors yet
  if (_gchatCursors.__legacy) {
    for (const sp of _gchatSpaces) {
      if (!_gchatCursors[sp] || _gchatCursors[sp] === '') {
        _gchatCursors[sp] = _gchatCursors.__legacy;
      }
    }
    delete _gchatCursors.__legacy;
  }
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

  // Build context preamble from prior messages, excluding agent's own
  const agentDisplayName = process.env.AGENT_DISPLAY_NAME || '';
  const contextLines = [];
  for (const m of priorMsgs) {
    const text = m.text || m.argumentText || '';
    if (!text.trim()) continue;
    // Skip agent's own messages in context — prevents old delegation
    // markers and voiced output from polluting the context window.
    const mSenderId = m.sender?.name || '';
    if (_agentUserId && mSenderId === _agentUserId) continue;
    const senderName = m.sender?.displayName || '';
    if (!_agentUserId && agentDisplayName && senderName === agentDisplayName) continue;
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

// SESSION_CONTEXT_PLAN Phase 4: monotonic thread-ledger accumulation from the
// poll page. Ears remains input-only (B-3) — this is deterministic transport
// bookkeeping, no LLM, no delivery. Role detection reuses the same agent-user
// check as buildThreadConversation; before _agentUserId resolves, an agent
// turn may transiently persist as 'admin' and self-heals on the next page
// re-observation (same turn id, re-upserted with the correct role).
async function backfillThreadLedger(space, threadName, pageMsgs) {
  if (CONTRACTS.conversation?.enabled === false) return;
  if (CONTRACTS.conversation?.thread_ledger_enabled === false) return;
  const address = { channel: 'gchat', space, thread: threadName };
  const threadKey = threadKeyFor(address, PRIME_ID);
  if (!threadKey) return;
  const cfg = CONTRACTS.conversation || {};
  const sameThread = pageMsgs
    .filter(m => (m.thread?.name || null) === threadName && (m.text || '').trim())
    .slice(-((cfg.max_turns || 12) * 2)); // bound writes per poll
  for (const m of sameThread) {
    const isAgent = (_agentUserId && m.sender?.name === _agentUserId);
    await appendTurn({
      projectId: GCP_PROJECT,
      primeId: PRIME_ID,
      getToken: getGceToken,
      threadKey,
      turnId: m.name,
      role: isAgent ? 'prime' : 'admin',
      text: m.text,
      source: 'gchat-backfill',
      channelMeta: address,
      config: cfg,
      log: (lvl, msg) => log(`thread-ledger ${lvl}`, { msg }),
    });
  }
}

function buildThreadConversation(targetMsg, pageMsgs) {
  if (CONTRACTS.conversation?.enabled === false) return null;

  const cfg = CONTRACTS.conversation || {};
  const maxTurns = cfg.max_turns || 12;
  const perTurnChars = cfg.per_turn_chars || 600;
  const budgetChars = cfg.budget_chars || 6000;

  const hasThread = !!targetMsg.thread?.name;
  // Find all messages in pageMsgs that belong to the same thread as targetMsg, sorted oldest-first.
  // Support threadless DM spaces by falling back to space scoping if thread name is absent.
  const threadMsgs = pageMsgs
    .filter(m => {
      if (hasThread) {
        return m.thread?.name && m.thread.name === targetMsg.thread.name;
      }
      return true; // threadless space-wide fallback
    })
    .filter(m => m.createTime < targetMsg.createTime) // strict target message self-exclusion
    .slice(-maxTurns);

  const turns = threadMsgs.map(m => {
    const senderEmail = m.sender?.email || '';
    const senderDisplayName = m.sender?.displayName || '';
    const isAgent = (_agentUserId && m.sender?.name === _agentUserId) ||
                    (process.env.AGENT_DISPLAY_NAME && senderDisplayName === process.env.AGENT_DISPLAY_NAME);
    const role = isAgent ? 'prime' : 'admin';
    const text = (m.text || m.argumentText || '').trim();
    return {
      role,
      text: text.substring(0, perTurnChars) + (text.length > perTurnChars ? ' […trimmed]' : ''),
      ts: m.createTime || '',
    };
  });

  if (turns.length === 0) return null;

  const render = ts => ts.map(t => `[${t.role}${t.ts ? ' ' + t.ts.substring(0, 16) : ''}] ${t.text}`).join('\n');
  let kept = turns;
  while (kept.length > 1 && render(kept).length > budgetChars) {
    kept = kept.slice(1);
  }

  const lastAdmin = [...kept].reverse().find(t => t.role === 'admin') || null;
  const lastPrime = [...kept].reverse().find(t => t.role === 'prime') || null;

  return {
    block: `## Conversation (most recent ${kept.length} turns, oldest first)\n${render(kept)}`,
    turns: kept,
    last_admin_text: lastAdmin?.text || null,
    last_prime_text: lastPrime?.text || null,
    cue_text: kept.slice(-4).map(t => t.text).join(' '),
  };
}

async function pollGChat() {
  await discoverSpaces();
  if (_gchatSpaces.length === 0) return [];
  const token = await getDwdToken();
  const messages = [];
  for (const space of _gchatSpaces) {
    try {
      const spaceCursor = _gchatCursors[space] || '';
      let pageToken = null;
      let pagesPolled = 0;

      do {
        let url = `${CHAT_API}/${space}/messages?pageSize=25&orderBy=createTime%20desc`;
        if (pageToken) url += `&pageToken=${pageToken}`;

        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) break;
        const data = await res.json();
        const pageMsgs = (data.messages || []).reverse();
        pageToken = data.nextPageToken || null;
        pagesPolled++;

        for (let i = 0; i < pageMsgs.length; i++) {
          const msg = pageMsgs[i];
          const ct = msg.createTime || '';
          if (ct <= spaceCursor) continue;
          if (_gchatSeen.has(msg.name)) continue;

          // Stable echo filter
          const senderUserId = msg.sender?.name || '';
          if (_agentUserId && senderUserId === _agentUserId) continue;
          const senderDisplayName = msg.sender?.displayName || '';
          const agentDisplayName = process.env.AGENT_DISPLAY_NAME || '';
          if (!_agentUserId && agentDisplayName && senderDisplayName === agentDisplayName) continue;

          const text = msg.text || msg.argumentText || '';
          if (!text) continue;

          // Annotation-based mention detection
          let mentioned = false;
          if (MENTION_MATCH === 'annotation' && msg.annotations) {
            for (const ann of msg.annotations) {
              if (ann.type === 'USER_MENTION') {
                if (_agentUserId && ann.userMention?.user?.name === _agentUserId) {
                  mentioned = true;
                  break;
                }
                
                // Fallback relaxed match: check if the text of the mention matches this agent
                const startIndex = ann.startIndex ?? 0;
                const length = ann.length ?? 0;
                if (length > 0) {
                  const mentionText = text.slice(startIndex, startIndex + length).toLowerCase();
                  const cleanMention = mentionText.replace(/[@\-_\s]/g, '').trim();
                  
                  const cleanDisplayName = (process.env.AGENT_DISPLAY_NAME || '').replace(/[\-_\s]/g, '').toLowerCase();
                  const cleanAgentMention = (process.env.AGENT_MENTION || '').replace(/[\-_\s]/g, '').toLowerCase();
                  const cleanAgentId = (process.env.AGENT_ID || '').replace(/[\-_\s]/g, '').toLowerCase();
                  
                  if (
                    (cleanDisplayName && cleanMention.includes(cleanDisplayName)) ||
                    (cleanAgentMention && cleanMention.includes(cleanAgentMention)) ||
                    (cleanAgentId && cleanMention.includes(cleanAgentId))
                  ) {
                    mentioned = true;
                    // Also auto-resolve and cache the agent's User ID from this annotation!
                    if (ann.userMention?.user?.name && !_agentUserId) {
                      _agentUserId = ann.userMention.user.name;
                      log('Agent user ID auto-resolved from mention annotation', { userId: _agentUserId });
                      try {
                        writeFileSync(`${_stateDir}/agent_user_id.json`, JSON.stringify({ userId: _agentUserId }));
                      } catch {}
                    }
                    break;
                  }
                }
              }
            }
          }
          if (!mentioned && AGENT_MENTION && text.includes(AGENT_MENTION)) mentioned = true;
          // Delegation marker detection: [DELEGATION] and [DELEGATION-RESULT] markers
          // use @email instead of display name. Accept messages containing these markers
          // that are addressed to this agent's email.
          if (!mentioned && AGENT_USER_EMAIL && text.includes(`@${AGENT_USER_EMAIL}`)) {
            if (text.includes('[DELEGATION') || text.includes('[DELEGATION-RESULT')) {
              mentioned = true;
            }
          }
          if (!mentioned && (AGENT_MENTION || _agentUserId)) continue;

          // Build context from prior messages in this page
          const contextStart = Math.max(0, i - CONTEXT_WINDOW);
          const priorMsgs = pageMsgs.slice(contextStart, i);
          const composite = buildContextualMessage(msg, priorMsgs);

          const threadName = msg.thread?.name || null;
          const convoCtx = buildThreadConversation(msg, pageMsgs);

          // SESSION_CONTEXT_PLAN Phase 4: backfill the thread ledger from the
          // poll page — once a turn has been observed, it is never lost to the
          // 25×5 page window again. Fire-and-forget; idempotent upserts.
          backfillThreadLedger(space, threadName, pageMsgs).catch(() => {});

          messages.push({
            text: composite,
            rawText: text,
            id: msg.name,
            timestamp: ct,
            conversation_ctx: convoCtx,
            metadata: {
              space,
              thread: threadName,
              senderEmail: msg.sender?.email || null,
              senderDisplayName: msg.sender?.displayName || null,
              senderUserId: msg.sender?.name || null,
              email: AGENT_USER_EMAIL,
            },
          });
        }

        // Stop paginating if we've drained all new messages
        if (pageMsgs.length === 0 || !pageToken) break;
      } while (pagesPolled < MAX_PAGES_PER_POLL);

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
  const msgSpace = msg.metadata?.space;
  if (msgSpace && (!_gchatCursors[msgSpace] || msg.timestamp > _gchatCursors[msgSpace])) {
    _gchatCursors[msgSpace] = msg.timestamp;
  }
  try { writeFileSync(`${_stateDir}/cursors.json`, JSON.stringify(_gchatCursors)); } catch {}
  try {
    const obj = {};
    for (const [k] of _gchatSeen) obj[k] = true;
    writeFileSync(`${_stateDir}/seen.json`, JSON.stringify(obj));
  } catch {}
}

// ---- Firestore Heartbeat ----
/**
 * Heartbeat the prime's status. UPDATE ONLY — a heartbeat may never create the
 * thing it reports on.
 *
 * A Firestore PATCH with an updateMask UPSERTS. Without a precondition this
 * heartbeat brought a prime into existence whenever PRIME_ID named something
 * that was not a prime, and the surrounding `catch {}` meant nothing ever said
 * so. A live audit found `primes/prime-chucknorris` holding exactly one field,
 * `status: "online"`, where every real prime carries seven to nine — a phantom
 * created by this write from a VM whose PRIME_ID had been set to its VM NAME
 * (`prime-` prefix) rather than its prime id. The dashboard then listed a prime
 * that had never existed, as online.
 *
 * `currentDocument.exists=true` makes the write conditional: a heartbeat for an
 * unknown prime now fails instead of inventing one, and the failure is logged
 * rather than swallowed, because a heartbeat that cannot find its own prime is
 * a misconfiguration worth seeing.
 */
async function updateFirestoreStatus(status) {
  if (CHANNEL !== 'dashboard') return;
  if (!PRIME_ID) { log('WARN: heartbeat skipped — PRIME_ID is unset'); return; }
  try {
    const token = await getGceToken();
    const url = `${FIRESTORE_URL}/primes/${PRIME_ID}`
      + `?updateMask.fieldPaths=status&currentDocument.exists=true`;
    const resp = await fetch(url, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: status } } })
    });
    if (!resp.ok) {
      log(`WARN: prime heartbeat rejected (HTTP ${resp.status}) for prime '${PRIME_ID}'`
        + ' — if this prime is real, its record is missing; if it is not, PRIME_ID is wrong');
    }
  } catch (e) {
    log(`WARN: prime heartbeat failed: ${e.message}`);
  }
}

// ---- Phase 3: Approval gate response detection ----
async function checkApprovalResponse(text) {
  // ---- Approval SCOPING (leakage fix): defer to the brain as the SINGLE resolver ----
  // When approval_scope_enabled, the brain owns approval resolution: it is
  // owner/conversation-scoped and disambiguates. Ears must NOT also auto-resolve
  // the single most-recent PRIME-WIDE pending approval here — that divergent,
  // unscoped path is exactly what let one agent's "approve" flip another agent's
  // gate. Returning false lets the message fall through to normal intake, where
  // the brain's scoped handleApprovalResponse handles it. Env override mirrors
  // agent-brain.mjs so a per-VM canary (AGENT_APPROVAL_SCOPE=on) is consistent
  // across both daemons; flag OFF ⇒ this fast-path behaves exactly as before.
  const _scopeEnabled = process.env.AGENT_APPROVAL_SCOPE
    ? process.env.AGENT_APPROVAL_SCOPE === 'on'
    : (CONTRACTS.dispatch?.approval_scope_enabled === true);
  if (_scopeEnabled) return false;

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
    const token = await getGceToken();
    // Root-collection runQuery is `<database>/documents:runQuery` (collection named
    // in `from`), NOT `.../documents/approvals:runQuery` which 400s. (This path is
    // deferred to the brain when approval_scope_enabled; fixed for correctness.)
    const queryUrl = `${FIRESTORE_URL}:runQuery`;
    const resp = await fetch(queryUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'approvals' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: 'prime_id' },
                    op: 'EQUAL',
                    value: { stringValue: PRIME_ID },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'status' },
                    op: 'EQUAL',
                    value: { stringValue: 'pending' },
                  },
                },
              ],
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

/**
 * Block until the Workspace DWD token resolves, retrying instead of crashing.
 *
 * A brand-new agent's Workspace user may not exist yet — the operator creates it
 * (the `workspace_user` actionRequired). Exiting on that failure crash-loops the
 * service, which trips the bootstrap's contract gate (C-19) and stops the WHOLE
 * agent. Instead we stay up and retry: the moment the Workspace user is created the
 * token resolves and the agent comes online on its own — no redeploy, no manual step.
 */
async function waitForDwd() {
  const RETRY_MS = 30_000;
  let attempt = 0;
  for (;;) {
    try {
      await getDwdToken();
      log(attempt ? 'DWD healthcheck OK — Workspace user now resolves; coming online' : 'DWD healthcheck OK',
        attempt ? { afterAttempts: attempt } : {});
      return;
    } catch (err) {
      attempt++;
      // "Invalid email or User ID" / invalid_grant == the impersonated Workspace user
      // does not exist yet (the expected pending state), vs a genuine DWD misconfig.
      // Either way we retry rather than exit — a crash-loop is never the right response.
      const pendingUser = /invalid email or user id|invalid_grant|not found|does not exist|notfound/i.test(err.message || '');
      log(pendingUser ? 'DWD waiting for Workspace user to be created' : 'DWD healthcheck failing — will retry',
        { email: AGENT_USER_EMAIL, error: err.message, attempt, retry_in_s: RETRY_MS / 1000 });
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
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
    // Wait for the Workspace user rather than crashing if it isn't created yet
    // (graceful recovery — auto-comes-online when the operator provisions it).
    await waitForDwd();
    
    // Load cached agent user ID if available
    try {
      const rawId = readFileSync(`${_stateDir}/agent_user_id.json`, 'utf8');
      const cached = JSON.parse(rawId);
      if (cached && cached.userId) {
        _agentUserId = cached.userId;
        log('Loaded cached agent user ID', { userId: _agentUserId });
      }
    } catch {}

    // Resolve agent user ID for stable echo filtering if not cached
    if (!_agentUserId) {
      try {
        const bootToken = await getDwdToken();
        _agentUserId = await resolveAgentUserId(bootToken);
        if (_agentUserId) {
          log('Agent user ID resolved', { userId: _agentUserId });
          try { writeFileSync(`${_stateDir}/agent_user_id.json`, JSON.stringify({ userId: _agentUserId })); } catch {}
        } else {
          log('Agent user ID resolution returned null (DWD mode fallback)');
        }
      } catch (err) {
        log('Agent user ID resolution failed — falling back to displayName echo filter', { error: err.message });
      }
    }
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
        messages = await pollGChat();
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
          if (CHANNEL === 'gchat') markGChatConsumed(msg);
          else await markFirestoreConsumed(msg);
          continue;
        }

        // Cooldown
        const sender = msg.metadata?.email || 'admin';
        const lastTime = lastSeen.get(sender) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          log('Cooldown — skipping', { sender, text: msg.text.slice(0, 60) });
          if (CHANNEL === 'gchat') markGChatConsumed(msg);
          else await markFirestoreConsumed(msg);
          continue;
        }

        recentMessages.set(dedupKey, now);
        lastSeen.set(sender, now);

        // Mark consumed IMMEDIATELY
        if (CHANNEL === 'gchat') markGChatConsumed(msg);
        else await markFirestoreConsumed(msg);

        const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        log('Received', { text: msg.text.slice(0, 100), taskId });

        // Only preprocess long or noisy messages — short direct mentions pass through
        const needsPreprocess = msg.text && (msg.text.length > 500 || /\n.*\n.*\n/s.test(msg.text));
        const cleanedText = needsPreprocess ? await preprocessMessage(msg.text) : msg.text;
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

        // ---- Delegation ping suppression (C-27 / ME-5 B-2) ----
        // Pickup is owned by the envelope reconciler (reconcileIncomingDelegations
        // reads the durable work T), so a delegation ping — voiced conversational
        // prose + a correlation tag, OR a legacy [DELEGATION ...]/[DELEGATION-RESULT]
        // marker during a mixed-version rollout — is a human COURTESY, not a request.
        // Suppress it here so it never becomes an intake / spurious mission.
        // Detection is fixed regexes (C-4), never an LLM asked "is this a delegation".
        // Use rawText (the original single message), not the context-laden composite.
        const currentMsgText = cleanMentionText(msg.rawText || msg.text || '');
        if (isDelegationPing(currentMsgText) || isDelegationMarker(currentMsgText) || isDelegationResultMarker(currentMsgText)) {
          log('Delegation ping suppressed — envelope reconciler owns pickup', { text: currentMsgText.slice(0, 60) });
          continue;
        }

        // ---- Brain v3: Write intake record to Firestore ----
        // Brain service picks this up, classifies it, creates envelopes,
        // and orchestrates the Cortex loop deterministically.
        const intakeId = `i-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const intakeDoc = {
          id: { stringValue: intakeId },
          text: { stringValue: cleanedText },
          source: { stringValue: CHANNEL },
          ...(msg.conversation_ctx ? { conversation_ctx: { stringValue: JSON.stringify(msg.conversation_ctx) } } : {}),
          source_meta: { mapValue: { fields: {
            taskId: { stringValue: taskId },
            agentEmail: { stringValue: AGENT_USER_EMAIL },
            agentId: { stringValue: AGENT_ID },
            primeId: { stringValue: PRIME_ID },
            ...(msg.metadata?.spaceName ? { spaceName: { stringValue: msg.metadata.spaceName } } : {}),
            ...(msg.metadata?.threadName ? { threadName: { stringValue: msg.metadata.threadName } } : {}),
            ...(msg.metadata?.senderEmail ? { senderEmail: { stringValue: msg.metadata.senderEmail } } : {}),
            // SESSION_CONTEXT_PLAN Phase 4: channel message identity (thread-
            // ledger turn id — replay-safe upserts) and the raw single-message
            // text (the composite carries multi-message framing pollution).
            ...(msg.id ? { channel_msg_id: { stringValue: String(msg.id) } } : {}),
            ...(msg.rawText ? { raw_text: { stringValue: String(msg.rawText).substring(0, 8000) } } : {}),
            address: serializeAddress(makeAddress(
              CHANNEL === 'gchat' ? 'gchat' : 'dashboard',
              CHANNEL === 'gchat'
                ? { space: msg.metadata?.space || null, thread: msg.metadata?.thread || null }
                : { fleet_agent: CHANNEL === 'dashboard' ? null : osHostname().replace(/^fleet-/, '') }
            )),
          } } },
          status: { stringValue: 'pending' },
          created_at: { timestampValue: new Date().toISOString() },
        };

        try {
          const token = await getGceToken();
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
