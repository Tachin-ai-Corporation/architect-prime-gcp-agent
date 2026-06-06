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
// hostname() returns e.g. "fleet-tom" or "prime-chucknorris"
// Strip "fleet-" prefix to get agent name matching Firestore doc IDs
const AGENT_HOSTNAME = hostname().replace(/^fleet-/, '');
const POLL_MS = 5000;

const FIRESTORE_URL = GCP_PROJECT
  ? `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`
  : '';

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
const BIN_DIR = join(CORE_DIR, 'bin');
const SKILLS_DIR = join(CORE_DIR, 'skills');
const COREKIT_DIR = join(CORE_DIR, 'corekit');
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
        //  config  - System config & base functions: CoreKit/fleet infra tools
        //            Matches: upgrade-*, validate-contracts, agent-ou-manage,
        //                     *.md, *.json, *.tmpl, *.sh
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

  // Brain/CoreKit version
  let ocVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(CORE_DIR, 'corekit/brain/package.json'), 'utf8'));
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
  if (existsSync(CORE_DIR)) {
    const entries = readdirSync(CORE_DIR);
    for (const e of entries) {
      if (!e.startsWith('workspace')) continue;
      const wsDir = join(CORE_DIR, e);
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
  const contractsPath = join(COREKIT_DIR, 'contracts.json');
  
  let defaultModel = '';
  const slots = {};

  if (existsSync(contractsPath)) {
    try {
      const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
      const models = contracts?.vertex?.models || {};
      defaultModel = models.cortex || '';
      slots.cortex = models.cortex || null;
      // Map subagent model to each known subagent ID
      const subagentIds = contracts?.agents?.subagentIds || ['temporal-research', 'temporal-memory', 'prefrontal', 'motor', 'cerebellum'];
      for (const id of subagentIds) {
        slots[id] = models.subagent || models.cortex || null;
      }
    } catch (err) {
      return { error: `Failed to parse contracts.json: ${err.message}`, default: '', slots: {} };
    }
  } else {
    return { error: 'No contracts.json config file found', default: '', slots: {} };
  }

  // Read contracts.json for ears/mouth/brain daemon models
  const daemonModels = {};
  if (existsSync(contractsPath)) {
    try {
      const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
      daemonModels.ears = contracts?.ears?.preprocess?.model || null;
      daemonModels.mouth = contracts?.mouth?.model || null;
      // Brain daemon uses the Cortex gateway route — its LLM is whatever Cortex is set to
      daemonModels.brain = contracts?.brain?.model || null;
    } catch {}
  }

  // Read responsibilities (same query to avoid extra introspection roundtrip)
  const responsibilities = [];
  const respFiles = [
    join(COREKIT_DIR, 'responsibilities.json'),
    join(COREKIT_DIR, 'responsibilities-job.json'),
  ];
  for (const respPath of respFiles) {
    if (!existsSync(respPath)) continue;
    try {
      const data = JSON.parse(readFileSync(respPath, 'utf8'));
      for (const r of (data.responsibilities || [])) {
        responsibilities.push({
          id: r.id || 'unknown',
          name: r.name || r.id || 'Unnamed',
          schedule: r.schedule || '',
          enabled: r.enabled !== false,
          min_spacing_minutes: r.min_spacing_minutes || 0,
          instruction: (r.instruction || '').substring(0, 200),
          has_process: !!(r.context?.process?.length),
          process_steps: r.context?.process?.length || 0,
          source: basename(respPath),
        });
      }
    } catch {}
  }

  return { default: defaultModel, slots, daemonModels, responsibilities };
}

function handleSetModel(params) {
  const contractsPath = join(COREKIT_DIR, 'contracts.json');

  if (!existsSync(contractsPath)) {
    return { success: false, error: 'contracts.json not found' };
  }
  try {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
    const newDefault = params.default;
    const overrides = params.overrides || {};
    const daemonOverrides = params.daemonOverrides || {};

    if (!contracts.vertex) contracts.vertex = {};
    if (!contracts.vertex.models) contracts.vertex.models = {};

    if (newDefault) {
      contracts.vertex.models.cortex = newDefault;
    }
    // Per-agent overrides: cortex goes to cortex, everything else to subagent
    for (const [agentId, modelId] of Object.entries(overrides)) {
      if (agentId === 'cortex') {
        contracts.vertex.models.cortex = modelId || contracts.vertex.models.cortex;
      } else if (modelId) {
        contracts.vertex.models.subagent = modelId;
      }
    }
    // Daemon overrides
    if (daemonOverrides.ears) {
      if (!contracts.ears) contracts.ears = {};
      if (!contracts.ears.preprocess) contracts.ears.preprocess = {};
      contracts.ears.preprocess.model = daemonOverrides.ears;
    }
    if (daemonOverrides.mouth) {
      if (!contracts.mouth) contracts.mouth = {};
      contracts.mouth.model = daemonOverrides.mouth;
    }
    if (daemonOverrides.brain) {
      if (!contracts.brain) contracts.brain = {};
      contracts.brain.model = daemonOverrides.brain;
    }

    writeFileSync(contractsPath, JSON.stringify(contracts, null, 2));
    log('Updated contracts.json with brain model assignments', { default: newDefault, overrides });
    return { success: true, message: 'Models updated in contracts.json — brain reload pending', _needsRestart: true };
  } catch (err) {
    log('set_model error (brain mode)', { error: err.message });
    return { success: false, error: err.message };
  }
}

// ---- handleResponsibilities ----
function handleResponsibilities() {
  const results = [];
  const possibleFiles = [
    join(COREKIT_DIR, 'responsibilities.json'),
    join(COREKIT_DIR, 'responsibilities-job.json'),
  ];
  for (const filePath of possibleFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      const responsibilities = data.responsibilities || [];
      for (const r of responsibilities) {
        results.push({
          id: r.id || 'unknown',
          name: r.name || r.id || 'Unnamed',
          schedule: r.schedule || '',
          enabled: r.enabled !== false,
          min_spacing_minutes: r.min_spacing_minutes || 0,
          instruction: (r.instruction || '').substring(0, 200),
          has_process: !!(r.context?.process?.length),
          process_steps: r.context?.process?.length || 0,
          source: basename(filePath),
        });
      }
    } catch (err) {
      log('Error reading responsibilities file', { path: filePath, error: err.message });
    }
  }
  return { responsibilities: results };
}

// ---- handleSetResponsibilityEnabled ----
function handleSetResponsibilityEnabled(params) {
  const { id, enabled } = params;
  if (!id) return { success: false, error: 'Missing required param: id' };
  if (enabled === undefined) return { success: false, error: 'Missing required param: enabled' };

  const targetEnabled = enabled === true || enabled === 'true';
  const respFiles = [
    join(COREKIT_DIR, 'responsibilities.json'),
    join(COREKIT_DIR, 'responsibilities-job.json'),
  ];

  for (const filePath of respFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      const resps = data.responsibilities || [];
      const idx = resps.findIndex(r => r.id === id);
      if (idx === -1) continue;

      resps[idx].enabled = targetEnabled;
      writeFileSync(filePath, JSON.stringify(data, null, 2));
      log(`Set responsibility ${id} enabled=${targetEnabled}`, { file: basename(filePath) });
      return {
        success: true,
        id,
        enabled: targetEnabled,
        message: `Responsibility '${resps[idx].name || id}' ${targetEnabled ? 'enabled' : 'disabled'}. Brain scheduler will reload within 10 seconds.`,
      };
    } catch (err) {
      return { success: false, error: `Failed to update ${basename(filePath)}: ${err.message}` };
    }
  }

  return { success: false, error: `Responsibility '${id}' not found in any config file` };
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
    case 'responsibilities': return handleResponsibilities();
    case 'set_responsibility_enabled': return handleSetResponsibilityEnabled(params);
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

    let needsRestart = false;
    const queries = await pollForQueries();
    for (const q of queries) {
      log('Processing query', { type: q.type, path: q.path });
      try {
        const result = processQuery(q.type, q.params);
        // Write result to Firestore BEFORE any restart
        await writeResult(q.path, result);
        log('Query complete', { type: q.type });
        // Check if handler flagged a restart (set_model)
        if (result?._needsRestart) needsRestart = true;
      } catch (err) {
        log('Query error', { type: q.type, error: err.message });
        await writeError(q.path, err.message).catch(() => {});
      }
    }

    // Restart gateway AFTER all results are written to Firestore.
    // This will kill this process (running inside the container),
    // but systemd RestartAlways will bring us back.
    if (needsRestart) {
      log('Restarting agent-brain-gateway service (deferred from set_model)...');
      try {
        execSync('systemctl restart agent-brain-gateway', { timeout: 15000, stdio: 'pipe' });
      } catch (err) {
        log('Gateway restart error', { error: err.message });
      }
    }
  } catch (err) {
    log('Poll error', { error: err.message });
  }
}

log('Starting', { prime: PRIME_ID, agent: AGENT_HOSTNAME, poll_ms: POLL_MS });
setInterval(tick, POLL_MS);
tick(); // immediate first poll
