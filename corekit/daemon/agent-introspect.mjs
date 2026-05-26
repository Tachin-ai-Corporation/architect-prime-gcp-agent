#!/usr/bin/env node
// agent-introspect.mjs — Agent Introspection Service
// Polls Firestore for introspection queries, reads local filesystem, writes results.
// Runs alongside ears/mouth/brain.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { hostname } from 'os';
import { execSync } from 'child_process';

// ---- Config ----
const GCP_PROJECT = process.env.GCP_PROJECT_ID;
const PRIME_ID = process.env.PRIME_ID || '';
const AGENT_HOSTNAME = hostname().replace(/^fleet-/, '');
const POLL_MS = 5000;

const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

const OC_HOME = '/home/node/.openclaw';
const BIN_DIR = `${OC_HOME}/bin`;
const SKILLS_DIR = `${OC_HOME}/skills`;
const COREKIT_DIR = `${OC_HOME}/corekit`;
const LOG_FILE = '/var/log/agent-introspect.log';

// ---- Logging ----
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'agent-introspect', msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ---- GCE Token ----
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

// ---- Firestore helpers ----
async function pollForQueries() {
  if (!FIRESTORE_URL || !PRIME_ID || !AGENT_HOSTNAME) return [];
  const token = await getAccessToken();
  const parentPath = `primes/${PRIME_ID}/fleet/${AGENT_HOSTNAME}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'introspect' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'pending' },
        },
      },
      limit: 10,
    },
  };
  const res = await fetch(`${FIRESTORE_URL}/${parentPath}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const docs = await res.json();
  return docs
    .filter(d => d.document)
    .map(d => {
      // Decode params mapValue if present
      const paramsFields = d.document.fields?.params?.mapValue?.fields || {};
      const params = {};
      for (const [k, v] of Object.entries(paramsFields)) {
        if (v.stringValue !== undefined) params[k] = v.stringValue;
        else if (v.mapValue) {
          // Decode nested map (e.g., overrides)
          const nested = {};
          for (const [nk, nv] of Object.entries(v.mapValue.fields || {})) {
            if (nv.stringValue !== undefined) nested[nk] = nv.stringValue;
          }
          params[k] = nested;
        }
      }
      return {
        path: d.document.name,
        type: d.document.fields?.type?.stringValue || 'unknown',
        params,
      };
    });
}

async function writeResult(docPath, result) {
  const token = await getAccessToken();
  // Extract relative path from full resource name
  const relPath = docPath.includes('/documents/') ? docPath.split('/documents/')[1] : docPath;
  const url = `${FIRESTORE_URL}/${relPath}?updateMask.fieldPaths=status&updateMask.fieldPaths=result&updateMask.fieldPaths=completedAt`;
  await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        status: { stringValue: 'complete' },
        completedAt: { timestampValue: new Date().toISOString() },
        result: { mapValue: { fields: encodeMap(result) } },
      },
    }),
  });
}

async function writeError(docPath, error) {
  const token = await getAccessToken();
  const relPath = docPath.includes('/documents/') ? docPath.split('/documents/')[1] : docPath;
  const url = `${FIRESTORE_URL}/${relPath}?updateMask.fieldPaths=status&updateMask.fieldPaths=error&updateMask.fieldPaths=completedAt`;
  await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        status: { stringValue: 'error' },
        completedAt: { timestampValue: new Date().toISOString() },
        error: { stringValue: String(error) },
      },
    }),
  });
}

// ---- Firestore value encoding ----
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeMap(v) } };
  return { stringValue: String(v) };
}

function encodeMap(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = encodeValue(v);
  }
  return fields;
}

// ---- Introspection handlers ----

function handleSkills() {
  const tools = [];

  // Scan bin directory for installed scripts
  if (existsSync(BIN_DIR)) {
    const files = readdirSync(BIN_DIR);
    for (const f of files) {
      const fullPath = join(BIN_DIR, f);
      try {
        const st = statSync(fullPath);
        if (!st.isFile()) continue;

        // Read first 5 lines for description comment
        let description = '';
        let category = 'custom';
        try {
          const head = readFileSync(fullPath, 'utf8').split('\n').slice(0, 10);
          for (const line of head) {
            const commentMatch = line.match(/^#\s*(.+)/) || line.match(/^\/\/\s*(.+)/);
            if (commentMatch && !commentMatch[1].startsWith('!') && !commentMatch[1].startsWith('=')) {
              const text = commentMatch[1].trim();
              // Skip shebang-like and header lines
              if (text.startsWith('/') || text.startsWith('infra/') || text.startsWith('corekit/')) continue;
              if (!description) description = text;
            }
          }
        } catch {}

        // ---- Body-Part Category Reference ----
        // When adding new tools, assign them to the correct body part:
        //
        //  ears    - Input pipeline: polling, preprocessing, DWD auth, chat I/O
        //            Matches: agent-ears*, start-agent-ears, ears-*, chat-*, dwd-token, ws-token
        //
        //  mouth   - Output pipeline: response classification, delivery, status updates
        //            Matches: agent-mouth*, start-agent-mouth, mouth-*
        //
        //  brain   - Orchestration: envelope daemon, telemetry, tool assembly, introspect
        //            Matches: agent-brain*, start-agent-brain, brain-telemetry-*, assemble-tools,
        //                     agent-introspect*, start-agent-introspect
        //
        //  cortex  - Decision layer: the agent's main reasoning tools
        //            Matches: agent-ask, agent-status
        //
        //  motor   - Execution layer: all tools Motor sub-agent uses to DO things
        //            Matches: responsibility-manage, project-manage, task-log-*,
        //                     fleet-*, command-runner, discover-models,
        //                     drive-*, gmail-*, calendar-*, docs-*, sheets-*
        //
        //  memory  - Temporal-memory: long-term memory read/write/retire, deep truths
        //            Matches: core-memory-*, update-deep-truths, session-summary
        //
        //  config  - System config & base functions: OpenClaw/fleet infra tools
        //            Matches: upgrade-*, validate-contracts, render-config, oc, agent-ou-manage,
        //                     *.md, *.json, *.tmpl, *.sh, bootstrap_smoke.sh
        //
        //  custom  - Fallback for uncategorized tools (anything not matched above)
        //
        // Categorize by agent body part
        if (f.startsWith('agent-ears') || f.startsWith('start-agent-ears') || f.startsWith('ears-') || f === 'ears-health-check') category = 'ears';
        else if (f.startsWith('agent-mouth') || f.startsWith('start-agent-mouth') || f.startsWith('mouth-') || f === 'mouth-health-check') category = 'mouth';
        else if (f === 'agent-brain.mjs' || f === 'start-agent-brain' || f === 'assemble-tools' || f === 'brain-telemetry-write' || f === 'brain-telemetry-read') category = 'brain';
        else if (f === 'agent-introspect.mjs' || f === 'start-agent-introspect') category = 'brain';
        else if (f === 'responsibility-manage' || f === 'project-manage' || f === 'task-log-write' || f === 'task-log-read') category = 'motor';
        else if (f.startsWith('fleet-') || f === 'command-runner' || f === 'discover-models') category = 'motor';
        else if (f.startsWith('drive-') || f.startsWith('gmail-') || f.startsWith('calendar-') || f.startsWith('docs-') || f.startsWith('sheets-')) category = 'motor';
        else if (f === 'agent-ask' || f === 'agent-status') category = 'cortex';
        else if (f.startsWith('core-memory-') || f === 'update-deep-truths' || f === 'session-summary') category = 'memory';
        else if (f.startsWith('chat-') || f === 'dwd-token' || f === 'ws-token') category = 'ears';
        else if (f.startsWith('upgrade-') || f === 'validate-contracts' || f === 'render-config' || f === 'oc' || f === 'agent-ou-manage') category = 'config';
        else if (f.endsWith('.md') || f.endsWith('.json') || f.endsWith('.tmpl') || f.endsWith('.sh')) category = 'config';

        tools.push({
          name: f,
          category,
          description: description || '',
          sizeBytes: st.size,
        });
      } catch {}
    }
  }

  // Scan skills directory for skill packs
  const skillPacks = [];
  if (existsSync(SKILLS_DIR)) {
    const dirs = readdirSync(SKILLS_DIR);
    for (const d of dirs) {
      const skillDir = join(SKILLS_DIR, d);
      try {
        const st = statSync(skillDir);
        if (!st.isDirectory()) continue;
        const skillMd = join(skillDir, 'SKILL.md');
        let skillDescription = '';
        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, 'utf8');
          // Extract description from YAML frontmatter or first paragraph
          const descMatch = content.match(/description:\s*(.+)/) || content.match(/^#\s*.+\n+(.+)/m);
          if (descMatch) skillDescription = descMatch[1].trim();
        }
        const fileCount = readdirSync(skillDir).length;
        skillPacks.push({
          name: d,
          description: skillDescription,
          files: fileCount,
        });
      } catch {}
    }
  }

  return { tools, skillPacks, binDir: BIN_DIR, skillsDir: SKILLS_DIR };
}

function handleStatus() {
  // Read STATE.json if it exists
  let state = null;
  const statePath = join(COREKIT_DIR, 'STATE.json');
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  }

  // Check daemon health files
  const daemons = {};
  for (const name of ['ears', 'mouth', 'brain', 'introspect']) {
    const healthFile = `/var/run/agent-${name}-last-poll`;
    let healthy = false;
    let lastPollAge = null;
    if (existsSync(healthFile)) {
      try {
        const last = parseInt(readFileSync(healthFile, 'utf8').trim(), 10);
        lastPollAge = Math.floor((Date.now() - last) / 1000);
        healthy = lastPollAge < 60;
      } catch {}
    }
    daemons[name] = { healthy, lastPollAge };
  }

  return { state, daemons, hostname: hostname(), agentHostname: AGENT_HOSTNAME, uptime: process.uptime() };
}

function handleConfig() {
  // Agent identity
  let chatConfig = null;
  const chatConfigPath = join(COREKIT_DIR, 'chat-config.json');
  if (existsSync(chatConfigPath)) {
    try { chatConfig = JSON.parse(readFileSync(chatConfigPath, 'utf8')); } catch {}
  }

  // Contracts
  let contracts = null;
  const contractsPath = join(COREKIT_DIR, 'contracts.json');
  if (existsSync(contractsPath)) {
    try { contracts = JSON.parse(readFileSync(contractsPath, 'utf8')); } catch {}
  }

  // OpenClaw version
  let ocVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync('/home/node/.openclaw/package.json', 'utf8'));
    ocVersion = pkg.version || 'unknown';
  } catch {}

  return {
    hostname: hostname(),
    agentHostname: AGENT_HOSTNAME,
    primeId: PRIME_ID,
    email: chatConfig?.agentUserEmail || '',
    specialty: chatConfig?.specialty || '',
    ocVersion,
    contracts: contracts ? { ears: contracts.ears, versioning: contracts.versioning } : null,
  };
}

function handleWorkspace() {
  const workspaces = {};
  const ocHome = OC_HOME;
  if (existsSync(ocHome)) {
    const entries = readdirSync(ocHome);
    for (const e of entries) {
      if (!e.startsWith('workspace')) continue;
      const wsDir = join(ocHome, e);
      try {
        const st = statSync(wsDir);
        if (!st.isDirectory()) continue;
        const files = readdirSync(wsDir)
          .filter(f => f.endsWith('.md') || f.endsWith('.json'))
          .map(f => {
            const fp = join(wsDir, f);
            const fst = statSync(fp);
            return { name: f, sizeBytes: fst.size };
          });
        workspaces[e] = files;
      } catch {}
    }
  }
  return { workspaces };
}

function handleBrainConfig() {
  const configPath = join(OC_HOME, 'openclaw.json');
  if (!existsSync(configPath)) {
    return { error: 'openclaw.json not found', default: '', slots: {} };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const defaultModel = config?.agents?.defaults?.model?.primary || '';
    const slots = {};
    const agentList = config?.agents?.list || [];
    for (const agent of agentList) {
      if (agent.id) {
        slots[agent.id] = agent.model?.primary || null;
      }
    }
    return { default: defaultModel, slots };
  } catch (err) {
    return { error: `Failed to parse openclaw.json: ${err.message}`, default: '', slots: {} };
  }
}

function handleSetModel(params) {
  const configPath = join(OC_HOME, 'openclaw.json');
  if (!existsSync(configPath)) {
    return { success: false, error: 'openclaw.json not found' };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const newDefault = params.default;
    const overrides = params.overrides || {};

    // Update default model
    if (newDefault) {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.model) config.agents.defaults.model = {};
      config.agents.defaults.model.primary = newDefault;
    }

    // Apply per-agent overrides
    const agentList = config.agents?.list || [];
    for (const agent of agentList) {
      if (agent.id && overrides[agent.id] !== undefined) {
        const modelId = overrides[agent.id];
        if (modelId) {
          if (!agent.model) agent.model = {};
          agent.model.primary = modelId;
        } else {
          delete agent.model;
        }
      }
    }

    // Write config back
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log('Updated openclaw.json with new model assignments', { default: newDefault, overrides });

    // Restart gateway container
    execSync('docker restart openclaw-gateway', { timeout: 60000, stdio: 'pipe' });
    log('Gateway restarted after model change');

    return { success: true, message: 'Models updated and gateway restarted' };
  } catch (err) {
    log('set_model error', { error: err.message });
    return { success: false, error: err.message };
  }
}

// ---- Query dispatcher ----
function processQuery(type, params = {}) {
  switch (type) {
    case 'skills': return handleSkills();
    case 'status': return handleStatus();
    case 'config': return handleConfig();
    case 'workspace': return handleWorkspace();
    case 'brain_config': return handleBrainConfig();
    case 'set_model': return handleSetModel(params);
    default: throw new Error(`Unknown query type: ${type}`);
  }
}

// ---- Main loop ----
async function tick() {
  try {
    // Write health file
    try {
      const { writeFileSync: wfs } = await import('fs');
      wfs('/var/run/agent-introspect-last-poll', String(Date.now()));
    } catch {}

    const queries = await pollForQueries();
    for (const q of queries) {
      log('Processing query', { type: q.type, path: q.path });
      try {
        const result = processQuery(q.type, q.params);
        await writeResult(q.path, result);
        log('Query complete', { type: q.type });
      } catch (err) {
        log('Query error', { type: q.type, error: err.message });
        await writeError(q.path, err.message).catch(() => {});
      }
    }
  } catch (err) {
    log('Poll error', { error: err.message });
  }
}

log('Starting', { prime: PRIME_ID, agent: AGENT_HOSTNAME, poll_ms: POLL_MS });
setInterval(tick, POLL_MS);
tick(); // immediate first poll
