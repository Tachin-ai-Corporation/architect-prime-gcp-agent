// corekit/lib/scheduler.mjs — Responsibility cron scheduler + event triggers
// Extracted from agent-brain.mjs Phase 2A
//
// Manages cron-scheduled responsibilities (load from disk JSON, compute next
// fire times, periodic check loop) and event-triggered responsibilities
// (on_complete, on_deploy, on_failure).
//
// All Firestore/brain access uses injected dependencies — no global state.
// cronNextFire() is also exported standalone as a pure utility.

import { readFileSync, existsSync } from 'fs';

// ---- Cron expression helpers (pure functions) ----

/**
 * Check whether a 5-field cron expression matches a given Date (UTC).
 * Fields: minute hour day-of-month month day-of-week
 *
 * @param {string} expression - Standard 5-field cron expression
 * @param {Date} date - Date to check against (uses UTC components)
 * @returns {boolean} True if the expression matches the date
 */
export function cronMatch(expression, date) {
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = expression.trim().split(/\s+/);
  const min = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const dow = date.getUTCDay(); // 0=Sun

  return fieldMatches(minExpr, min, 0, 59)
    && fieldMatches(hourExpr, hour, 0, 23)
    && fieldMatches(domExpr, dom, 1, 31)
    && fieldMatches(monExpr, mon, 1, 12)
    && fieldMatches(dowExpr, dow, 0, 6);
}

/**
 * Check whether a single cron field expression matches a value.
 * Supports: * (any), *\/N (step), comma-separated, and ranges (lo-hi).
 *
 * @param {string} expr - Cron field expression (e.g. '*', '*\/5', '1,5,10', '1-5')
 * @param {number} value - Actual value to check
 * @param {number} _rangeMin - Minimum valid value (unused, kept for clarity)
 * @param {number} _rangeMax - Maximum valid value (unused, kept for clarity)
 * @returns {boolean} True if the expression matches the value
 */
export function fieldMatches(expr, value, _rangeMin, _rangeMax) {
  if (expr === '*') return true;
  // */N step
  if (expr.startsWith('*/')) {
    const step = parseInt(expr.slice(2), 10);
    return value % step === 0;
  }
  // Comma-separated values: 1,5,10
  const parts = expr.split(',');
  for (const part of parts) {
    // Range: 1-5
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

/**
 * Calculate the next fire time for a cron expression by scanning forward
 * minute-by-minute from now (max 48 hours).
 *
 * Pure function — no side effects, no dependencies.
 *
 * @param {string} expression - Standard 5-field cron expression
 * @returns {Date|null} Next matching Date, or null if none within 48h
 */
export function cronNextFire(expression) {
  const now_ = new Date();
  const check = new Date(now_);
  check.setUTCSeconds(0, 0);
  check.setUTCMinutes(check.getUTCMinutes() + 1); // start from next minute
  const maxMs = 48 * 60 * 60 * 1000;
  while (check.getTime() - now_.getTime() < maxMs) {
    if (cronMatch(expression, check)) return check;
    check.setUTCMinutes(check.getUTCMinutes() + 1);
  }
  return null; // no match within 48h
}

/**
 * Create a responsibility scheduler instance.
 *
 * @param {object} deps
 * @param {function} deps.logger                   - (level, msg) logging function
 * @param {object}   deps.config
 * @param {string}   deps.config.coreDir           - e.g. '/opt/corekit'
 * @param {string}   deps.config.primeId           - e.g. 'chuck'
 * @param {string}   deps.config.agentId           - e.g. 'stan'
 * @param {string}   [deps.config.agentEmail]      - e.g. 'stan@...'
 * @param {string}   [deps.config.gcpProject]      - GCP project ID
 * @param {function} deps.processEnvelope          - async (envelope, memory) => void — brain's main processing entry
 * @param {function} deps.generateId               - (prefix) => string
 * @param {function} deps.writeHistory             - async (envelopeId, prevStatus, newStatus, actor, detail) => void
 * @param {function} deps.recallMemory             - async (query, ctx) => memory
 * @param {function} deps.firestoreWrite           - async (collection, docId, data) => result
 * @param {function} [deps.firestoreQuery]          - async (collection, filters) => docs[] — for singleton check
 * @param {function} deps.ensureProcessesLoaded    - async () => void
 * @param {function} deps.getProcesses             - () => object — returns current PROCESSES map
 * @param {function} deps.processToCheckpointPlan  - (process, parameters) => plan|null
 * @param {function} deps.getDefaultProjectId      - () => string|null
 * @returns {object} Scheduler API
 */
export function createScheduler(deps) {
  const {
    config,
    processEnvelope,
    generateId,
    writeHistory,
    recallMemory,
    firestoreWrite,
    firestoreRead,
    firestoreQuery,
    ensureProcessesLoaded,
    getProcesses,
    processToCheckpointPlan,
    getDefaultProjectId,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[scheduler] ${level}: ${msg}`));

  const {
    coreDir = '/opt/corekit',
    primeId,
    agentId,
    agentEmail = '',
    gcpProject,
  } = config;

  // Firestore REST base for direct process execution count updates
  const FIRESTORE_BASE = gcpProject
    ? `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`
    : null;

  // ---- Internal state ----
  let RESPONSIBILITIES = [];
  const _respLastFired = {};  // id → timestamp (ms)
  let _respNextFire = {};     // id → Date
  let _intervalId = null;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * Import getGceToken lazily (only needed for process execution count updates).
   * @returns {Promise<string|null>}
   */
  async function getAuthToken() {
    const { getGceToken } = await import('./gce-auth.mjs');
    return getGceToken();
  }

  // ---- Responsibility loading ----

  /**
   * Load responsibilities from on-disk JSON config files.
   * Reads responsibilities.json and responsibilities-job.json, merges by ID
   * (first-seen wins).
   *
   * @returns {Array<object>} Loaded responsibilities array
   */
  function loadResponsibilities() {
    const files = [
      coreDir + '/corekit/responsibilities.json',
      coreDir + '/corekit/responsibilities-job.json',
    ];
    const merged = [];
    const seen = new Set();
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(f, 'utf8'));
        for (const r of (data.responsibilities || [])) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            merged.push(r);
          }
        }
      } catch { /* file may not exist */ }
    }
    RESPONSIBILITIES = merged;
    if (merged.length > 0) {
      log('INFO', `Responsibilities loaded: ${merged.map(r => r.id).join(', ')}`);
    }
    return merged;
  }

  // ---- Fire a single responsibility ----

  /**
   * Fire a single responsibility — creates R→M envelope hierarchy and
   * dispatches through processEnvelope.
   *
   * If the responsibility has a processRef, executes the linked process
   * deterministically. Otherwise creates a standard mission for the Cortex loop.
   *
   * @param {object} resp - Responsibility definition
   */
  async function fireResponsibility(resp) {
    // Phase 3B: If responsibility has a processRef, execute the process directly
    if (resp.processRef) {
      await ensureProcessesLoaded();
      const PROCESSES = getProcesses();
      const process = PROCESSES[resp.processRef];
      if (process) {
        log('INFO', `Responsibility ${resp.id}: executing linked process '${process.name}' v${process.version || 1}`);

        // Build parameters: merge process defaults → responsibility overrides
        const parameters = {};
        for (const [key, def] of Object.entries(process.parameters || {})) {
          if (def && typeof def === 'object' && def.default !== undefined) {
            parameters[key] = def.default;
          }
        }
        Object.assign(parameters, resp.processParameters || {});

        // Validate required parameters
        const requiredParams = Object.entries(process.parameters || {})
          .filter(([, def]) => def && typeof def === 'object' && def.required && !def.default)
          .map(([key]) => key);
        const missingParams = requiredParams.filter(k => !(k in parameters));
        if (missingParams.length > 0) {
          log('WARN', `Responsibility ${resp.id}: process '${process.name}' missing required params: ${missingParams.join(', ')} — falling through to normal mission`);
          // Fall through to normal responsibility firing below
        } else {
          // Convert process to checkpoint plan
          const cpPlan = processToCheckpointPlan(process, parameters);
          if (cpPlan) {
            // Create R envelope
            const respEnvId = generateId('w');
            const respEnvelope = {
              id: respEnvId,
              type: 'R',
              parent_id: null,
              owner: agentEmail || agentId,
              status: 'complete',
              intent: 'responsibility',
              title: resp.name || resp.id,
              instruction: resp.instruction,
              accept_criteria: resp.context?.success_criteria || null,
              context_summary: `Process: ${process.name} v${process.version || 1}`,
              output: `Responsibility ${resp.id} fired at ${now()} → process ${process.id}`,
              children: [],
              context_forward: null,
              error: null,
              source_channel: 'scheduler',
              source_meta: { responsibility_id: resp.id, responsibility_name: resp.name, schedule: resp.schedule, process_id: process.id },
              created_at: now(),
              started_at: now(),
              completed_at: now(),
              updated_at: now(),
              iteration: 0,
            };
            await firestoreWrite('work', respEnvId, respEnvelope);

            // Create M mission with process already loaded
            const missionId = generateId('w');
            const DEFAULT_PROJECT_ID = getDefaultProjectId();
            const missionEnvelope = {
              id: missionId,
              type: 'M',
              parent_id: respEnvId,
              owner: agentEmail || agentId,
              status: 'active',
              intent: 'execute',
              title: `Execute: ${resp.name || resp.id}`,
              instruction: resp.instruction,
              accept_criteria: resp.context?.success_criteria || null,
              context_summary: `Executing process: ${process.name}`,
              output: null,
              children: [],
              context_forward: null,
              error: null,
              source_channel: 'scheduler',
              source_meta: { responsibility_id: resp.id, responsibility_name: resp.name, fired_at: now(), process_id: process.id },
              process_id: process.id,
              process_version: process.version || 1,
              project_id: resp.project_id || DEFAULT_PROJECT_ID,
              created_at: now(),
              started_at: now(),
              completed_at: null,
              updated_at: now(),
              iteration: 0,
              delivery_status: 'internal',
              memory_context: null,
            };

            // Merge process context template
            if (process.contextTemplate && typeof process.contextTemplate === 'object') {
              const templateCtx = {};
              for (const [key, entry] of Object.entries(process.contextTemplate)) {
                if (entry && typeof entry === 'object') {
                  const processed = { ...entry };
                  if (processed.name) processed.name = processed.name.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
                  if (processed.summary) processed.summary = processed.summary.replace(/\$\{(\w+)\}|\{\{(\w+)\}\}/g, (_, a, b) => parameters[a || b] || '');
                  templateCtx[key] = processed;
                }
              }
              missionEnvelope.context = templateCtx;
            }

            respEnvelope.children.push(missionId);
            await firestoreWrite('work', respEnvId, respEnvelope);
            await firestoreWrite('work', missionId, missionEnvelope);
            await writeHistory(missionId, null, 'active', 'scheduler', `Process ${process.id} from responsibility ${resp.id}`);

            // Increment process execution count
            try {
              const token = await getAuthToken();
              if (token && FIRESTORE_BASE) {
                const procUrl = `${FIRESTORE_BASE}/processes/${process.id}`;
                const currentCount = process.execution_count || 0;
                await fetch(procUrl + '?updateMask.fieldPaths=execution_count&updateMask.fieldPaths=last_executed_at', {
                  method: 'PATCH',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ fields: {
                    execution_count: { integerValue: String(currentCount + 1) },
                    last_executed_at: { stringValue: now() },
                  }}),
                });
              }
            } catch (e) { log('DEBUG', `Process execution count update failed: ${e.message}`); }

            // Recall memory then execute the checkpoint plan directly
            const memory = await recallMemory(resp.instruction, {
              instruction: resp.instruction,
              context_summary: `Process: ${process.name}`,
            });
            missionEnvelope.memory_context = memory;
            await firestoreWrite('work', missionId, missionEnvelope);
            await processEnvelope(missionEnvelope, memory);

            log('INFO', `Responsibility ${resp.id} → process ${process.id} execution started`);
            return;
          }
        }
      } else {
        log('WARN', `Responsibility ${resp.id}: processRef '${resp.processRef}' not found, falling through to normal mission`);
      }
    }

    // Build rich context summary from the responsibility definition
    const contextParts = [];
    if (resp.context?.purpose) contextParts.push(`PURPOSE: ${resp.context.purpose}`);
    if (resp.context?.process?.length) {
      contextParts.push(`PROCESS:\n${resp.context.process.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    }
    if (resp.context?.reference_files?.length) {
      contextParts.push(`REFERENCE FILES: ${resp.context.reference_files.join(', ')}`);
    }
    if (resp.context?.success_criteria) {
      contextParts.push(`SUCCESS CRITERIA: ${resp.context.success_criteria}`);
    }
    // SESSION_CONTEXT_PLAN Phase 3b: merge machine-fed learnings from the
    // Firestore overlay (written by completeEnvelope from compaction digests)
    // with the hand-authored config value. Config prose leads; the overlay's
    // dated FIFO lines follow. Overlay read is best-effort — a miss degrades
    // to config-only, exactly today's behavior.
    let overlayLearnings = '';
    if (firestoreRead) {
      try {
        const overlay = await firestoreRead('responsibility_state', resp.id);
        if (overlay?.prior_learnings) overlayLearnings = overlay.prior_learnings;
      } catch { /* overlay optional */ }
    }
    if (resp.context?.prior_learnings || overlayLearnings) {
      const merged = [resp.context?.prior_learnings, overlayLearnings].filter(Boolean).join('\n');
      contextParts.push(`PRIOR LEARNINGS: ${merged}`);
    }
    const contextSummary = contextParts.join('\n\n');

    // Create type=R Responsibility envelope
    const respEnvId = generateId('w');
    const respEnvelope = {
      id: respEnvId,
      type: 'R',
      parent_id: null,
      owner: agentEmail || agentId,
      status: 'complete', // R is just a container, mark complete immediately
      intent: 'responsibility',
      title: resp.name || resp.id,
      instruction: resp.instruction,
      accept_criteria: resp.context?.success_criteria || null,
      context_summary: contextSummary,
      output: `Responsibility ${resp.id} fired at ${now()}`,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'scheduler',
      source_meta: {
        responsibility_id: resp.id,
        responsibility_name: resp.name,
        schedule: resp.schedule,
      },
      created_at: now(),
      started_at: now(),
      completed_at: now(),
      updated_at: now(),
      iteration: 0,
    };

    await firestoreWrite('work', respEnvId, respEnvelope);
    await writeHistory(respEnvId, null, 'complete', 'scheduler', `Responsibility ${resp.id} fired`);

    // Create type=M Mission child — this enters the normal Cortex loop
    const missionId = generateId('w');
    const DEFAULT_PROJECT_ID = getDefaultProjectId();
    const missionEnvelope = {
      id: missionId,
      type: 'M',
      parent_id: respEnvId,
      owner: agentEmail || agentId,
      status: 'pending',
      intent: 'execute',
      title: `Execute: ${resp.name || resp.id}`,
      instruction: resp.instruction,
      accept_criteria: resp.context?.success_criteria || null,
      context_summary: contextSummary,
      output: null,
      children: [],
      context_forward: null,
      error: null,
      source_channel: 'scheduler',
      source_meta: {
        responsibility_id: resp.id,
        responsibility_name: resp.name,
        fired_at: now(),
      },
      project_id: resp.project_id || DEFAULT_PROJECT_ID,
      created_at: now(),
      started_at: null,
      completed_at: null,
      updated_at: now(),
      iteration: 0,
      memory_context: null, // Will be recalled during processEnvelope
    };

    // Track child on R envelope
    respEnvelope.children.push(missionId);
    await firestoreWrite('work', respEnvId, respEnvelope);

    await firestoreWrite('work', missionId, missionEnvelope);
    await writeHistory(missionId, null, 'pending', 'scheduler', `Mission from responsibility ${resp.id}`);
    log('INFO', `Created R:${respEnvId} → M:${missionId} for responsibility ${resp.id}`);

    // Recall memory with rich context, then process
    const memory = await recallMemory(resp.instruction, {
      instruction: resp.instruction,
      context_summary: contextSummary.substring(0, 500),
    });
    missionEnvelope.memory_context = memory;
    await firestoreWrite('work', missionId, missionEnvelope);

    // Process the mission through the normal Cortex loop
    await processEnvelope(missionEnvelope, memory);
  }

  // ---- On-demand trigger ----

  /**
   * Fire a responsibility on demand, by id — the deliberate out-of-turn entry
   * point (operator "Run now" or an agent honoring a user request). Reuses the
   * same fireResponsibility() engine as the cron loop; differs only in how it
   * treats the guards:
   *
   *   - Singleton is ALWAYS enforced (never two concurrent cycles — a second
   *     consolidation over the same memory would corrupt it).
   *   - min_spacing is honored unless opts.bypassSpacing (on-demand callers
   *     pass true — running "out of turn" is the whole point).
   *   - A disabled responsibility is refused unless opts.force.
   *
   * Dispatch is fire-and-forget: fireResponsibility() runs the whole mission,
   * so we start it detached and return immediately — neither the agent's decide
   * loop nor the operator poll blocks for the minutes a cycle takes. Callers
   * observe the running mission via source_meta.responsibility_id.
   *
   * @param {string} id - Responsibility id
   * @param {object} [opts]
   * @param {boolean} [opts.bypassSpacing=false] - Skip the min_spacing guard
   * @param {boolean} [opts.force=false]         - Fire even if disabled
   * @param {string}  [opts.source='ondemand']   - Telemetry label (agent|operator|…)
   * @returns {Promise<{ok:boolean, id?:string, name?:string, fired_at?:string, skipped?:boolean, error?:string}>}
   */
  async function fireById(id, opts = {}) {
    const { bypassSpacing = false, force = false, source = 'ondemand' } = opts;
    const resp = RESPONSIBILITIES.find(r => r.id === id);
    if (!resp) return { ok: false, error: `responsibility '${id}' not found` };
    if (resp.enabled === false && !force) {
      return { ok: false, error: `responsibility '${id}' is disabled` };
    }

    // Singleton — always enforced. Skip if a non-terminal mission already
    // exists for this responsibility (mirrors the cron loop's guard).
    if (resp.singleton && firestoreQuery) {
      try {
        // noOrderBy: a single-field EQUAL avoids the composite index that a
        // default created_at ordering would require (mirrors dequeueAndProcess).
        const active = await firestoreQuery('work', [
          { field: 'source_meta.responsibility_id', op: 'EQUAL', value: { stringValue: id } },
        ], { noOrderBy: true });
        const nonTerminal = active.filter(e => e.status !== 'complete' && e.status !== 'failed' && e.status !== 'cancelled');
        if (nonTerminal.length > 0) {
          log('INFO', `fireById ${id}: singleton guard — cycle in progress (${nonTerminal[0].id}), refusing`);
          return { ok: false, skipped: true, error: `a cycle is already in progress (${nonTerminal[0].id})` };
        }
      } catch (e) {
        log('WARN', `fireById ${id}: singleton check failed (${e.message}), proceeding`);
      }
    }

    // Min-spacing — honored unless explicitly bypassed.
    if (!bypassSpacing) {
      const lastFired = _respLastFired[id];
      const minSpacingMs = (resp.min_spacing_minutes || 15) * 60 * 1000;
      if (lastFired && (Date.now() - lastFired) < minSpacingMs) {
        return { ok: false, skipped: true, error: `min spacing (${resp.min_spacing_minutes}m) not elapsed` };
      }
    }

    _respLastFired[id] = Date.now();
    // Keep the cron cadence coherent — re-arm the next scheduled fire.
    if (resp.enabled && resp.schedule) _respNextFire[id] = cronNextFire(resp.schedule);
    log('INFO', `[TELEMETRY] responsibility_triggered id=${id} source=${source} bypass_spacing=${bypassSpacing === true}`);

    // Fire-and-forget — the mission runs in the background.
    fireResponsibility(resp).catch(e => log('ERROR', `fireById ${id} fire failed: ${e.message}`));
    return { ok: true, id, name: resp.name || id, fired_at: now() };
  }

  // ---- Scheduler start/stop ----

  /**
   * Start the responsibility scheduler. Computes initial next-fire times
   * and begins a 60-second interval to check for due responsibilities.
   */
  function start() {
    if (RESPONSIBILITIES.length === 0) {
      log('INFO', 'No responsibilities configured, scheduler idle');
      return;
    }

    // Calculate initial next-fire times
    for (const r of RESPONSIBILITIES) {
      if (r.enabled) {
        _respNextFire[r.id] = cronNextFire(r.schedule);
        const nextStr = _respNextFire[r.id]
          ? _respNextFire[r.id].toISOString()
          : 'none (no match in 48h)';
        log('INFO', `Responsibility ${r.id}: next fire ${nextStr}`);
      }
    }

    // Check every 60 seconds
    _intervalId = setInterval(async () => {
      const now_ = new Date();
      for (const r of RESPONSIBILITIES) {
        if (!r.enabled) continue;
        const nextFire = _respNextFire[r.id];
        if (!nextFire || now_ < nextFire) continue;

        // Min spacing check
        const lastFired = _respLastFired[r.id];
        const minSpacingMs = (r.min_spacing_minutes || 15) * 60 * 1000;
        if (lastFired && (now_.getTime() - lastFired) < minSpacingMs) {
          log('INFO', `Responsibility ${r.id} skipped (min spacing ${r.min_spacing_minutes}m)`);
          _respNextFire[r.id] = cronNextFire(r.schedule);
          continue;
        }

        // Singleton check: skip if non-terminal mission already exists for this responsibility
        if (r.singleton && firestoreQuery) {
          try {
            const active = await firestoreQuery('work', [
              { field: 'source_meta.responsibility_id', op: 'EQUAL', value: { stringValue: r.id } },
            ], { noOrderBy: true });
            const nonTerminal = active.filter(e => e.status !== 'complete' && e.status !== 'failed' && e.status !== 'cancelled');
            if (nonTerminal.length > 0) {
              log('INFO', `Responsibility ${r.id}: singleton guard — cycle in progress (${nonTerminal[0].id}), sleeping`);
              _respNextFire[r.id] = cronNextFire(r.schedule);
              continue;
            }
          } catch (e) {
            log('WARN', `Responsibility ${r.id}: singleton check failed (${e.message}), proceeding with fire`);
          }
        }

        // Fire!
        log('INFO', `Responsibility ${r.id} firing: ${r.name}`);
        _respLastFired[r.id] = now_.getTime();
        _respNextFire[r.id] = cronNextFire(r.schedule);

        try {
          await fireResponsibility(r);
        } catch (e) {
          log('ERROR', `Responsibility ${r.id} fire failed: ${e.message}`);
        }
      }
    }, 60_000);
  }

  /**
   * Stop the scheduler interval.
   */
  function stop() {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  }

  /**
   * Recalculate next-fire times after a config reload.
   * Called by the brain when watchFile detects changes.
   */
  function recalcNextFires() {
    _respNextFire = {};
    for (const r of RESPONSIBILITIES) {
      if (r.enabled) _respNextFire[r.id] = cronNextFire(r.schedule);
    }
  }

  // ---- Event-triggered responsibilities ----

  /**
   * Fire responsibilities that match a specific event trigger.
   * Scans loaded responsibilities for matching `trigger` field.
   *
   * @param {string} eventType - One of: 'on_complete', 'on_deploy', 'on_failure'
   * @param {object} [eventContext={}] - Context about the event (e.g., { mission_id, project_id })
   */
  async function fireEvent(eventType, eventContext = {}) {
    if (!eventType) return;

    let eventResps = [];
    try {
      const respFile = coreDir + '/corekit/responsibilities.json';
      if (existsSync(respFile)) {
        const parsed = JSON.parse(readFileSync(respFile, 'utf8'));
        eventResps = Array.isArray(parsed) ? parsed : (parsed.responsibilities || []);
      }
    } catch (e) {
      log('WARN', `Failed to load responsibilities for event trigger: ${e.message}`);
      return;
    }

    const matching = eventResps.filter(r => {
      if (!r.enabled) return false;
      if (!r.trigger) return false;
      return r.trigger === eventType;
    });

    if (matching.length === 0) return;
    log('INFO', `Event '${eventType}' triggered — ${matching.length} matching responsibilities`);

    for (const resp of matching) {
      try {
        // Check min_spacing
        if (resp.min_spacing_minutes && resp._lastFired) {
          const elapsed = (Date.now() - new Date(resp._lastFired).getTime()) / 60000;
          if (elapsed < resp.min_spacing_minutes) {
            log('INFO', `Event resp ${resp.id}: skipping (${elapsed.toFixed(0)}m since last, min ${resp.min_spacing_minutes}m)`);
            continue;
          }
        }

        // Inject event context into instruction
        let instruction = resp.instruction || '';
        if (eventContext.mission_id) {
          instruction += `\n\nTriggered by event: ${eventType} (mission: ${eventContext.mission_id})`;
        }
        if (eventContext.project_id) {
          instruction += `\nProject: ${eventContext.project_id}`;
        }

        const eventResp = { ...resp, instruction };
        await fireResponsibility(eventResp);
        log('INFO', `Event resp ${resp.id} fired for '${eventType}'`);
      } catch (e) {
        log('WARN', `Failed to fire event resp ${resp.id}: ${e.message}`);
      }
    }
  }

  // ---- Public API ----

  return {
    /** Load responsibility definitions from disk JSON files. */
    loadResponsibilities,
    /** Start the cron scheduler (60s check interval). */
    start,
    /** Stop the cron scheduler. */
    stop,
    /** Fire event-triggered responsibilities. */
    fireEvent,
    /** Fire a responsibility on demand by id (operator "Run now" / agent request). */
    fireById,
    /** Recalculate next-fire times (after config hot-reload). */
    recalcNextFires,
    /** Get the current loaded responsibilities array. */
    getResponsibilities: () => [...RESPONSIBILITIES],
    /** Get internal next-fire map (for diagnostics). */
    getNextFires: () => ({ ..._respNextFire }),
  };
}
