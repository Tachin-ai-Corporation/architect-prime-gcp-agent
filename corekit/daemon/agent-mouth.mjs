#!/usr/bin/env node
// ============================================================
// agent-mouth.mjs — Output Classification and Delivery Service
//
// 1 LLM call (classify + format) per output, everything else
// deterministic. Polls gateway logs for new Cortex output,
// classifies it, and delivers to the appropriate channel.
//
// Run:
//   CHANNEL=gchat node agent-mouth.mjs
//   CHANNEL=dashboard node agent-mouth.mjs
// ============================================================
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

// ---- Config ----
const CHANNEL = process.env.CHANNEL || 'dashboard';
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_USER_EMAIL = process.env.AGENT_USER_EMAIL || '';
const DWD_SIGNER_SA = process.env.DWD_SIGNER_SA || '';
const CHAT_API = 'https://chat.googleapis.com/v1';
const POLL_INTERVAL = 2000; // 2s

// Mouth config from contracts
let MOUTH_CONFIG = { llm_enabled: true, model: 'gemini-2.5-flash', maxTokens: 2000, temperature: 0.1, fallback: 'deliver_raw' };
try {
  const contracts = JSON.parse(readFileSync('/home/node/.openclaw/corekit/contracts.json', 'utf8'));
  if (contracts.mouth) MOUTH_CONFIG = { ...MOUTH_CONFIG, ...contracts.mouth };
} catch {}

const VERTEX_PROJECT = process.env.GCP_PROJECT_ID;
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'global';

// Firestore URL
const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

// Load mouth system prompt
let MOUTH_PROMPT = '';
try { MOUTH_PROMPT = readFileSync('/home/node/.openclaw/bin/mouth-prompt.md', 'utf8'); } catch {
  try { MOUTH_PROMPT = readFileSync('/opt/openclaw/.openclaw/bin/mouth-prompt.md', 'utf8'); } catch {}
}

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
// OUTPUT POLLING — Gateway Log File
// ================================================================

let lastLogOffset = 0;

function getLatestGatewayOutput() {
  // Read gateway log file and find new assistant output since last check
  const today = new Date().toISOString().split('T')[0];
  const logPath = `/tmp/openclaw/openclaw-${today}.log`;
  if (!existsSync(logPath)) return null;

  const logContent = readFileSync(logPath, 'utf8');
  if (logContent.length <= lastLogOffset) return null;

  const newContent = logContent.slice(lastLogOffset);
  lastLogOffset = logContent.length;

  // Parse log entries looking for assistant output after subagent announce
  const lines = newContent.split('\n').filter(l => l.trim());
  let foundAnnounce = false;
  let synthesisEntries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const allText = Object.keys(entry)
        .filter(k => k !== '_meta' && typeof entry[k] === 'string')
        .map(k => entry[k]).join(' ');

      // Check for sub-agent announce completion
      if (allText.includes('announce:v1:agent:')) {
        foundAnnounce = true;
        synthesisEntries = [];
        continue;
      }

      // Capture synthesis text (text after announce, length > 50)
      const text = entry['0'] || '';
      if (foundAnnounce && text.length > 50) {
        synthesisEntries.push(text);
      }
    } catch {}
  }

  // Also check for direct responses (no announce — identity/short-circuit)
  if (!foundAnnounce && synthesisEntries.length === 0) {
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const text = entry['0'] || '';
        // Look for substantial text that looks like an agent response
        if (text.length > 30 && !text.includes('[ws]') && !text.includes('gateway') &&
            !text.includes('"subsystem"') && !text.startsWith('{')) {
          synthesisEntries.push(text);
        }
      } catch {}
    }
  }

  if (synthesisEntries.length === 0) return null;

  // Extract the actual response from thinking blocks
  const raw = synthesisEntries.join('\n');
  return stripThinking(raw);
}

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

// ================================================================
// LLM CLASSIFICATION (the ONE LLM call in the Mouth)
// ================================================================

async function classifyAndFormat(rawText) {
  if (!MOUTH_CONFIG.llm_enabled || !MOUTH_PROMPT) {
    // Debug mode or no prompt — deliver raw
    return { action: 'deliver', formatted_text: rawText };
  }

  try {
    const token = await getAccessToken();
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/publishers/google/models/${MOUTH_CONFIG.model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: MOUTH_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ raw_output: rawText, channel: CHANNEL }) }] }],
        generationConfig: {
          temperature: MOUTH_CONFIG.temperature,
          maxOutputTokens: MOUTH_CONFIG.maxTokens,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!res.ok) {
      log('Mouth LLM HTTP error', { status: res.status });
      return { action: 'deliver', formatted_text: rawText }; // Fallback: deliver raw
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(text);
  } catch (err) {
    log('Mouth LLM error — delivering raw', { error: err.message });
    return { action: 'deliver', formatted_text: rawText }; // NEVER drop a message
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

// ---- Deterministic: @-mention extraction ----
function extractMentions(text) {
  const mentions = [];
  const pattern = /@([\w-]+(?:@[\w.-]+)?)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

// ---- Deterministic: Escalation detection ----
function hasEscalateMarker(text) {
  return /\[ESCALATE\]/i.test(text);
}

// ---- Write escalation to Firestore ----
async function writeEscalationFlag(reason) {
  if (!FIRESTORE_URL) return;
  try {
    const token = await getAccessToken();
    const docId = `escalation-${Date.now()}`;
    await fetch(`${FIRESTORE_URL}/escalations?documentId=${docId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        reason: { stringValue: reason },
        channel: { stringValue: CHANNEL },
        timestamp: { timestampValue: new Date().toISOString() },
        acknowledged: { booleanValue: false }
      } })
    });
  } catch (err) { log('Escalation write error', { error: err.message }); }
}

// ================================================================
// MAIN LOOP
// ================================================================

async function main() {
  if (!GCP_PROJECT) { console.error('GCP_PROJECT_ID required'); process.exit(1); }

  log('Starting', {
    channel: CHANNEL, llm_enabled: MOUTH_CONFIG.llm_enabled,
    model: MOUTH_CONFIG.model, poll_interval_ms: POLL_INTERVAL
  });

  // Graceful shutdown
  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });

  log('Entering polling loop...');

  while (true) {
    try {
      const rawOutput = getLatestGatewayOutput();
      if (rawOutput && rawOutput.length > 10) {
        log('Output detected', { chars: rawOutput.length });

        // ── DETERMINISTIC PRE-PROCESSING ──
        const mentions = extractMentions(rawOutput);
        const escalate = hasEscalateMarker(rawOutput);
        const isAllInternal = /^\s*\[INTERNAL\]/.test(rawOutput);

        let action, formattedText, escalationReason;

        if (isAllInternal) {
          // Entire output tagged internal → suppress
          action = 'suppress';
          formattedText = '';
          log('Classified: suppress (all internal)');
        } else if (!MOUTH_CONFIG.llm_enabled) {
          // Debug mode: deliver raw
          action = escalate ? 'escalate' : 'deliver';
          formattedText = rawOutput;
          escalationReason = escalate ? 'Explicit [ESCALATE] marker' : undefined;
          log('Classified: deliver_raw (LLM disabled)');
        } else {
          // ── LLM CALL: classify + format ──
          const classification = await classifyAndFormat(rawOutput);
          action = classification.action || 'deliver';
          formattedText = classification.formatted_text || rawOutput;
          escalationReason = classification.escalation_reason;

          // Deterministic override: explicit markers always win
          if (escalate && action !== 'escalate') action = 'escalate';

          log('Classified', { action, llmUsed: true });
        }

        // ── DETERMINISTIC DELIVERY ──
        switch (action) {
          case 'deliver':
            await deliver(formattedText);
            log('Delivered', { channel: CHANNEL, chars: formattedText.length });
            break;
          case 'escalate':
            await deliver(formattedText);
            await writeEscalationFlag(escalationReason || 'Agent escalation');
            log('Delivered + escalated', { reason: escalationReason });
            break;
          case 'suppress':
            log('Suppressed', { reason: 'internal_thinking' });
            break;
          default:
            // Unknown action — deliver raw (NEVER drop)
            await deliver(rawOutput);
            log('Delivered (unknown action fallback)', { action });
        }

        // ── DETERMINISTIC @-MENTION ROUTING ──
        for (const mention of mentions) {
          log('Routing @mention', { mention });
          // Future: route to agent via DWD send
        }

        // Touch health check
        try { writeFileSync('/var/run/agent-mouth-last-delivery', String(Date.now())); } catch {}
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
