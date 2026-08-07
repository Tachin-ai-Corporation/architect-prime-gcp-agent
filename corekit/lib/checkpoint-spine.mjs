// checkpoint-spine.mjs — the pinned checkpoint skeleton of a mission
//
// A mission's checkpoint OUTCOMES are stable; its task lists are not. Across four
// observed missions the outcomes never changed (gather inputs → create and fill →
// file) while task wording and criteria churned on every failure — and because a
// failure re-derived the WHOLE plan, one run re-ran a checkpoint that had passed
// twenty seconds earlier, then blocked after 1.11M input tokens.
//
// The spine pins what is stable so a failure re-plans only what failed. Completed
// checkpoints keep their verdict; the failed one gets new tasks; untouched ones keep
// the tasks they were given. Criteria are pinned too, with ONE refinement allowed —
// evidence both ways: a mission passed only after a criterion was reworded (so allow
// one), and another reworded four times without converging (so cap it).
//
// Pure: no I/O, no clock, no randomness (B-19). The caller supplies `now`.

/** A checkpoint is complete when its milestone was verified. */
const isComplete = s => s && s.status === 'complete';

/**
 * Build the spine from a freshly structured plan.
 *
 * @param {Array<{instruction?: string, accept_criteria?: string, tasks?: Array}>} checkpoints
 * @param {Object} [opts]
 * @param {string} [opts.now] - ISO timestamp (purity: supplied, never read)
 * @returns {Array<Object>} spine entries, 1-indexed by `n`
 */
export function buildSpine(checkpoints, opts = {}) {
  const now = opts.now || '';
  return (checkpoints || []).map((cp, i) => ({
    n: i + 1,
    outcome: cp.instruction || `Checkpoint ${i + 1}`,
    accept_criteria: cp.accept_criteria || '',
    tasks: Array.isArray(cp.tasks) ? cp.tasks : [],
    // Baton model: which agent owns this checkpoint (email). Null = the mission
    // originator. Passed through from the structured plan; drives the intra-mission
    // hand-off in the executor (see corekit/lib/baton.mjs). Absent/ignored under the
    // default child-mission delegation model.
    assignee: cp.assignee || null,
    status: 'pending',
    criteria_revisions: 0,
    created_at: now,
  }));
}

/**
 * Index (0-based) of the first checkpoint not yet complete, or -1 when the whole
 * spine is done. Checkpoints run in order, so this doubles as the executor's
 * `startCpIndex` — completed work is skipped by starting past it, which is why no
 * separate skip mechanism is needed.
 *
 * @param {Array} spine
 * @returns {number}
 */
export function firstIncompleteIndex(spine) {
  if (!Array.isArray(spine)) return -1;
  const i = spine.findIndex(s => !isComplete(s));
  return i;
}

/**
 * Record a checkpoint's verdict. Called by the executor, which is the only thing
 * that knows whether a milestone actually passed.
 *
 * @param {Array} spine
 * @param {number} index - 0-based
 * @param {'complete'|'failed'} status
 * @param {Object} [opts]
 * @returns {Array} new spine (input not mutated)
 */
export function markCheckpoint(spine, index, status, opts = {}) {
  if (!Array.isArray(spine) || index < 0 || index >= spine.length) return spine || [];
  const now = opts.now || '';
  return spine.map((s, i) => (i === index
    ? { ...s, status, [status === 'complete' ? 'completed_at' : 'failed_at']: now }
    : s));
}

/**
 * Apply a scoped re-plan: swap in new tasks for one checkpoint, leaving every other
 * checkpoint — and every completed verdict — untouched.
 *
 * Criteria are pinned by default. A refinement is allowed only while
 * `criteria_revisions < maxCriteriaRevisions`; past that the pinned criteria stand
 * and `revisionRefused` is set, so the caller can log it rather than silently
 * letting the target drift for a fifth time.
 *
 * @param {Array} spine
 * @param {number} index - 0-based checkpoint being re-planned
 * @param {Array} newTasks
 * @param {Object} [opts]
 * @param {string} [opts.newCriteria] - proposed replacement criteria (optional)
 * @param {number} [opts.maxCriteriaRevisions=1]
 * @param {boolean} [opts.pinCriteria=true]
 * @param {string} [opts.now]
 * @returns {{spine: Array, criteriaChanged: boolean, revisionRefused: boolean}}
 */
export function applyReplan(spine, index, newTasks, opts = {}) {
  const maxRev = opts.maxCriteriaRevisions ?? 1;
  const pin = opts.pinCriteria !== false;
  const now = opts.now || '';
  if (!Array.isArray(spine) || index < 0 || index >= spine.length) {
    return { spine: spine || [], criteriaChanged: false, revisionRefused: false };
  }

  const target = spine[index];
  const proposed = (opts.newCriteria || '').trim();
  const differs = proposed && proposed !== (target.accept_criteria || '').trim();
  let criteriaChanged = false;
  let revisionRefused = false;
  let criteria = target.accept_criteria;
  let revisions = target.criteria_revisions || 0;

  if (differs) {
    if (!pin) {
      criteria = proposed; criteriaChanged = true;      // pinning off: always accept
    } else if (revisions < maxRev) {
      criteria = proposed; criteriaChanged = true; revisions += 1;
    } else {
      revisionRefused = true;                            // hold the pinned wording
    }
  }

  const next = spine.map((s, i) => (i === index
    ? {
      ...s,
      tasks: Array.isArray(newTasks) && newTasks.length > 0 ? newTasks : s.tasks,
      accept_criteria: criteria,
      criteria_revisions: revisions,
      status: 'pending',                                 // re-planned, so runnable again
      replanned_at: now,
    }
    : s));
  return { spine: next, criteriaChanged, revisionRefused };
}

/**
 * Turn the spine back into what the executor consumes.
 *
 * @param {Array} spine
 * @returns {{checkpoints: Array, startCpIndex: number, allComplete: boolean}}
 */
export function rebuildFromSpine(spine) {
  const s = Array.isArray(spine) ? spine : [];
  const checkpoints = s.map(e => ({
    instruction: e.outcome,
    accept_criteria: e.accept_criteria,
    tasks: Array.isArray(e.tasks) ? e.tasks : [],
  }));
  const idx = firstIncompleteIndex(s);
  return {
    checkpoints,
    startCpIndex: idx < 0 ? s.length : idx,
    allComplete: s.length > 0 && idx < 0,
  };
}

/**
 * One-line shape for logs and telemetry, e.g. "3cp 1✓ 1▸ 1·".
 *
 * @param {Array} spine
 * @returns {string}
 */
export function spineSummary(spine) {
  const s = Array.isArray(spine) ? spine : [];
  if (s.length === 0) return 'none';
  const done = s.filter(isComplete).length;
  const failed = s.filter(x => x && x.status === 'failed').length;
  return `${s.length}cp done=${done} failed=${failed} pending=${s.length - done - failed}`;
}
