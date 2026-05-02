#!/usr/bin/env node
// ============================================================
// message-daemon.mjs — Unified channel daemon (Dashboard + GChat)
//
// Single daemon for both Prime (Firestore/Dashboard) and Fleet
// (Google Chat/DWD). Channel determined by CHANNEL env var.
//
// Architecture:
//   - Shared: gateway client, ACK timer, dedup, conversation
//     history, think-block stripping, watchdog, TASK.json
//   - Channel adapters: FirestoreChannel (Prime), GChatChannel (Fleet)
//
// Run (Prime):
//   docker exec -e CHANNEL=dashboard -e GCP_PROJECT_ID=xxx \
//     -e PRIME_ID=xxx openclaw-gateway \
//     node /home/node/.openclaw/bin/message-daemon.mjs
//
// Run (Fleet):
//   docker exec -e CHANNEL=gchat -e GCP_PROJECT_ID=xxx \
//     -e AGENT_USER_EMAIL=xxx -e AGENT_MENTION=xxx \
//     -e DWD_SIGNER_SA=xxx openclaw-gateway \
//     node /home/node/.openclaw/bin/message-daemon.mjs
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_ID = process.env.AGENT_ID || 'agent';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || (CHANNEL === 'gchat' ? '10' : '5'), 10) * 1000;
const GATEWAY_URL = 'http://127.0.0.1:18789/v1/chat/completions';
const HTTP_TIMEOUT = 600_000;
const MAX_HISTORY = 4;
const ACK_TIMEOUT = 15_000;

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
const conversationHistory = [];
const recentMessages = new Map();
const DEDUP_WINDOW = 60_000;
let activeWatchdogTaskId = null;
let lastLogOffset = 0;

// ---- Logging ----
function log(msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'message-daemon', ch: CHANNEL, msg, ...meta }));
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
// Port of dwd-token bash script to Node.js.
// Uses IAM signJwt API (no key files needed).
let _dwdToken = null;
let _dwdExpiry = 0;
const DWD_SCOPES = 'https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly';

async function getDwdToken() {
  if (_dwdToken && Date.now() < _dwdExpiry) return _dwdToken;

  // Step 1: Get VM SA email + metadata token
  const metaBase = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
  const mh = { 'Metadata-Flavor': 'Google' };
  const vmSaEmail = await fetch(`${metaBase}/email`, { headers: mh }).then(r => r.text());
  const metaTokenData = await fetch(`${metaBase}/token`, { headers: mh }).then(r => r.json());
  const metaToken = metaTokenData.access_token;

  // Step 2: Build JWT claim
  const signerSa = DWD_SIGNER_SA || vmSaEmail;
  const now = Math.floor(Date.now() / 1000);
  const claim = JSON.stringify({
    iss: signerSa,
    sub: AGENT_USER_EMAIL,
    scope: DWD_SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });

  // Step 3: Sign JWT via IAM signJwt API
  const signUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${signerSa}:signJwt`;
  const signRes = await fetch(signUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: claim })
  });
  if (!signRes.ok) {
    const err = await signRes.text();
    throw new Error(`signJwt failed (${signRes.status}): ${err.slice(0, 200)}`);
  }
  const { signedJwt } = await signRes.json();

  // Step 4: Exchange signed JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`DWD token exchange failed: ${tokenData.error_description || tokenData.error}`);
  }

  _dwdToken = tokenData.access_token;
  _dwdExpiry = Date.now() + 3500_000; // ~58 min
  return _dwdToken;
}

// ---- Gateway Call (non-streaming) ----
async function callGateway(messages, t0) {
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
      return { error: `⚠ Gateway error (HTTP ${res.status})` };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log('Gateway response', { elapsed_s: parseFloat(elapsed), chars: content.length, tokens: data.usage?.total_tokens });
    return { content };
  } catch (err) {
    clearTimeout(hardTimeout);
    if (err.name === 'AbortError') return { error: `⚠ Response timed out (${HTTP_TIMEOUT / 1000}s).` };
    log('Gateway error', { error: err.message });
    return { error: `⚠ Gateway error: ${err.message}` };
  }
}

// ---- Think-Block Stripping ----
function stripThinking(text) {
  if (!text) return text;
  if (text.includes('<think>') && text.includes('</think>')) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  if (text.startsWith('think\n') || text.startsWith('think\r\n')) {
    const lines = text.split('\n');
    let lastThinkLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l === '' || l === 'think' || /^Thinking/i.test(l) ||
          /^\d+\.\s/.test(l) || /^\*\s/.test(l) || /^\*\*/.test(l)) {
        lastThinkLine = i;
      }
    }
    const response = lines.slice(lastThinkLine + 1).join('\n').trim();
    if (response.length > 0) return response;
  }
  return text;
}

function extractSynthesisFromThinking(entries) {
  for (const entry of entries) {
    let content = entry || '';
    if (content.startsWith('think\n')) content = content.slice(6);
    const lines = content.split('\n');
    let responseStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^Here (is|are|'s) (the |a |my )?/i.test(line) && !line.includes('execute') && !line.includes('`exec')) {
        responseStart = i;
        break;
      }
    }
    if (responseStart >= 0) {
      const responseLines = [];
      for (let i = responseStart; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^Let'?s (run|execute|format|compose|send|deliver)/i.test(trimmed)) break;
        if (/^I (will|should|need to|must) (now |)(run|execute|call|deliver|send)/i.test(trimmed)) break;
        if (/^Wait,/i.test(trimmed)) break;
        if (/^Since I/i.test(trimmed) && trimmed.includes('channel-respond')) break;
        if (trimmed.startsWith('```') && trimmed.includes('channel-respond')) break;
        responseLines.push(lines[i]);
      }
      const response = responseLines.join('\n').trim();
      if (response.length > 30) return response;
    }
  }
  return null;
}

// ---- Route Message ----
async function routeMessage(text) {
  const t0 = Date.now();
  conversationHistory.push({ role: 'user', content: text });
  while (conversationHistory.length > MAX_HISTORY * 2) conversationHistory.shift();
  const result = await callGateway([...conversationHistory], t0);
  if (result.error) {
    conversationHistory.pop();
    return { reply: result.error, mode: 'error' };
  }
  const rawContent = result.content?.trim() || '';
  const content = stripThinking(rawContent);
  const isNoReply = !content || content.length === 0 ||
    content.toLowerCase().includes('no reply') ||
    content.toLowerCase().includes('no response');
  if (!isNoReply && content.length > 0) {
    conversationHistory.push({ role: 'assistant', content });
    return { reply: content, mode: 'complete' };
  }
  log('Yield detected — agent will deliver via channel-respond');
  return { reply: '', mode: 'dispatched-async' };
}

// ---- Watchdog ----
async function watchdogCheck(channel, taskId, dispatchedAt) {
  const WATCHDOG_INTERVAL = 10_000;
  const WATCHDOG_MAX = 180_000;
  const start = Date.now();
  log('Watchdog started', { taskId, timeout_s: WATCHDOG_MAX / 1000 });
  const logStartOffset = lastLogOffset;
  try {
    while (Date.now() - start < WATCHDOG_MAX) {
      await new Promise(r => setTimeout(r, WATCHDOG_INTERVAL));

      // Path 0: TASK.json status check (fastest — channel-respond writes status: complete)
      try {
        if (existsSync(TASK_JSON_PATH)) {
          const taskData = JSON.parse(readFileSync(TASK_JSON_PATH, 'utf8'));
          if (taskData.status === 'complete') {
            log('Watchdog: TASK.json shows complete — delivery confirmed', { taskId });
            return;
          }
        }
      } catch {}

      // Path 1: Firestore check (Prime only)
      if (CHANNEL === 'dashboard' && FIRESTORE_URL && PRIME_ID) {
        try {
          const token = await getAccessToken();
          const body = { structuredQuery: { from: [{ collectionId: 'messages' }],
            where: { compositeFilter: { op: 'AND', filters: [
              { fieldFilter: { field: { fieldPath: 'sender' }, op: 'EQUAL', value: { stringValue: 'prime' } } },
              { fieldFilter: { field: { fieldPath: 'timestamp' }, op: 'GREATER_THAN', value: { timestampValue: dispatchedAt } } }
            ] } }, orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }], limit: 1 } };
          const res = await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}:runQuery`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const data = await res.json();
          if (Array.isArray(data) && data.some(d => d.document?.fields?.sender?.stringValue === 'prime')) {
            log('Watchdog: agent delivered via channel-respond', { taskId });
            return;
          }
        } catch (err) { log('Watchdog Firestore poll error', { error: err.message }); }
      }

      // Path 2: Log file parse (both channels)
      try {
        const today = new Date().toISOString().split('T')[0];
        const logPath = `/tmp/openclaw/openclaw-${today}.log`;
        const logContent = readFileSync(logPath, 'utf8');
        const newContent = logContent.slice(logStartOffset);
        const lines = newContent.split('\n').filter(l => l.trim());
        let synthesisEntries = [];
        let foundAnnounce = false;
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const allText = Object.keys(entry).filter(k => k !== '_meta' && typeof entry[k] === 'string').map(k => entry[k]).join(' ');
            if (allText.includes('announce:v1:agent:')) { foundAnnounce = true; synthesisEntries = []; continue; }
            const text = entry['0'] || '';
            if (foundAnnounce && text.length > 50) synthesisEntries.push(text);
          } catch {}
        }
        if (synthesisEntries.length > 0) {
          const synthesis = extractSynthesisFromThinking(synthesisEntries);
          if (synthesis && synthesis.length > 30) {
            lastLogOffset = logContent.length;
            log('Watchdog: synthesis captured from log file', { taskId, chars: synthesis.length });
            await channel.send(synthesis);
            conversationHistory.push({ role: 'assistant', content: synthesis });
            return;
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') log('Watchdog log parse error', { error: err.message });
      }
      log('Watchdog: no delivery yet', { taskId, elapsed_s: ((Date.now() - start) / 1000).toFixed(1) });
    }
    log('Watchdog timeout', { taskId });
    await channel.send('⚠ I dispatched a sub-agent but wasn\'t able to deliver the result. Please try again.');
  } finally {
    activeWatchdogTaskId = null;
  }
}

// ---- Status Check ----
const WORKSPACE_DIR = '/home/node/.openclaw/workspace';
const TASK_JSON_PATH = `${WORKSPACE_DIR}/TASK.json`;
const STATUS_JSON_PATH = `${WORKSPACE_DIR}/STATUS.json`;

function timeSince(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function readAgentStatus() {
  try {
    if (!existsSync(STATUS_JSON_PATH)) return null;
    return JSON.parse(readFileSync(STATUS_JSON_PATH, 'utf8'));
  } catch { return null; }
}

function getBusyMessage() {
  const s = readAgentStatus();
  if (!s || !s.state || s.state === 'idle' || s.state === 'classifying') return null;
  const since = s.since ? timeSince(s.since) : 'unknown';
  return `🔄 Currently: ${s.state}${s.detail ? ` (${s.detail})` : ''}\n   Task: ${s.task || 'working'}\n   Since: ${since} ago\n\nYour message has been queued and will be processed next.`;
}

// ================================================================
// CHANNEL ADAPTERS
// ================================================================

// ---- FirestoreChannel (Prime/Dashboard) ----
class FirestoreChannel {
  constructor() { this._heartbeat = null; }

  async poll() {
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

  async markConsumed(msg) {
    const token = await getAccessToken();
    await fetch(`https://firestore.googleapis.com/v1/${msg.id}?updateMask.fieldPaths=processed`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { processed: { booleanValue: true } } })
    });
  }

  async send(text) {
    const token = await getAccessToken();
    await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        text: { stringValue: text }, sender: { stringValue: 'prime' },
        timestamp: { timestampValue: new Date().toISOString() }, processed: { booleanValue: true }
      } })
    });
  }

  async sendAck() { await this.send('🔄 Processing your request...'); }

  writeTaskFile(taskId) {
    try {
      writeFileSync(TASK_JSON_PATH, JSON.stringify({
        taskId, channel: 'dashboard',
        channelMeta: { primeId: PRIME_ID, projectId: GCP_PROJECT },
        status: 'executing', heartbeat: new Date().toISOString(), receivedAt: new Date().toISOString()
      }));
    } catch {}
  }

  async writeTask(taskId, fields) {
    try {
      const token = await getAccessToken();
      const firestoreFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string') firestoreFields[k] = { stringValue: v };
        else if (typeof v === 'number') firestoreFields[k] = { integerValue: String(v) };
        else if (typeof v === 'boolean') firestoreFields[k] = { booleanValue: v };
      }
      await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/tasks?documentId=${taskId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: firestoreFields })
      }).catch(() => {
        const paths = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
        return fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}/tasks/${taskId}?${paths}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: firestoreFields })
        });
      });
    } catch {}
  }

  async updateStatus(status) {
    try {
      const token = await getAccessToken();
      await fetch(`${FIRESTORE_URL}/primes/${PRIME_ID}?updateMask.fieldPaths=status`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { status: { stringValue: status } } })
      });
    } catch {}
  }

  async startHeartbeat() {
    await this.updateStatus('online');
    this._heartbeat = setInterval(() => this.updateStatus('online').catch(() => {}), 60_000);
  }

  async shutdown() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    await this.updateStatus('offline').catch(() => {});
  }
}

// ---- GChat Markdown Conversion ----
// Google Chat plain text supports: *bold*, _italic_, ~strike~, `code`, ```blocks```
// It does NOT support: # headers, - bullets, > blockquotes, [links](url), tables
// This function converts standard markdown → GChat-compatible plain text.
// For richer formatting, GChat Cards v2 API exists (future enhancement).
function convertToGChatMarkdown(text) {
  if (!text) return text;

  // Split on code blocks/inline code to avoid converting inside them
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return parts.map((part, i) => {
    // Odd indices are code blocks/inline code — leave untouched
    if (i % 2 === 1) return part;

    let c = part;

    // Headers → bold text (### Header → *Header*)
    // Process multi-hash first (### before ## before #)
    c = c.replace(/^####\s+(.+)$/gm, '▸ *$1*');
    c = c.replace(/^###\s+(.+)$/gm, '▸ *$1*');
    c = c.replace(/^##\s+(.+)$/gm, '═ *$1*');
    c = c.replace(/^#\s+(.+)$/gm, '◆ *$1*');

    // Convert **bold** → *bold* (GChat bold)
    c = c.replace(/\*\*([^*]+?)\*\*/g, '*$1*');

    // Convert __text__ → _text_ (normalize to GChat italic)
    c = c.replace(/__([^_]+?)__/g, '_$1_');

    // Horizontal rules (---, ***, ___) → visual separator
    c = c.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, '─────────────────────');

    // Blockquotes (> text → ▎text)
    c = c.replace(/^>\s?(.*)$/gm, '▎ $1');

    // Markdown links [text](url) → text (url)
    c = c.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    return c;
  }).join('');
}

// ---- GChatChannel (Fleet/Google Chat) ----
class GChatChannel {
  constructor() {
    this._highWater = '1970-01-01T00:00:00.000000Z';
    this._seen = new Map();
    this._spaces = [];
    this._lastDiscovery = 0;
    this._stateDir = '/tmp/message-daemon-state';
    try { mkdirSync(this._stateDir, { recursive: true }); } catch {}
    // Load persisted state
    try { this._highWater = readFileSync(`${this._stateDir}/highwater`, 'utf8').trim(); } catch {}
    try { const s = JSON.parse(readFileSync(`${this._stateDir}/seen.json`, 'utf8')); for (const k of Object.keys(s)) this._seen.set(k, true); } catch {}
  }

  async _discoverSpaces() {
    if (Date.now() - this._lastDiscovery < 300_000 && this._spaces.length > 0) return;
    try {
      const token = await getDwdToken();
      const res = await fetch(`${CHAT_API}/spaces?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      this._spaces = (data.spaces || []).map(s => s.name).filter(Boolean);
      this._lastDiscovery = Date.now();
      log('Discovered spaces', { count: this._spaces.length });
    } catch (err) { log('Space discovery error', { error: err.message }); }
  }

  async poll() {
    await this._discoverSpaces();
    if (this._spaces.length === 0) return [];
    const token = await getDwdToken();
    const messages = [];
    for (const space of this._spaces) {
      try {
        const res = await fetch(`${CHAT_API}/${space}/messages?pageSize=10&orderBy=createTime%20desc`,
          { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        for (const msg of (data.messages || []).reverse()) {
          const ct = msg.createTime || '';
          if (ct <= this._highWater) continue;
          if (this._seen.has(msg.name)) continue;
          const text = msg.text || msg.argumentText || '';
          if (!text || (AGENT_MENTION && !text.includes(AGENT_MENTION))) continue;
          // Clean @-mention
          let clean = text;
          if (AGENT_MENTION) clean = text.replace(new RegExp(`@?${AGENT_MENTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '').trim().replace(/\s+/g, ' ');
          if (!clean) clean = text;
          messages.push({ text: clean, id: msg.name, timestamp: ct, metadata: { space, email: AGENT_USER_EMAIL } });
        }
      } catch (err) { log('Chat poll error', { space, error: err.message }); }
    }
    return messages;
  }

  async markConsumed(msg) {
    this._seen.set(msg.id, true);
    // Prune seen to last 200
    if (this._seen.size > 200) {
      const keys = [...this._seen.keys()];
      for (let i = 0; i < keys.length - 200; i++) this._seen.delete(keys[i]);
    }
    if (msg.timestamp > this._highWater) this._highWater = msg.timestamp;
    // Persist
    try { writeFileSync(`${this._stateDir}/highwater`, this._highWater); } catch {}
    try {
      const obj = {};
      for (const [k] of this._seen) obj[k] = true;
      writeFileSync(`${this._stateDir}/seen.json`, JSON.stringify(obj));
    } catch {}
  }

  async send(text, metadata) {
    const token = await getDwdToken();
    const space = metadata?.space || this._spaces[0];
    if (!space) { log('No space to send to'); return; }
    const formatted = convertToGChatMarkdown(text);
    const res = await fetch(`${CHAT_API}/${space}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: formatted })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      log('Chat send error', { status: res.status, body: err.slice(0, 200) });
    }
  }

  async sendAck(metadata) { await this.send('🔄 Processing your request...', metadata); }

  writeTaskFile(taskId, metadata) {
    try {
      writeFileSync(TASK_JSON_PATH, JSON.stringify({
        taskId, channel: 'gchat',
        channelMeta: { spaceId: metadata?.space || '', agentEmail: AGENT_USER_EMAIL },
        status: 'executing', heartbeat: new Date().toISOString(), receivedAt: new Date().toISOString()
      }));
    } catch {}
  }

  async writeTask() {} // No Firestore task tracking for fleet
  async updateStatus() {} // No Firestore status for fleet
  async startHeartbeat() {} // No heartbeat for fleet
  async shutdown() {}
}

// ================================================================
// MAIN LOOP
// ================================================================
async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }
  if (CHANNEL === 'dashboard' && !PRIME_ID) { console.error('PRIME_ID required for dashboard channel'); process.exit(1); }
  if (CHANNEL === 'gchat' && !AGENT_USER_EMAIL) { console.error('AGENT_USER_EMAIL required for gchat channel'); process.exit(1); }

  const channel = CHANNEL === 'gchat' ? new GChatChannel() : new FirestoreChannel();

  log('Starting', {
    channel: CHANNEL, agent: AGENT_ID, project: GCP_PROJECT,
    poll_interval_s: POLL_INTERVAL / 1000, token: GATEWAY_TOKEN.slice(0, 8) + '...',
    ...(CHANNEL === 'gchat' ? { email: AGENT_USER_EMAIL, mention: AGENT_MENTION } : { primeId: PRIME_ID })
  });

  // Health checks
  if (CHANNEL === 'gchat') {
    try { await getDwdToken(); log('DWD healthcheck OK'); } catch (err) { log('DWD healthcheck FAILED', { error: err.message }); process.exit(1); }
  }

  await channel.startHeartbeat();
  log('Status: ONLINE');

  // Graceful shutdown
  const shutdown = async () => { log('Shutting down...'); await channel.shutdown(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  log('Entering polling loop...');
  let _lastSpaceLog = 0;

  while (true) {
    try {
      const messages = await channel.poll();

      // Expire stale dedup entries
      const now = Date.now();
      for (const [key, ts] of recentMessages) {
        if (now - ts > DEDUP_WINDOW) recentMessages.delete(key);
      }

      if (CHANNEL === 'gchat' && messages.length === 0 && channel._spaces?.length === 0) {
        if (now - _lastSpaceLog > 300_000) { log('No spaces — waiting to be added to a Chat space'); _lastSpaceLog = now; }
      }

      for (const msg of messages) {
        const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const t0 = Date.now();

        // Dedup
        const dedupKey = msg.text.trim().toLowerCase();
        if (recentMessages.has(dedupKey)) {
          log('Dedup — skipping', { text: msg.text.slice(0, 60) });
          await channel.markConsumed(msg);
          continue;
        }
        recentMessages.set(dedupKey, Date.now());

        // Mark consumed IMMEDIATELY (prevent re-pickup)
        await channel.markConsumed(msg);
        log('Received', { text: msg.text.slice(0, 100), taskId });

        // Busy check
        const busyMsg = getBusyMessage();
        if (busyMsg) {
          log('Agent busy', { taskId });
          await channel.send(busyMsg, msg.metadata);
          continue;
        }

        // Task tracking
        channel.writeTaskFile(taskId, msg.metadata);
        if (channel.writeTask) await channel.writeTask(taskId, { userMessage: msg.text.slice(0, 500), status: 'submitted', receivedAt: new Date().toISOString() }).catch(() => {});

        // ACK timer + gateway call
        let ackSent = false;
        const ackTimer = setTimeout(async () => {
          ackSent = true;
          log('ACK timeout — sending processing notice', { taskId });
          await channel.sendAck(msg.metadata);
          if (channel.writeTask) channel.writeTask(taskId, { status: 'processing' }).catch(() => {});
        }, ACK_TIMEOUT);

        const result = await routeMessage(msg.text);
        clearTimeout(ackTimer);
        const elapsed = Date.now() - t0;

        if (result.mode === 'complete') {
          log('Reply', { text: result.reply.split('\n')[0].slice(0, 80), taskId, ackSent });
          await channel.send(result.reply, msg.metadata);
          if (channel.writeTask) channel.writeTask(taskId, { status: 'complete', completedAt: new Date().toISOString(), totalMs: elapsed }).catch(() => {});

        } else if (result.mode === 'dispatched-async') {
          if (!ackSent) { await channel.sendAck(msg.metadata); }
          if (channel.writeTask) channel.writeTask(taskId, { status: 'dispatched-async' }).catch(() => {});
          log('Dispatched async — watchdog starting', { taskId });
          if (activeWatchdogTaskId) {
            log('Watchdog already active, skipping', { existing: activeWatchdogTaskId });
          } else {
            activeWatchdogTaskId = taskId;
            watchdogCheck(channel, taskId, new Date().toISOString()).catch(err => {
              log('Watchdog error', { taskId, error: err.message });
              activeWatchdogTaskId = null;
            });
          }

        } else if (result.mode === 'error') {
          await channel.send(result.reply || '⚠ Unable to process. Please try again.', msg.metadata);
          log('Error', { taskId, elapsed_ms: elapsed });
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
