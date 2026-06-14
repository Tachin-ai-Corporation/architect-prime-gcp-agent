#!/usr/bin/env node
// corekit/daemon/agent-introspect.mjs — Agent Introspection Service
// Original module
// Used by dashboard (polls Firestore for introspection queries)
//
// Polls Firestore for introspection queries, reads local filesystem, writes results.
// Runs alongside ears/mouth/brain.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { hostname } from 'os';
import { execSync } from 'child_process';
import { getGceToken } from '../corekit/lib/gce-auth.mjs';

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

// ---- Firestore helpers ----
async function pollForQueries() {
  if (!FIRESTORE_URL || !PRIME_ID || !AGENT_HOSTNAME) return [];
  const token = await getGceToken();
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
  const token = await getGceToken();
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
  const token = await getGceToken();
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
  // ---- Determine agent specialty from chat-config.json ----
  let specialty = '';
  const chatConfigPath = join(COREKIT_DIR, 'chat-config.json');
  if (existsSync(chatConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(chatConfigPath, 'utf8'));
      specialty = cfg.specialty || '';
    } catch {}
  }

  // ---- Scan all skill directories (mirrors assemble-tools) ----
  const skills = [];

  /**
   * Read a single skill directory and push canonical data.
   * @param {string} skillId - skill identifier
   * @param {string} skillDir - absolute path to skill directory
   * @param {string} origin - 'base' | 'specialty' | 'custom'
   */
  function collectSkill(skillId, skillDir, origin) {
    const skillJsonPath = join(skillDir, 'skill.json');
    const skillMdPath = join(skillDir, 'SKILL.md');

    // Must have at least SKILL.md to be a valid skill
    if (!existsSync(skillMdPath)) return;

    let manifest = {};
    if (existsSync(skillJsonPath)) {
      try { manifest = JSON.parse(readFileSync(skillJsonPath, 'utf8')); } catch {}
    }

    let skillMdContent = '';
    try { skillMdContent = readFileSync(skillMdPath, 'utf8'); } catch {}

    skills.push({
      id: manifest.id || skillId,
      name: manifest.name || skillId,
      version: manifest.version || '',
      description: manifest.description || '',
      agent_part: manifest.agent_part || 'motor',
      category: manifest.category || '',
      origin,
      scripts: manifest.scripts || [],
      when_to_use: manifest.when_to_use || '',
      skillMdContent,
    });
  }

  // 1. Base skills: /opt/corekit/skills/{id}/
  if (existsSync(SKILLS_DIR)) {
    try {
      for (const d of readdirSync(SKILLS_DIR)) {
        const skillDir = join(SKILLS_DIR, d);
        try {
          if (statSync(skillDir).isDirectory()) {
            collectSkill(d, skillDir, 'base');
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Specialty skills: /opt/corekit/corekit/specialties/{specialty}/skills/{id}/
  if (specialty) {
    const specSkillsDir = join(COREKIT_DIR, 'specialties', specialty, 'skills');
    if (existsSync(specSkillsDir)) {
      try {
        for (const d of readdirSync(specSkillsDir)) {
          const skillDir = join(specSkillsDir, d);
          try {
            if (statSync(skillDir).isDirectory()) {
              collectSkill(d, skillDir, 'specialty');
            }
          } catch {}
        }
      } catch {}
    }
  }

  // 3. Custom per-agent skills: /opt/corekit/workspace/custom-skills/{id}/
  const customSkillsDir = join(CORE_DIR, 'workspace', 'custom-skills');
  if (existsSync(customSkillsDir)) {
    try {
      for (const d of readdirSync(customSkillsDir)) {
        const skillDir = join(customSkillsDir, d);
        try {
          if (statSync(skillDir).isDirectory()) {
            collectSkill(d, skillDir, 'custom');
          }
        } catch {}
      }
    } catch {}
  }

  return { skills };
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
  const files = {};  // flat map: "workspace-motor/SOUL.md" → content
  if (existsSync(CORE_DIR)) {
    const entries = readdirSync(CORE_DIR);
    for (const e of entries) {
      if (!e.startsWith('workspace')) continue;
      const wsDir = join(CORE_DIR, e);
      try {
        const st = statSync(wsDir);
        if (!st.isDirectory()) continue;
        const wsFiles = readdirSync(wsDir)
          .filter(f => f.endsWith('.md') || f.endsWith('.json'))
          .map(f => {
            const fp = join(wsDir, f);
            const fst = statSync(fp);
            // Read .md content (capped at 8KB to stay safe)
            let content = undefined;
            if (f.endsWith('.md') && fst.size < 8192) {
              try { content = readFileSync(fp, 'utf8'); } catch {}
            }
            // Build flat key: "workspace" dir → "SOUL.md", others → "workspace-motor/SOUL.md"
            const flatKey = e === 'workspace' ? f : `${e}/${f}`;
            if (content !== undefined) files[flatKey] = content;
            return { name: f, sizeBytes: fst.size };
          });
        workspaces[e] = wsFiles;
      } catch {}
    }
  }
  return { workspaces, files };
}

function handleBrainConfig() {
  const contractsPath = join(COREKIT_DIR, 'contracts.json');

  if (!existsSync(contractsPath)) {
    return { error: 'No contracts.json config file found', default: '', slots: {} };
  }

  let contracts;
  try {
    contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  } catch (err) {
    return { error: `Failed to parse contracts.json: ${err.message}`, default: '', slots: {} };
  }

  const models = contracts?.vertex?.models || {};
  const defaultModel = models.cortex || '';
  const slots = { cortex: models.cortex || null };

  // Map subagent model to each known subagent ID
  const subagentIds = contracts?.agents?.subagentIds || ['temporal-research', 'temporal-memory', 'prefrontal', 'motor', 'cerebellum'];
  for (const id of subagentIds) {
    slots[id] = models.subagent || models.cortex || null;
  }

  // Daemon models (ears/mouth/brain)
  const daemonModels = {
    ears: contracts?.ears?.preprocess?.model || null,
    mouth: contracts?.mouth?.model || null,
    // Brain daemon uses the Cortex gateway route — its LLM is whatever Cortex is set to
    brain: contracts?.dispatch?.model || null,
  };

  return { default: defaultModel, slots, daemonModels, responsibilities: readResponsibilityEntries() };
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
      if (!contracts.dispatch) contracts.dispatch = {};
      contracts.dispatch.model = daemonOverrides.brain;
    }

    writeFileSync(contractsPath, JSON.stringify(contracts, null, 2));
    log('Updated contracts.json with brain model assignments', { default: newDefault, overrides });
    return { success: true, message: 'Models updated in contracts.json — brain reload pending', _needsRestart: true };
  } catch (err) {
    log('set_model error (brain mode)', { error: err.message });
    return { success: false, error: err.message };
  }
}

// ---- Shared: read responsibility entries from config files ----
function readResponsibilityEntries() {
  const results = [];
  const possibleFiles = [
    join(COREKIT_DIR, 'responsibilities.json'),
    join(COREKIT_DIR, 'responsibilities-job.json'),
  ];
  for (const filePath of possibleFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      for (const r of (data.responsibilities || [])) {
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
  return results;
}

// ---- handleResponsibilities ----
function handleResponsibilities() {
  return { responsibilities: readResponsibilityEntries() };
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
    try { writeFileSync('/var/run/agent-introspect-last-poll', String(Date.now())); } catch {}

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
