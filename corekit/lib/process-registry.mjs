// corekit/lib/process-registry.mjs — Process PLAYBOOK registry loader
//
// A process is a remembered PLAYBOOK (name + description + narrative) that an agent
// RECALLS into its own checkpoint_plan — NOT an executable step-machine. This module
// only LOADS processes (local CoreKit files + the tenant-global Firestore `processes`
// collection) and exposes them read-only. The former deterministic executor
// (executeProcess / plan lifecycle / processToCheckpointPlan) was removed in the
// process-as-narrative migration (RFC docs/proposals/PROCESS_AS_NARRATIVE.md); this
// registry is what survived — pure loading, no execution.
//
// All Firestore access is direct REST via the metadata SA token (getGceToken).

import { readFileSync, existsSync, readdirSync } from 'fs';
import { getGceToken } from './gce-auth.mjs';
import { firestoreDecode } from './firestore.mjs';
import { reconcileEntityId } from './entity-id.mjs';

/**
 * Create a process registry instance.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {string} deps.config.coreDir      - e.g. '/opt/corekit'
 * @param {string} [deps.config.gcpProject] - GCP project id (enables the Firestore layer)
 * @param {function} [deps.logger]          - (level, msg) => void
 * @returns {object} registry API — { loadProcesses, ensureLoaded, getProcess, getAllProcesses }
 */
export function createProcessRegistry(deps) {
  const { config = {}, logger } = deps || {};
  const log = logger || ((level, msg) => console.log(`[process-registry] ${level}: ${msg}`));
  const { coreDir = '/opt/corekit', gcpProject } = config;

  const FIRESTORE_BASE = gcpProject
    ? `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`
    : null;

  // ---- Registry state ----
  let PROCESSES = {};            // keyed by process id
  let _processesLoadedAt = 0;
  const PROCESSES_REFRESH_MS = 60_000;

  /**
   * Load standard processes bundled with CoreKit (on-disk JSON files).
   * @returns {object} Map of processId → process definition
   */
  function loadLocalProcesses() {
    const localProcs = {};
    const procDir = coreDir + '/corekit/processes';
    try {
      if (!existsSync(procDir)) return localProcs;
      for (const file of readdirSync(procDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const p = JSON.parse(readFileSync(`${procDir}/${file}`, 'utf8'));
          if (p.id && p.status !== 'deprecated') {
            localProcs[p.id] = p;
          }
        } catch (e) {
          log('WARN', `Failed to parse local process ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      log('DEBUG', `Local processes dir not found: ${e.message}`);
    }
    return localProcs;
  }

  /**
   * Load processes from both local files and Firestore.
   * Firestore definitions override local ones with the same ID.
   */
  async function loadProcesses() {
    // 1. Standard processes bundled with CoreKit (always available)
    const localProcs = loadLocalProcesses();

    // 2. Agent-evolved processes from the tenant-global Firestore library (override local by ID)
    const firestoreProcs = {};
    try {
      const token = await getGceToken();
      if (token && FIRESTORE_BASE) {
        const url = `${FIRESTORE_BASE}/processes`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (resp.ok) {
          const data = await resp.json();
          for (const doc of (data.documents || [])) {
            // C-31: the document path is the authoritative identity. A dashboard
            // writer that omits `id` must not produce a playbook no agent can recall.
            const { entity: p, mismatch } = reconcileEntityId(firestoreDecode(doc.fields || {}), doc.name);
            if (!p) continue;
            if (mismatch) log('WARN', `Process ${p.id}: stored id '${mismatch}' disagrees with document path`);
            if (p.id && p.status !== 'deprecated') {
              firestoreProcs[p.id] = p;
            }
          }
        }
      }
    } catch (e) {
      log('WARN', `Failed to load Firestore processes: ${e.message}`);
    }

    // 3. Merge: Firestore overrides local (same ID); local provides the baseline.
    PROCESSES = { ...localProcs, ...firestoreProcs };
    _processesLoadedAt = Date.now();
    const localCount = Object.keys(localProcs).length;
    const fsCount = Object.keys(firestoreProcs).length;
    if (localCount + fsCount > 0) {
      log('INFO', `Processes loaded: ${Object.keys(PROCESSES).join(', ')} (${localCount} local, ${fsCount} firestore)`);
    }
  }

  /**
   * Ensure processes are loaded (load-once gate with periodic refresh).
   */
  async function ensureProcessesLoaded() {
    if (Date.now() - _processesLoadedAt > PROCESSES_REFRESH_MS) {
      await loadProcesses();
    }
  }

  return {
    /** Load all processes from local files + Firestore. */
    async loadProcesses() { return loadProcesses(); },
    /** Ensure processes are loaded (with periodic refresh). */
    async ensureLoaded() { return ensureProcessesLoaded(); },
    /** Get a single process by ID. */
    getProcess(id) { return PROCESSES[id]; },
    /** Get all processes as a map. */
    getAllProcesses() { return PROCESSES; },
  };
}
