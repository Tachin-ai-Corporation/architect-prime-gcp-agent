// platform/work/scheduler.mjs — Responsibility cron scheduler + event triggers
// Extracted from agent-brain.mjs Phase 2A
//
// Manages cron-scheduled responsibilities (compute next fire times, periodic
// check loop) and event-triggered responsibilities (on_complete, on_deploy,
// on_failure). A schedule is matched in the responsibility's declared IANA
// `timezone` (default UTC).
//
// What runs is the shipped files (platform base + role overlays) with the agent's
// OWN store applied — its overrides and the responsibilities it created — merged by
// platform/work/responsibility-store.mjs. The store is re-read every
// contracts.responsibility_store.refresh_ms, so an agent, Prime or the dashboard
// can change a responsibility without a release or an upgrade.
//
// All Firestore/brain access uses injected dependencies — no global state.
// cronNextFire() is also exported standalone as a pure utility.

import { loadShipped, mergeResponsibilities, storeSignature, describeProvenance, DEFAULT_POLICY } from './responsibility-store.mjs';

// A responsibility "cycle in progress" (for the singleton guard) means an M mission
// that is executing or about to. Everything else — complete/failed/cancelled AND
// archived/timed_out/blocked/etc — is not blocking. Using an in-progress allowlist
// (not a terminal denylist) is fail-safe: an unrecognized status never wedges the
// guard. Prior bug: archived (a terminal state) fell outside the denylist and was
// treated as in-progress, so a fresh fire was refused against archived history.
const RESP_IN_PROGRESS = new Set(['active', 'queued', 'pending', 'waiting']);

// How far ahead cronNextFire looks for the next slot. It was 48h — shorter than a
// week — so every WEEKLY responsibility re-armed to null after its first fire or
// skip, and the tick loop skipped a null next-fire forever: r-weekly-exec-update
// fired once after a restart and then never again (its 2026-09-24 slot passed
// silently while the daily consolidation beside it fired every morning). 8 days
// covers weekly with a day of margin; a longer cadence (monthly) that starts
// outside the horizon is armed by the tick loop's re-arm as it comes into range.
const NEXT_FIRE_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

// How often the tick loop retries arming a null next-fire. Far below the horizon,
// so any slot is armed at least (horizon − interval) before it is due, while a
// cron that never matches (the Feb-31 event-only idiom) rescans at most hourly.
const REARM_INTERVAL_MS = 60 * 60 * 1000;

// ---- Cron expression helpers (pure functions) ----

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const _zoneFormatters = new Map(); // IANA zone → Intl.DateTimeFormat (construction is the slow part)

/**
 * The wall-clock fields a cron expression is matched against, read in `timeZone`.
 * UTC (the default) uses the Date's UTC getters directly. Any other IANA zone goes
 * through Intl, so a DST change moves the UTC instant and leaves the declared local
 * time where it was. An unknown zone throws a RangeError — this does not guess.
 *
 * @param {Date} date
 * @param {string} [timeZone='UTC']
 * @returns {{min:number, hour:number, dom:number, mon:number, dow:number}} dow 0=Sun
 */
function wallClock(date, timeZone) {
  if (!timeZone || timeZone === 'UTC') {
    return {
      min: date.getUTCMinutes(), hour: date.getUTCHours(), dom: date.getUTCDate(),
      mon: date.getUTCMonth() + 1, dow: date.getUTCDay(),
    };
  }
  let fmt = _zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    _zoneFormatters.set(timeZone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return { min: +p.minute, hour: +p.hour, dom: +p.day, mon: +p.month, dow: WEEKDAY[p.weekday] };
}

/**
 * Check whether a 5-field cron expression matches a given Date.
 * Fields: minute hour day-of-month month day-of-week — read in `timeZone`.
 *
 * @param {string} expression - Standard 5-field cron expression
 * @param {Date} date - Date to check against
 * @param {string} [timeZone='UTC'] - IANA zone the expression is written in
 * @returns {boolean} True if the expression matches the date
 */
export function cronMatch(expression, date, timeZone) {
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = expression.trim().split(/\s+/);
  const { min, hour, dom, mon, dow } = wallClock(date, timeZone);

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
 * minute-by-minute from `from` (max NEXT_FIRE_HORIZON_MS — 8 days).
 *
 * Pure function — no side effects, no dependencies.
 *
 * @param {string} expression - Standard 5-field cron expression
 * @param {string} [timeZone='UTC'] - IANA zone the expression is written in
 * @param {Date} [from=new Date()] - The scan starts at the minute after this instant
 * @returns {Date|null} Next matching Date, or null if none within the horizon
 */
export function cronNextFire(expression, timeZone, from = new Date()) {
  const check = new Date(from);
  check.setUTCSeconds(0, 0);
  check.setUTCMinutes(check.getUTCMinutes() + 1); // start from next minute
  while (check.getTime() - from.getTime() < NEXT_FIRE_HORIZON_MS) {
    if (cronMatch(expression, check, timeZone)) return check;
    check.setUTCMinutes(check.getUTCMinutes() + 1);
  }
  return null; // no match within the horizon — the tick loop re-arms (see REARM_INTERVAL_MS)
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
 * @param {function} [deps.getProcess]             - async (id) => playbook|null — resolves a responsibility's processRef
 * @param {function} [deps.loadStore]              - async () => docs[] — the agent's own responsibility store; throws when unreadable
 * @param {object}   [deps.policy]                 - resolved contracts.responsibility_store (refresh_ms, min_interval_minutes, max_per_agent)
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
    getProcess,
    getDefaultProjectId,
    loadStore,
    policy = DEFAULT_POLICY,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[scheduler] ${level}: ${msg}`));

  const {
    coreDir = '/opt/corekit',
    primeId,
    agentId,
    agentEmail = '',
    gcpProject,
  } = config;

  // ---- Internal state ----
  let RESPONSIBILITIES = [];
  const _respLastFired = {};  // id → timestamp (ms)
  let _respNextFire = {};     // id → Date, or null = no slot within the horizon yet
  const _respRearmAt = {};    // id → ms of the last attempt to arm a null next-fire
  const _badZoneWarned = new Set();
  let _intervalId = null;

  let _shipped = [];          // the shipped files, as loadShipped() read them
  let _storeDocs = [];        // the agent's own store, as last read successfully
  let _storeSig = '';
  let _storeCheckedAt = -Infinity;
  let _storeWarnedAt = -Infinity;
  const _issuesLogged = new Set();
  let _armed = false;         // start() has run — changes re-arm from then on
  const _armedSig = {};       // id → the schedule signature its current slot was armed for

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * The zone a responsibility's schedule is written in. The v2 contract declares
   * `timezone` ("explicit, because DST silently shifts a fire time") and the
   * compiler carries it, but this scheduler used to ignore it and match every cron
   * in UTC. An unknown zone falls back to UTC LOUDLY: it must not throw inside the
   * tick loop, and silently never firing is the failure this module keeps finding.
   */
  function zoneFor(r) {
    const tz = r.timezone || 'UTC';
    if (tz === 'UTC') return tz;
    try {
      wallClock(new Date(0), tz); // validates the zone (and caches its formatter)
      return tz;
    } catch {
      if (!_badZoneWarned.has(r.id)) {
        _badZoneWarned.add(r.id);
        log('WARN', `Responsibility ${r.id}: unknown timezone '${tz}' — scheduling it in UTC`);
      }
      return 'UTC';
    }
  }

  /** Next fire for a loaded responsibility, in its own zone. */
  function nextFireFor(r, from = new Date()) {
    return cronNextFire(r.schedule, zoneFor(r), from);
  }

  // ---- Responsibility loading ----

  /** What a responsibility's armed slot depends on — a change to any of it re-arms. */
  function armSignature(r) {
    return `${Boolean(r.enabled)}|${r.schedule || ''}|${r.timezone || 'UTC'}`;
  }

  function armOne(r, now_) {
    _armedSig[r.id] = armSignature(r);
    if (r.enabled && r.schedule) {
      _respNextFire[r.id] = nextFireFor(r, now_);
      const nextStr = _respNextFire[r.id]
        ? _respNextFire[r.id].toISOString()
        : 'none within 8d (re-armed automatically as it comes into range)';
      log('INFO', `Responsibility ${r.id}: next fire ${nextStr} (${r.schedule} ${zoneFor(r)}) — ${describeProvenance(r)}`);
    } else {
      delete _respNextFire[r.id];
    }
  }

  /**
   * Swap in a new effective set. Before start() nothing is armed, so this only
   * records it. After start(), ONLY the responsibilities whose schedule, zone or
   * enabled flag changed are re-armed: a full re-arm computes every next fire from
   * "now", which silently drops any slot that came due in the seconds before the
   * next tick — once a minute, the store refresh would make that a real loss.
   */
  function applyEffective(next, now_) {
    RESPONSIBILITIES = next;
    if (!_armed) return;
    const ids = new Set(next.map((r) => r.id));
    for (const r of next) {
      if (_armedSig[r.id] !== armSignature(r)) armOne(r, now_);
    }
    for (const id of Object.keys(_armedSig)) {
      if (ids.has(id)) continue;
      delete _armedSig[id];
      delete _respNextFire[id];
      log('INFO', `Responsibility ${id}: no longer defined — unscheduled`);
    }
  }

  function recompute(now_) {
    const { effective, issues } = mergeResponsibilities(_shipped, _storeDocs, { policy, nextFire: cronNextFire });
    for (const issue of issues) {
      const key = `${issue.id}:${issue.reason}`;
      if (_issuesLogged.has(key)) continue;
      _issuesLogged.add(key);
      log('WARN', `Responsibility ${issue.id}: ${issue.reason}`);
    }
    applyEffective(effective, now_);
  }

  /**
   * Load the shipped responsibilities from disk and re-apply the agent's store.
   * Reads corekit/responsibilities.json (platform base) first, then every
   * corekit/responsibilities-*.json overlay (job, operator, role) sorted for
   * determinism, merging by ID (first-seen wins, so the base stays authoritative)
   * — see loadShipped(). The old code hardcoded only responsibilities.json +
   * responsibilities-job.json, which silently dropped operator/role overlays.
   *
   * @returns {Array<object>} The effective responsibilities
   */
  function loadResponsibilities() {
    _shipped = loadShipped(coreDir, {
      onError: (file, e) => log('WARN', `Responsibility file ${file} unreadable: ${e.message}`),
    });
    recompute(new Date());
    if (RESPONSIBILITIES.length > 0) {
      log('INFO', `Responsibilities loaded: ${RESPONSIBILITIES.map(r => r.id).join(', ')}`);
    }
    return RESPONSIBILITIES;
  }

  /**
   * Re-read the agent's own store and apply it if it changed. Throttled to
   * policy.refresh_ms. An unreadable store keeps the last good set: an outage must
   * never read as "the agent has no responsibilities of its own".
   *
   * @param {Date} [now_=new Date()]
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<boolean>} true when the effective set changed
   */
  async function refreshStore(now_ = new Date(), { force = false } = {}) {
    if (!loadStore) return false;
    if (!force && now_.getTime() - _storeCheckedAt < policy.refresh_ms) return false;
    _storeCheckedAt = now_.getTime();
    let docs;
    try {
      docs = (await loadStore()) || [];
    } catch (e) {
      if (now_.getTime() - _storeWarnedAt > 15 * 60_000) {
        _storeWarnedAt = now_.getTime();
        log('WARN', `Responsibility store unreadable (${e.message}) — keeping the last good set (${_storeDocs.length} record(s))`);
      }
      return false;
    }
    const sig = storeSignature(docs);
    if (sig === _storeSig) return false;
    _storeSig = sig;
    _storeDocs = docs;
    log('INFO', `Responsibility store changed — ${docs.length} record(s): ${sig || 'none'}`);
    recompute(now_);
    return true;
  }

  // ---- Fire a single responsibility ----

  /**
   * Fire a single responsibility — creates R→M envelope hierarchy and
   * dispatches the mission through processEnvelope (the Cortex loop). A linked
   * process playbook, if any, is recalled as planning context — not executed as steps.
   *
   * @param {object} resp - Responsibility definition
   */
  async function fireResponsibility(resp) {
    // Build rich context summary from the responsibility definition
    const contextParts = [];
    if (resp.context?.purpose) contextParts.push(`PURPOSE: ${resp.context.purpose}`);
    if (resp.context?.process?.length) {
      contextParts.push(`PROCESS:\n${resp.context.process.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    }
    // processRef — the playbook this responsibility follows. Documented as "the playbook the fired
    // mission recalls", but read by nothing until now: the mission saw only context.process, and any
    // playbook recall was left to a model's keyword match. Resolved here, deterministically (C-4), and
    // carried as the mission's planning PRIOR — a narrative the agent adapts, never steps (C-15/C-28).
    // Best-effort: a missing or retired playbook degrades to context.process alone, loudly.
    let playbookId = null;
    if (resp.processRef && getProcess) {
      let playbook = null;
      try { playbook = await getProcess(resp.processRef); } catch { playbook = null; }
      if (playbook?.narrative && playbook.status !== 'deprecated') {
        playbookId = resp.processRef;
        contextParts.push(`PLAYBOOK — ${playbook.name || playbookId} (${playbookId}): ${playbook.narrative}`);
      } else {
        log('WARN', `Responsibility ${resp.id}: processRef '${resp.processRef}' not found, retired, or without a narrative — firing on context.process alone`);
      }
    }
    if (resp.context?.reference_files?.length) {
      contextParts.push(`REFERENCE FILES: ${resp.context.reference_files.join(', ')}`);
    }
    // Top-level first, like accept_criteria below. This line printed
    // resp.context.success_criteria unconditionally — "SUCCESS CRITERIA: undefined"
    // for every responsibility that declares the field where the contract puts it.
    if ((resp.success_criteria ?? resp.context?.success_criteria)) {
      contextParts.push(`SUCCESS CRITERIA: ${(resp.success_criteria ?? resp.context?.success_criteria)}`);
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
    // Memory boundary: a memory-scoped responsibility (the nightly consolidation) fires a mission
    // that writes ONLY the memory layers. Stamped on source_meta, where the checkpoint executor
    // enforces it (platform/work/memory-scope.mjs); stated here so the plan never needs the fence.
    const memoryScoped = resp.effect_scope === 'memory';
    if (memoryScoped) {
      contextParts.push('EFFECT SCOPE: memory — this mission writes only the agent\'s memory (working memory, '
        + 'Core Memory, Deep Truths), all of it by temporal-memory. Processes, projects, skills and '
        + 'responsibilities are read as context and never written.');
    }
    const scopeMeta = memoryScoped ? { effect_scope: 'memory' } : {};
    // C-32: the work records exactly which definition produced it — a shipped
    // default, an override, or the agent's own record, at which store revision.
    const prov = resp._provenance;
    if (prov) {
      scopeMeta.responsibility_origin = prov.origin;
      if (prov.revision != null) scopeMeta.responsibility_revision = prov.revision;
    }
    // Carried back into the completion event so fireEvent can refuse to chain.
    if (resp._firedByEvent) scopeMeta.fired_by_event = resp._firedByEvent;
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
      accept_criteria: (resp.success_criteria ?? resp.context?.success_criteria) || null,
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
        ...scopeMeta,
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
      accept_criteria: (resp.success_criteria ?? resp.context?.success_criteria) || null,
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
        ...scopeMeta,
        ...(playbookId ? { process_ref: playbookId } : {}),
      },
      // The playbook it followed, for the post-mission lesson reflex (checkpoint_plan merges its own matches in).
      ...(playbookId ? { recalled_processes: [playbookId] } : {}),
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
        const nonTerminal = active.filter(e => e.type === 'M' && RESP_IN_PROGRESS.has(e.status));
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
    if (resp.enabled && resp.schedule) _respNextFire[id] = nextFireFor(resp);
    log('INFO', `[TELEMETRY] responsibility_triggered id=${id} source=${source} bypass_spacing=${bypassSpacing === true}`);

    // Fire-and-forget — the mission runs in the background.
    fireResponsibility(resp).catch(e => log('ERROR', `fireById ${id} fire failed: ${e.message}`));
    return { ok: true, id, name: resp.name || id, fired_at: now() };
  }

  // ---- Scheduler start/stop ----

  /**
   * Start the responsibility scheduler. Computes initial next-fire times
   * and begins a 60-second interval that runs tick().
   *
   * @param {Date} [now_=new Date()] - The instant next-fires are computed from
   */
  function start(now_ = new Date()) {
    // Arm everything known now. It used to return early when nothing was
    // configured — harmless while the only source was installed files, fatal once an
    // agent can create its first responsibility at runtime: the loop that would
    // fire it never started.
    _armed = true;
    for (const r of RESPONSIBILITIES) armOne(r, now_);
    if (RESPONSIBILITIES.length === 0) {
      log('INFO', 'No responsibilities yet — the scheduler keeps checking the agent\'s store');
    }
    // The agent's own store, read now rather than a minute from now, so its
    // responsibilities are armed as soon as the brain is up.
    refreshStore(now_, { force: true }).catch((e) => log('WARN', `Responsibility store refresh failed: ${e.message}`));

    // Check every 60 seconds
    if (_intervalId) clearInterval(_intervalId);
    _intervalId = setInterval(() => {
      tick().catch(e => log('ERROR', `Scheduler tick failed: ${e.message}`));
    }, 60_000);
  }

  /**
   * One scheduler pass: fire every responsibility whose next slot has arrived.
   * start() runs it every 60s; tests drive it directly with a fixed clock.
   *
   * @param {Date} [now_=new Date()]
   */
  async function tick(now_ = new Date()) {
    await refreshStore(now_);
    for (const r of RESPONSIBILITIES) {
      if (!r.enabled || !r.schedule) continue;
      let nextFire = _respNextFire[r.id];
      if (!nextFire) {
        // null means "no slot within the horizon when last computed", NOT "never".
        // This loop used to `continue` on null forever, so a weekly responsibility
        // fired once after a restart and then went dormant. Re-arm it — throttled,
        // so a cron that truly never matches does not rescan every minute.
        if (now_.getTime() - (_respRearmAt[r.id] || 0) < REARM_INTERVAL_MS) continue;
        _respRearmAt[r.id] = now_.getTime();
        nextFire = _respNextFire[r.id] = nextFireFor(r, now_);
        if (!nextFire) continue;
      }
      if (now_ < nextFire) continue;

      // Min spacing check
      const lastFired = _respLastFired[r.id];
      const minSpacingMs = (r.min_spacing_minutes || 15) * 60 * 1000;
      if (lastFired && (now_.getTime() - lastFired) < minSpacingMs) {
        log('INFO', `Responsibility ${r.id} skipped (min spacing ${r.min_spacing_minutes}m)`);
        _respNextFire[r.id] = nextFireFor(r, now_);
        continue;
      }

      // Singleton check: skip if non-terminal mission already exists for this responsibility
      if (r.singleton && firestoreQuery) {
        try {
          const active = await firestoreQuery('work', [
            { field: 'source_meta.responsibility_id', op: 'EQUAL', value: { stringValue: r.id } },
          ], { noOrderBy: true });
          const nonTerminal = active.filter(e => e.type === 'M' && RESP_IN_PROGRESS.has(e.status));
          if (nonTerminal.length > 0) {
            log('INFO', `Responsibility ${r.id}: singleton guard — cycle in progress (${nonTerminal[0].id}), sleeping`);
            _respNextFire[r.id] = nextFireFor(r, now_);
            continue;
          }
        } catch (e) {
          log('WARN', `Responsibility ${r.id}: singleton check failed (${e.message}), proceeding with fire`);
        }
      }

      // Fire!
      log('INFO', `Responsibility ${r.id} firing: ${r.name}`);
      _respLastFired[r.id] = now_.getTime();
      _respNextFire[r.id] = nextFireFor(r, now_);

      try {
        await fireResponsibility(r);
      } catch (e) {
        log('ERROR', `Responsibility ${r.id} fire failed: ${e.message}`);
      }
    }
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
   * Recalculate every next-fire time from `now_`. loadResponsibilities() already
   * re-arms exactly what changed; this full recompute stays for callers that want
   * it and drops any slot that came due since the last tick.
   */
  function recalcNextFires(now_ = new Date()) {
    _respNextFire = {};
    for (const r of RESPONSIBILITIES) {
      _armedSig[r.id] = armSignature(r);
      if (r.enabled && r.schedule) _respNextFire[r.id] = nextFireFor(r, now_);
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

    // The effective set — the same one the clock fires from. This re-read only the
    // platform base file, so an event responsibility in a role overlay, or one an
    // agent created for itself, could never fire.
    const eventResps = RESPONSIBILITIES;

    const matching = eventResps.filter(r => {
      if (!r.enabled) return false;
      // v2: `event` is a name. This compared `trigger` — an OBJECT in the v1
      // schema — to an event-name string, so it was never true for a
      // registry-authored responsibility.
      if (!r.event) return false;
      return r.event === eventType;
    });

    if (matching.length === 0) return;
    // No event chains. A mission an EVENT responsibility produced never fires another
    // event responsibility, and no responsibility fires from its own mission: once an
    // agent can write an `on_complete` responsibility for itself, either of those is a
    // loop that runs a mission on every completion, forever.
    if (eventContext.fired_by_event) {
      log('INFO', `Event '${eventType}' from an event-fired mission (${eventContext.mission_id || '?'}) — not chaining`);
      return;
    }
    log('INFO', `Event '${eventType}' triggered — ${matching.length} matching responsibilities`);

    for (const resp of matching) {
      try {
        if (eventContext.responsibility_id === resp.id) continue;
        // Spacing, with the store's floor. This read `resp._lastFired`, a field nothing
        // ever set, so an event responsibility had no spacing at all.
        const spacingMin = Math.max(resp.min_spacing_minutes || 0, policy.min_interval_minutes || 0);
        const lastFired = _respLastFired[resp.id];
        if (lastFired && (Date.now() - lastFired) < spacingMin * 60_000) {
          log('INFO', `Event resp ${resp.id}: skipping (${Math.round((Date.now() - lastFired) / 60_000)}m since last, min ${spacingMin}m)`);
          continue;
        }
        _respLastFired[resp.id] = Date.now();

        // Inject event context into instruction
        let instruction = resp.instruction || '';
        if (eventContext.mission_id) {
          instruction += `\n\nTriggered by event: ${eventType} (mission: ${eventContext.mission_id})`;
        }
        if (eventContext.project_id) {
          instruction += `\nProject: ${eventContext.project_id}`;
        }

        const eventResp = { ...resp, instruction, _firedByEvent: eventType };
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
    /** One scheduler pass at a given instant (the interval's body; tests drive it). */
    tick,
    /** Stop the cron scheduler. */
    stop,
    /** Fire event-triggered responsibilities. */
    fireEvent,
    /** Fire a responsibility on demand by id (operator "Run now" / agent request). */
    fireById,
    /** Recalculate next-fire times (after config hot-reload). */
    recalcNextFires,
    /** Re-read the agent's own store now (throttled unless forced); resolves true when the set changed. */
    refreshStore,
    /** Get the current effective responsibilities array (shipped + the agent's store). */
    getResponsibilities: () => [...RESPONSIBILITIES],
    /** Get internal next-fire map (for diagnostics). */
    getNextFires: () => ({ ..._respNextFire }),
  };
}
