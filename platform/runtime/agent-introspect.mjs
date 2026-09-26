#!/usr/bin/env node
// platform/runtime/agent-introspect.mjs — Agent Introspection Service
// Original module
// Used by dashboard (polls Firestore for introspection queries)
//
// Polls Firestore for introspection queries, reads local filesystem, writes results.
// Runs alongside ears/mouth/brain.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import { hostname } from 'os';
import { execSync } from 'child_process';
import { getGceToken } from '../security/gce-auth.mjs';
import { createClient } from '../persistence/firestore.mjs';
import { cronNextFire } from '../work/scheduler.mjs';
import {
  STORE_COLLECTION, REVISIONS_COLLECTION, storeParent, resolvePolicy, loadShipped,
  mergeResponsibilities, planWrite, describeProvenance,
} from '../work/responsibility-store.mjs';

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
  const res = await fetch(url, {
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
  // A Firestore rejection (e.g. 400 document-too-large) resolves the fetch — without this
  // check the command doc never flips to complete and the dashboard card hangs pending.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`writeResult PATCH ${res.status}: ${body.slice(0, 300)}`);
  }
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
      specialty = cfg.specialty || cfg.agentType || '';
    } catch {}
  }

  // ---- Scan all skill directories (mirrors assemble-persona) ----
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
      agent_part: Array.isArray(manifest.agent_part) ? manifest.agent_part : [manifest.agent_part || 'motor'],
      category: manifest.category || '',
      origin,
      scripts: manifest.scripts || [],
      when_to_use: manifest.when_to_use || '',
      skillMdContent,
    });
  }

  // 1. Base skills: /opt/corekit/skills/{id}/
  const seenSkillIds = new Set();
  if (existsSync(SKILLS_DIR)) {
    try {
      for (const d of readdirSync(SKILLS_DIR)) {
        const skillDir = join(SKILLS_DIR, d);
        try {
          if (statSync(skillDir).isDirectory()) {
            collectSkill(d, skillDir, 'base');
            seenSkillIds.add(d);
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Specialty skills: /opt/corekit/corekit/specialties/{specialty}/skills/{id}/
  //    Skip any already collected from base (they get deployed there during upgrade)
  if (specialty) {
    const specSkillsDir = join(COREKIT_DIR, 'specialties', specialty, 'skills');
    if (existsSync(specSkillsDir)) {
      try {
        for (const d of readdirSync(specSkillsDir)) {
          if (seenSkillIds.has(d)) continue; // already in base — skip duplicate
          const skillDir = join(specSkillsDir, d);
          try {
            if (statSync(skillDir).isDirectory()) {
              collectSkill(d, skillDir, 'specialty');
              seenSkillIds.add(d);
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
    specialty: chatConfig?.specialty || chatConfig?.agentType || '',
    ocVersion,
    contracts: contracts ? { ears: contracts.ears, versioning: contracts.versioning } : null,
  };
}

function handleWorkspace() {
  const workspaces = {};
  const files = {};  // flat map: "workspace-motor/SOUL.md" → content
  // Persona files always carry content (the Brain cards read them); other .md artifacts are
  // included only while the running total stays under budget, so a workspace full of agent
  // work artifacts can't push the Firestore result doc toward its 1 MiB limit.
  const PERSONA_FILES = new Set(['SOUL.md', 'IDENTITY.md', 'MEMORY.md']);
  const MAX_FILE = 65536;       // 64KB per file — comfortably above the largest organ SOUL (~18KB)
  const MAX_TOTAL = 700 * 1024; // total content budget across all workspace dirs
  let totalChars = 0;
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
            // Read .md content. Cap per-file size, but ALWAYS populate persona keys when
            // readable — a dropped key renders as "Not found on agent" in the dashboard.
            // The old 8KB cap silently hid every organ SOUL >= 8KB (cortex ~11.5KB,
            // motor/cerebellum with appends), which is why those Brain cards showed empty
            // while prefrontal (no append) rendered.
            let content = undefined;
            if (f.endsWith('.md') && (PERSONA_FILES.has(f) || totalChars < MAX_TOTAL)) {
              try {
                const raw = readFileSync(fp, 'utf8');
                content = raw.length > MAX_FILE
                  ? raw.slice(0, MAX_FILE) + `\n\n… [truncated: ${fst.size} bytes total]`
                  : raw;
                totalChars += content.length;
              } catch {}
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

async function handleBrainConfig() {
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

  return { default: defaultModel, slots, daemonModels, responsibilities: await readResponsibilityEntries() };
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
// ---- Responsibilities: shipped files + this agent's own store ----
//
// The same merge the scheduler runs (platform/work/responsibility-store.mjs), so the
// dashboard shows what actually fires — including the agent's overrides and the
// responsibilities it created — and a toggle lands in the store the scheduler reads.
// This used to read two hardcoded files and toggle by editing them in place, which
// the next CoreKit upgrade silently reverted (C-36).

const _db = GCP_PROJECT ? createClient({ projectId: GCP_PROJECT, logger: (level, m) => log(`firestore ${level}: ${m}`) }) : null;

function respStoreParent() {
  return storeParent({ primeId: PRIME_ID, agentId: AGENT_HOSTNAME, isPrime: false });
}

function respPolicy() {
  try { return resolvePolicy(JSON.parse(readFileSync(join(COREKIT_DIR, 'contracts.json'), 'utf8'))); } catch { return resolvePolicy({}); }
}

async function readStoreDocs() {
  if (!_db || !PRIME_ID) return { docs: [], storeError: 'Firestore unavailable' };
  try {
    return { docs: await _db.query(respStoreParent(), STORE_COLLECTION, [], { noOrderBy: true, strict: true, limit: 200 }) };
  } catch (e) {
    return { docs: [], storeError: e.message };
  }
}

async function readResponsibilityEntries() {
  const shipped = loadShipped(CORE_DIR, {
    onError: (file, err) => log('Error reading responsibilities file', { file, error: err.message }),
  });
  const { docs, storeError } = await readStoreDocs();
  const { effective, issues } = mergeResponsibilities(shipped, docs, { policy: respPolicy(), nextFire: cronNextFire });
  if (storeError) log('Responsibility store unreadable — showing shipped defaults only', { error: storeError });
  for (const i of issues) log('Responsibility store record ignored', { id: i.id, reason: i.reason });
  return effective.map((r) => ({
    id: r.id || 'unknown',
    name: r.name || r.id || 'Unnamed',
    schedule: r.schedule || (r.event ? `on ${r.event}` : ''),
    timezone: r.timezone || 'UTC',
    enabled: r.enabled !== false,
    min_spacing_minutes: r.min_spacing_minutes || 0,
    instruction: (r.instruction || '').substring(0, 200),
    has_process: !!(r.context?.process?.length),
    process_steps: r.context?.process?.length || 0,
    source: describeProvenance(r),
    origin: r._provenance?.origin || 'shipped',
    revision: r._provenance?.revision ?? null,
    updated_by: r._provenance?.updated_by ?? null,
    locked: r.locked === true,
  }));
}

// ---- handleResponsibilities ----
async function handleResponsibilities() {
  return { responsibilities: await readResponsibilityEntries() };
}

// ---- handleSetResponsibilityEnabled ----
async function handleSetResponsibilityEnabled(params) {
  const { id, enabled } = params;
  if (!id) return { success: false, error: 'Missing required param: id' };
  if (enabled === undefined) return { success: false, error: 'Missing required param: enabled' };
  if (!_db || !PRIME_ID) return { success: false, error: 'Firestore unavailable' };

  const targetEnabled = enabled === true || enabled === 'true';
  const shipped = loadShipped(CORE_DIR);
  const docPath = `${respStoreParent()}/${STORE_COLLECTION}/${id}`;
  try {
    const current = await _db.readDoc(docPath);
    const plan = planWrite({
      verb: 'update', id, input: { enabled: targetEnabled },
      current: current?.data || null,
      shipped: shipped.find((r) => r.id === id) || null,
      actor: 'dashboard', policy: respPolicy(), nextFire: cronNextFire,
    });
    if (!plan.ok) return { success: false, error: plan.error };
    const doc = { ...plan.doc, prime_id: PRIME_ID, agent_id: AGENT_HOSTNAME };
    await _db.commit([
      { path: docPath, data: doc, precondition: current ? { updateTime: current.updateTime } : { exists: false } },
      { path: `${docPath}/${REVISIONS_COLLECTION}/${doc.revision}`, data: doc, precondition: { exists: false } },
    ]);
    log(`Set responsibility ${id} enabled=${targetEnabled}`, { revision: doc.revision });
    return {
      success: true,
      id,
      enabled: targetEnabled,
      message: `Responsibility '${id}' ${targetEnabled ? 'enabled' : 'disabled'} (revision ${doc.revision}). The scheduler picks it up within a minute; it survives upgrades.`,
    };
  } catch (err) {
    return { success: false, error: `Failed to update '${id}': ${err.message}` };
  }
}

// ---- handleRunResponsibility ----
// Operator "Run now": the daemon that owns the scheduler (agent-brain) is a
// separate process, so we bridge by enqueuing a pending doc into the top-level
// `responsibility_triggers` collection. The brain's pollLoop claims it, fires it
// via scheduler.fireById, and writes back a terminal status the dashboard reads.
async function handleRunResponsibility(params) {
  const { id } = params;
  if (!id) return { success: false, error: 'Missing required param: id' };
  const known = (await readResponsibilityEntries()).find(e => e.id === id);
  if (!known) return { success: false, error: `Responsibility '${id}' not found` };
  if (!FIRESTORE_URL) return { success: false, error: 'Firestore unavailable' };

  try {
    const token = await getGceToken();
    const doc = {
      agent_id: AGENT_HOSTNAME,
      responsibility_id: id,
      status: 'pending',
      bypass_spacing: true,          // explicit "now" — skip min-spacing (never the singleton guard)
      requested_by: 'dashboard',
      requested_at: new Date().toISOString(),
    };
    const res = await fetch(`${FIRESTORE_URL}/responsibility_triggers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeMap(doc) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { success: false, error: `Enqueue failed: ${res.status} ${body.slice(0, 200)}` };
    }
    log(`Queued on-demand trigger for ${id}`, { responsibility: id });
    return { success: true, message: `'${known.name}' queued — the brain will start it within a few seconds.` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---- Query dispatcher ----
async function processQuery(type, params = {}) {
  switch (type) {
    case 'skills': return handleSkills();
    case 'status': return handleStatus();
    case 'config': return handleConfig();
    case 'workspace': return handleWorkspace();
    case 'brain_config': return handleBrainConfig();
    case 'set_model': return handleSetModel(params);
    case 'responsibilities': return handleResponsibilities();
    case 'set_responsibility_enabled': return handleSetResponsibilityEnabled(params);
    case 'run_responsibility': return await handleRunResponsibility(params);
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
        const result = await processQuery(q.type, q.params);
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
      log('Restarting agent-neural-gateway service (deferred from set_model)...');
      try {
        execSync('systemctl restart agent-neural-gateway', { timeout: 15000, stdio: 'pipe' });
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
