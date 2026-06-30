// corekit/lib/projects.mjs — Project registry, validation, and dependencies
// Extracted from agent-brain.mjs Phase 1A
//
// Manages the project hierarchy (load, validate, context accumulation),
// dependency gating (depends_on), and context promotion (mission→project).
//
// All Firestore access uses the lib client (read/write/query/patch).
// No raw REST or FIRESTORE_BASE references.

import { getGceToken } from './gce-auth.mjs';
import { firestoreEncode, firestoreDecode } from './firestore.mjs';

/**
 * Create a project registry instance.
 *
 * @param {object} config
 * @param {object} config.firestore - Firestore lib client (with read/write/query/patch/del)
 * @param {string} config.primeId - The prime agent identifier
 * @param {string} config.agentId - The agent identifier (e.g. 'agent')
 * @param {string} [config.agentEmail] - The agent email for ownership fields
 * @param {string} [config.gcpProject] - GCP project ID (for raw REST calls to projects collection)
 * @param {object} [config.contracts] - Contracts object for config values
 * @param {function} [config.logger] - Logger function with (level, msg) signature
 * @param {function} [config.generateId] - ID generator function, default: internal
 * @param {function} [config.writeHistory] - History writer function(envelopeId, prev, new, agent, detail)
 * @returns {object} Project registry API
 */
export function createProjectRegistry(config) {
  const {
    firestore,
    primeId,
    agentId,
    agentEmail = '',
    gcpProject,
    contracts = {},
    generateId: _genId,
    writeHistory: _writeHistory,
  } = config;

  const log = config.logger || ((level, msg) => console.log(`[projects] ${level}: ${msg}`));

  // ---- Internal state ----
  let PROJECTS = {};              // keyed by project id
  let PROJECT_CHILDREN = {};      // parent_id → [child_id, ...]
  let DEFAULT_PROJECT_ID = null;
  let _projectsLoadedAt = 0;

  // ---- Config constants ----
  const PROJECTS_REFRESH_MS = 60_000;
  const MAX_PROJECT_DEPTH = 4;
  const PROJECT_PROMOTION_AUTO = contracts.projects?.promotion_auto || false;

  // Firestore REST base for the projects top-level collection
  // (projects live at DB root, not under primes/)
  const FIRESTORE_REST_BASE = gcpProject
    ? `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`
    : null;

  // ---- Helpers ----

  /** Get a GCE auth token (for raw REST calls to projects collection). */
  async function getAuthToken() {
    return getGceToken();
  }

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * Merge two context packets (maps of key→entry). Child wins on key collision.
   * @param {object} parentCtx
   * @param {object} childCtx
   * @returns {object} Merged context
   */
  function mergeContextPackets(parentCtx, childCtx) {
    if (!parentCtx && !childCtx) return {};
    if (!parentCtx) return { ...(childCtx || {}) };
    if (!childCtx) return { ...(parentCtx || {}) };
    return { ...parentCtx, ...childCtx }; // shallow by key — child overrides
  }

  /**
   * Render a context packet as structured text for brain injection.
   * Handles both rich context entries (kind/ref/summary) and legacy flat values.
   * @param {object} ctx
   * @returns {string}
   */
  function renderContextPacket(ctx) {
    if (!ctx || typeof ctx !== 'object') return '';
    const lines = [];
    for (const [key, entry] of Object.entries(ctx)) {
      if (!entry) continue;
      // Rich context entry (has 'kind' or 'summary')
      if (typeof entry === 'object' && (entry.kind || entry.summary)) {
        const kind = entry.kind || 'unknown';
        const name = entry.name || key;
        const line = `${key} (${kind}): ${name}`;
        lines.push(line);
        const details = [];
        if (entry.ref) details.push(`ID: ${entry.ref}`);
        if (entry.url) details.push(`URL: ${entry.url}`);
        if (entry.updatedAt) {
          const dateStr = typeof entry.updatedAt === 'string' ? entry.updatedAt.substring(0, 10) : '';
          const byStr = entry.updatedBy ? ` by ${entry.updatedBy}` : '';
          details.push(`Updated: ${dateStr}${byStr}`);
        }
        if (details.length > 0) lines.push(`  ${details.join(' | ')}`);
        if (entry.summary) lines.push(`  ${entry.summary}`);
      } else {
        // Legacy flat value (string, number, array)
        const val = Array.isArray(entry) ? entry.join(', ') : String(entry);
        lines.push(`${key}: ${val}`);
      }
    }
    return lines.join('\n');
  }

  // ---- Core functions ----

  /**
   * Load all projects from Firestore (top-level projects collection).
   * Projects are stored at the DB root `/projects`, not under `/primes/`.
   * Builds the parent→child index and refreshes the timestamp.
   */
  async function load() {
    try {
      const token = await getAuthToken();
      if (!token) return;
      if (!FIRESTORE_REST_BASE) {
        log('WARN', 'Cannot load projects: gcpProject not configured');
        return;
      }
      const url = `${FIRESTORE_REST_BASE}/projects`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const projects = {};
      const childIndex = {};
      for (const doc of (data.documents || [])) {
        const p = firestoreDecode(doc.fields || {});
        if (p.id && p.status !== 'archived') {
          // Ensure new fields have defaults
          p.goal = p.goal || '';
          p.owner = p.owner || '';
          p.parent_id = p.parent_id || null;
          p.depends_on = Array.isArray(p.depends_on) ? p.depends_on : [];
          p.context = p.context || null;
          projects[p.id] = p;
          // Build parent→child index
          if (p.parent_id) {
            if (!childIndex[p.parent_id]) childIndex[p.parent_id] = [];
            childIndex[p.parent_id].push(p.id);
          }
        }
      }
      PROJECTS = projects;
      PROJECT_CHILDREN = childIndex;
      _projectsLoadedAt = Date.now();
      if (Object.keys(projects).length > 0) {
        log('INFO', `Projects loaded: ${Object.keys(projects).join(', ')}`);
      }
    } catch (e) {
      log('WARN', `Failed to load projects: ${e.message}`);
    }
  }

  /**
   * Ensure projects are loaded (load-once gate with periodic refresh).
   * Reloads if the cache is older than PROJECTS_REFRESH_MS.
   */
  async function ensureLoaded() {
    if (Date.now() - _projectsLoadedAt > PROJECTS_REFRESH_MS) {
      await load();
    }
  }

  /**
   * Get accumulated project context by traversing parent chain.
   * Most specific (child) wins on key conflicts.
   * NOTE: Different from buildContext() which renders text for Cortex.
   *
   * @param {string} projectId - Project to accumulate context for
   * @returns {{ chain: Array<{id: string, name: string}>, context: object }}
   */
  function getAccumulatedContext(projectId) {
    const chain = [];
    let current = projectId;
    const visited = new Set();
    while (current && PROJECTS[current] && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current); // root first
      current = PROJECTS[current].parent_id;
    }
    // Merge contexts: root → leaf (leaf wins)
    let merged = { documentation: [], processes: [], team: {}, configuration: {} };
    for (const pid of chain) {
      const ctx = PROJECTS[pid]?.context;
      if (!ctx) continue;
      if (ctx.documentation) merged.documentation = [...merged.documentation, ...ctx.documentation];
      if (ctx.processes) merged.processes = [...merged.processes, ...ctx.processes];
      if (ctx.team) merged.team = { ...merged.team, ...ctx.team };
      if (ctx.configuration) merged.configuration = { ...merged.configuration, ...ctx.configuration };
    }
    return { chain: chain.map(id => ({ id, name: PROJECTS[id]?.name || id })), context: merged };
  }

  /**
   * Validate project nesting depth. Rejects nesting beyond MAX_PROJECT_DEPTH.
   *
   * @param {string} parentId - Parent project ID to validate depth for
   * @returns {boolean} True if depth is within limits
   * @throws {Error} If depth exceeds MAX_PROJECT_DEPTH
   */
  function validateDepth(parentId) {
    let depth = 0;
    let current = parentId;
    const visited = new Set();
    while (current && PROJECTS[current] && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = PROJECTS[current].parent_id;
    }
    if (depth >= MAX_PROJECT_DEPTH) {
      throw new Error(`Project nesting depth exceeds maximum of ${MAX_PROJECT_DEPTH}`);
    }
    return true;
  }

  /**
   * Check if a project's work is all complete and auto-transition to 'complete'.
   * Called when a Mission completes — checks if the mission's project has all work done.
   *
   * @param {string} projectId - Project to check for completion
   */
  async function checkCompletion(projectId) {
    if (!projectId || !PROJECTS[projectId]) return;
    const project = PROJECTS[projectId];
    if (project.status !== 'active') return;

    // Only auto-complete projects that explicitly opt in.
    // Active projects are ongoing work streams — completing all current
    // missions doesn't mean the project is done.
    if (!project.auto_complete) return;

    try {
      const token = await getAuthToken();
      if (!token) return;
      if (!FIRESTORE_REST_BASE) return;

      // 1. Check sub-projects — all must be complete/archived
      const childIds = PROJECT_CHILDREN[projectId] || [];
      for (const childId of childIds) {
        const child = PROJECTS[childId];
        if (!child) continue;
        if (child.status !== 'complete' && child.status !== 'archived') {
          return; // Still has active children
        }
      }

      // 2. Check missions belonging to this project — all must be complete/archived/cancelled
      const parentPath = `${FIRESTORE_REST_BASE}`;
      let nextPageToken = null;
      do {
        const url = `${parentPath}/work?pageSize=300${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) break;
        const data = await resp.json();
        for (const doc of (data.documents || [])) {
          const env = firestoreDecode(doc.fields || {});
          if (env.type !== 'M' || env.project_id !== projectId) continue;
          if (env.status !== 'complete' && env.status !== 'archived' && env.status !== 'cancelled' && env.status !== 'failed') {
            return; // Still has active missions
          }
        }
        nextPageToken = data.nextPageToken;
      } while (nextPageToken);

      // 3. Check depends_on — all deps must be complete/archived
      for (const depId of (project.depends_on || [])) {
        const dep = PROJECTS[depId];
        if (!dep) continue;
        if (dep.status !== 'complete' && dep.status !== 'archived') {
          return; // Dependency not met
        }
      }

      // All children, missions, and deps are done — auto-complete
      log('INFO', `Project ${projectId} all work complete — auto-completing`);
      project.status = 'complete';
      project.updated_at = now();
      const projUrl = `${FIRESTORE_REST_BASE}/projects/${projectId}`;
      await fetch(projUrl, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: firestoreEncode(project) }),
      });

      // Cascade — check parent project too
      if (project.parent_id) {
        await checkCompletion(project.parent_id);
      }
    } catch (e) {
      log('WARN', `checkProjectCompletion error for ${projectId}: ${e.message}`);
    }
  }

  /**
   * Detect circular dependencies in a depends_on array.
   * Traverses the dependency graph; returns true if adding targetId
   * as a dependent of sourceId would create a cycle.
   *
   * @param {string} sourceId - Source envelope/project ID
   * @param {string} targetId - Target ID to check for cycle
   * @param {object} [envelopes={}] - Map of envelopes to walk
   * @returns {boolean} True if adding dependency would create a cycle
   */
  function hasCircularDep(sourceId, targetId, envelopes = {}) {
    const visited = new Set();
    const stack = [targetId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === sourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const env = envelopes[current];
      if (env && Array.isArray(env.depends_on)) {
        stack.push(...env.depends_on);
      }
    }
    return false;
  }

  /**
   * Validate that M-type envelopes have a project_id before writing.
   * Logs warning and assigns default if missing.
   *
   * @param {object} envelope - The envelope to validate
   * @returns {object} The (possibly mutated) envelope
   */
  function validateMissionProject(envelope) {
    if (envelope.type === 'M' && !envelope.project_id) {
      log('WARN', `Mission ${envelope.id} missing project_id — assigning default`);
      envelope.project_id = DEFAULT_PROJECT_ID;
    }
    return envelope;
  }

  /**
   * Create the agent's default project if it doesn't exist.
   * Sets DEFAULT_PROJECT_ID and creates the project in Firestore if needed.
   *
   * @returns {string} The default project ID
   */
  async function ensureDefault() {
    // Deployment-level default: shared across all agents (C-1: Prime is executor, not owner)
    const defaultId = 'general';
    DEFAULT_PROJECT_ID = defaultId;
    if (PROJECTS[defaultId]) {
      log('DEBUG', `Default project exists: ${defaultId}`);
      return defaultId;
    }
    try {
      const token = await getAuthToken();
      if (!token) return defaultId;
      if (!FIRESTORE_REST_BASE) return defaultId;
      const url = `${FIRESTORE_REST_BASE}/projects/${defaultId}`;
      const body = {
        fields: {
          id: { stringValue: defaultId },
          name: { stringValue: 'General' },
          goal: { stringValue: 'General workspace for unscoped work' },
          description: { stringValue: `Default project for ${agentId}` },
          owner: { stringValue: agentEmail || agentId },
          status: { stringValue: 'active' },
          parent_id: { nullValue: null },
          depends_on: { arrayValue: { values: [] } },
          team: { arrayValue: { values: [{ stringValue: primeId }, { stringValue: agentId }] } },
          created_by: { stringValue: agentId },
          created_at: { stringValue: now() },
          updated_at: { stringValue: now() },
        }
      };
      await fetch(url, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      log('INFO', `Default project created: ${defaultId}`);
      // Reload to pick it up
      await load();
    } catch (e) {
      log('WARN', `Failed to create default project: ${e.message}`);
    }
    return defaultId;
  }

  /**
   * Build full project context for injection into agent dispatches.
   * Merges project-level context with optional envelope-level context.
   * Returns null if no project found.
   *
   * @param {string} projectId - Project to build context for
   * @param {object} [envelopeContext=null] - Optional envelope-level context to merge
   * @param {string} [coreDir='/opt/corekit'] - CORE_DIR for artifact paths
   * @returns {string|null} Rendered context string or null
   */
  function buildContext(projectId, envelopeContext = null, coreDir = '/opt/corekit') {
    if (!projectId || !PROJECTS[projectId]) return null;
    const p = PROJECTS[projectId];
    const projectCtx = p.context || {};
    const mergedCtx = mergeContextPackets(projectCtx, envelopeContext);

    const header = [`## Project Context: ${p.name || p.id}`];
    if (p.description) header.push(`Description: ${p.description}`);

    // Render canon entries first — authoritative facts that override all other context
    const canon = p.canon?.entries || [];
    if (canon.length > 0) {
      header.push('');
      header.push('### ⚠️ CANON (Authoritative Project Facts — Do NOT Contradict)');
      for (const entry of canon) {
        if (entry.key && entry.text) {
          header.push(`- **${entry.key}**: ${entry.text}`);
        }
      }
    }

    // Render team members so Cortex knows who to delegate to
    const team = Array.isArray(p.team) ? p.team : [];
    if (team.length > 0) {
      header.push('');
      header.push('### Team');
      for (const member of team) {
        if (typeof member === 'string') {
          // Legacy string format (just an ID)
          header.push(`- ${member}`);
        } else if (member.email) {
          const parts = [member.name || member.email.split('@')[0]];
          if (member.role) parts.push(`(${member.role})`);
          parts.push(`— ${member.email}`);
          if (member.type) parts.push(`[${member.type}]`);
          header.push(`- ${parts.join(' ')}`);
        }
      }
    }
    header.push('');

    const rendered = renderContextPacket(mergedCtx);
    if (!rendered && !p.description && team.length === 0 && canon.length === 0) return null;

    let result = header.join('\n') + rendered;

    // Inject shared workspace (Drive folder) context
    const driveFolder = mergedCtx?.drive_folder;
    const artifactCtx = mergedCtx?.artifacts;
    
    if (driveFolder?.ref) {
      const folderId = driveFolder.ref;
      const folderUrl = driveFolder.url || `https://drive.google.com/drive/folders/${folderId}`;
      const projectId = p.id || '';
      const lines = ['\n\n## Shared Workspace (Google Drive)'];
      lines.push(`📁 **Shared Workspace**: ${folderUrl}`);
      lines.push(`📂 **Folder ID**: \`${folderId}\``);
      lines.push('');
      lines.push('This Drive folder is the **persistent shared workspace** for this project.');
      lines.push('Artifacts are organized in date subfolders (MM-DD) automatically.');
      lines.push('');
      lines.push('**Publishing artifacts (use `work-publish`):**');
      lines.push(`- Publish a file: \`work-publish <file> --project ${projectId}\` → uploads to \`${folderId}/MM-DD/\``);
      lines.push(`- Custom subfolder: \`work-publish <file> --project ${projectId} --subfolder assets\``);
      lines.push('');
      lines.push('**Reading/browsing:**');
      lines.push(`- List contents: \`drive-ls ${folderId}\``);
      lines.push(`- Download a file: \`drive-download <fileId> --output ${coreDir}/shared/{missionId}/<filename>\``);
      lines.push(`- Search: \`drive-search --query "'${folderId}' in parents"\``);
      lines.push('');
      lines.push('**Workflow**: Download files you need → edit locally → `work-publish` results back to Drive.');
      
      // List existing artifacts if any
      if (artifactCtx?.files?.length > 0) {
        lines.push('');
        lines.push('**Existing files from prior work:**');
        for (const f of artifactCtx.files) {
          lines.push(`- ${f.name} — ${f.url || `driveId: ${f.driveId}`}`);
        }
      }
      
      result += lines.join('\n');
    } else if (artifactCtx?.files?.length > 0) {
      // No drive_folder but has artifact files — legacy artifact-only mode
      const lines = ['\n\n## Project Artifacts (Google Drive)'];
      if (artifactCtx.drive_url) lines.push(`📁 Project folder: ${artifactCtx.drive_url}`);
      lines.push('');
      lines.push('Prior work has produced these artifacts:');
      for (const f of artifactCtx.files) {
        lines.push(`- ${f.name} — ${f.url || `driveId: ${f.driveId}`}`);
      }
      lines.push('');
      lines.push(`To use a prior artifact: \`drive-download <driveId> ${coreDir}/shared/{missionId}/<filename>\``);
      result += lines.join('\n');
    }

    return result;
  }

  // ---- Dependency system ----

  /**
   * Check if all depends_on targets for an envelope are complete.
   * Returns true if no deps or all deps are complete/archived.
   * Fails open (returns true) on errors.
   *
   * @param {object} envelope - Envelope with depends_on array
   * @returns {Promise<boolean>} True if all deps are met
   */
  async function checkDependencies(envelope) {
    const deps = envelope.depends_on;
    if (!Array.isArray(deps) || deps.length === 0) return true;
    try {
      for (const depId of deps) {
        const dep = await firestore.read(`work/${depId}`);
        if (!dep) continue; // dep not found = don't block
        if (dep.status !== 'complete' && dep.status !== 'archived') {
          return false;
        }
      }
      return true;
    } catch (e) {
      log('WARN', `checkDependencies error: ${e.message}`);
      return true; // fail open
    }
  }

  /**
   * When a Mission completes, scan for other Missions that depend on it.
   * Auto-activate those whose deps are all met.
   *
   * @param {string} completedMissionId - The mission that just completed
   */
  async function activateDependents(completedMissionId) {
    try {
      const token = await getAuthToken();
      if (!token) return;
      if (!FIRESTORE_REST_BASE) return;
      // Scan work collection for pending missions with depends_on containing completedMissionId
      const parentPath = `${FIRESTORE_REST_BASE}`;
      let nextPageToken = null;
      do {
        const url = `${parentPath}/work?pageSize=200${nextPageToken ? '&pageToken=' + nextPageToken : ''}`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) break;
        const data = await resp.json();
        for (const doc of (data.documents || [])) {
          const env = firestoreDecode(doc.fields || {});
          if (env.type !== 'M' || env.status !== 'pending') continue;
          const envDeps = env.depends_on;
          if (!Array.isArray(envDeps) || !envDeps.includes(completedMissionId)) continue;
          // Check if all deps are now met
          const allMet = await checkDependencies(env);
          if (allMet) {
            log('INFO', `Dependency met: activating mission ${env.id} (was waiting on ${completedMissionId})`);
            env.status = 'active';
            env.started_at = now();
            env.updated_at = now();
            await firestore.write(`work/${env.id}`, env);
            if (_writeHistory) {
              await _writeHistory(env.id, 'pending', 'active', 'brain', `Dependencies cleared — auto-activated`);
            }
          }
        }
        nextPageToken = data.nextPageToken;
      } while (nextPageToken);
    } catch (e) {
      log('WARN', `activateDependents error: ${e.message}`);
    }
  }

  /**
   * Suggest context promotions from a completed mission to its project.
   * When a mission completes, check for context entries that exist in the
   * mission but not in the project. Either auto-promote or write candidates
   * for dashboard approval.
   *
   * @param {object} envelope - The completed mission envelope
   */
  async function suggestContextPromotions(envelope) {
    if (!envelope.project_id || !envelope.context) return;

    try {
      const project = PROJECTS[envelope.project_id];
      if (!project) return;

      const projectContext = project.context || {};
      const missionContext = envelope.context || {};

      // Find NEW context entries in mission that aren't in project
      const newEntries = {};
      for (const [key, entry] of Object.entries(missionContext)) {
        if (!projectContext[key] && entry && typeof entry === 'object') {
          newEntries[key] = entry;
        }
      }

      if (Object.keys(newEntries).length === 0) return;

      log('INFO', `Context promotion: ${Object.keys(newEntries).length} new entries from mission ${envelope.id} for project ${envelope.project_id}`);

      const token = await getAuthToken();
      if (!token) return;
      if (!FIRESTORE_REST_BASE) return;

      if (PROJECT_PROMOTION_AUTO) {
        // Auto-promote: merge directly into project context
        const projectUrl = `${FIRESTORE_REST_BASE}/projects/${envelope.project_id}`;
        const merged = mergeContextPackets(projectContext, newEntries);
        const contextFields = {};
        for (const [k, v] of Object.entries(merged)) {
          if (v && typeof v === 'object') {
            const entryFields = {};
            if (v.kind) entryFields.kind = { stringValue: v.kind };
            if (v.ref) entryFields.ref = { stringValue: v.ref };
            if (v.name) entryFields.name = { stringValue: v.name };
            if (v.summary) entryFields.summary = { stringValue: v.summary };
            contextFields[k] = { mapValue: { fields: entryFields } };
          }
        }
        await fetch(`${projectUrl}?updateMask.fieldPaths=context`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            context: { mapValue: { fields: contextFields } },
          }}),
        });
        log('INFO', `Auto-promoted ${Object.keys(newEntries).length} context entries to project ${envelope.project_id}`);
      } else {
        // Write promotion candidates for dashboard approval
        const genId = _genId || ((prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        for (const [key, entry] of Object.entries(newEntries)) {
          const promoId = genId('promo');
          const promoUrl = `${FIRESTORE_REST_BASE}/projects/${envelope.project_id}/promotions/${promoId}`;
          await fetch(promoUrl, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: {
              key: { stringValue: key },
              entry: { mapValue: { fields: {
                ...(entry.kind ? { kind: { stringValue: entry.kind } } : {}),
                ...(entry.ref ? { ref: { stringValue: entry.ref } } : {}),
                ...(entry.name ? { name: { stringValue: entry.name } } : {}),
                ...(entry.summary ? { summary: { stringValue: entry.summary } } : {}),
              }}},
              source_mission_id: { stringValue: envelope.id },
              suggested_at: { stringValue: now() },
              status: { stringValue: 'pending' },
            }}),
          });
        }
        log('INFO', `Wrote ${Object.keys(newEntries).length} promotion candidates for project ${envelope.project_id}`);
      }
    } catch (e) {
      log('DEBUG', `Context promotion error: ${e.message}`);
    }
  }

  // ---- Public API ----

  return {
    /** Load all projects from Firestore. */
    load,

    /** Ensure projects are loaded (with periodic refresh). */
    ensureLoaded,

    /** Ensure the default project exists, return its ID. */
    ensureDefault,

    /**
     * Get a single project by ID.
     * @param {string} projectId
     * @returns {object|undefined}
     */
    get(projectId) {
      return PROJECTS[projectId];
    },

    /**
     * Get all projects as a map.
     * @returns {object}
     */
    getAll() {
      return PROJECTS;
    },

    /**
     * Get the default project ID.
     * @returns {string|null}
     */
    getDefaultId() {
      return DEFAULT_PROJECT_ID;
    },

    /**
     * Get accumulated context by traversing project parent chain.
     * @param {string} projectId
     * @returns {{ chain: Array, context: object }}
     */
    getAccumulatedContext,

    /**
     * Build project context string for agent dispatch injection.
     * @param {string} projectId
     * @param {object} [envelopeContext]
     * @param {string} [coreDir]
     * @returns {string|null}
     */
    buildContext,

    /**
     * Validate project nesting depth (throws on >4).
     * @param {string} parentId
     * @returns {boolean}
     */
    validateDepth,

    /**
     * Validate that a mission envelope has a project_id.
     * @param {object} envelope
     * @returns {object}
     */
    validateMissionProject,

    /**
     * Check for circular dependency in a graph.
     * @param {string} sourceId
     * @param {string} targetId
     * @param {object} [envelopes]
     * @returns {boolean}
     */
    hasCircularDep,

    /**
     * Check if a project's work is all complete and auto-transition.
     * @param {string} projectId
     */
    checkCompletion,

    /**
     * Check if all depends_on targets for an envelope are met.
     * @param {object} envelope
     * @returns {Promise<boolean>}
     */
    checkDependencies,

    /**
     * Activate pending missions whose dependencies just cleared.
     * @param {string} completedMissionId
     */
    activateDependents,

    /**
     * Suggest context promotions from mission to project.
     * @param {object} envelope
     */
    suggestContextPromotions,

    /**
     * Update a project in the local cache (not written to Firestore).
     * @param {string} projectId
     * @param {object} data - Fields to merge into the project
     */
    update(projectId, data) {
      if (!PROJECTS[projectId]) {
        PROJECTS[projectId] = { id: projectId, ...data };
      } else {
        Object.assign(PROJECTS[projectId], data);
      }
    },

    /**
     * Get the PROJECT_CHILDREN index.
     * @returns {object}
     */
    getChildren() {
      return PROJECT_CHILDREN;
    },
  };
}
