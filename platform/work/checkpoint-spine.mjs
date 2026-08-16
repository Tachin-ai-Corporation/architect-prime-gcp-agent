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
    // hand-off in the executor (see platform/work/baton.mjs). Absent/ignored under the
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
 * Finalize gate (B-28/B-1): a mission with a pinned spine must not be reported
 * COMPLETE while its DELIVERABLE checkpoint is unmet. The last spine entry is the
 * deliverable (a delivery mission ends "report the staging URL"); if it is not
 * `complete`, a plain `synthesize` would be claiming success the work never reached
 * — the false-green that let a 4-checkpoint delivery terminate `complete` with
 * CP2/3/4 pending and an empty deliverable after the review delegation looped.
 *
 * Returns null when finalize is allowed (no spine, or the terminal checkpoint is
 * complete — a mission may legitimately finish early). Otherwise returns the unmet
 * checkpoints so the caller can escalate honestly (needs_input / synthesize_with_failure)
 * naming exactly what is outstanding, instead of papering over it.
 *
 * Pure (B-19).
 *
 * @param {Array} spine
 * @returns {null | {unmet: Array<{n:number, outcome:string, status:string}>, terminal: {n:number, outcome:string}}}
 */
export function finalizeBlockedBySpine(spine) {
  const s = Array.isArray(spine) ? spine : [];
  if (s.length === 0) return null;                 // no spine → answer-only mission, no gate
  const last = s[s.length - 1];
  if (isComplete(last)) return null;               // deliverable checkpoint done → finalize allowed
  const unmet = s.filter(e => !isComplete(e))
    .map(e => ({ n: e.n, outcome: e.outcome || `Checkpoint ${e.n}`, status: e.status || 'pending' }));
  return { unmet, terminal: { n: last.n, outcome: last.outcome || `Checkpoint ${last.n}` } };
}

/**
 * Probe-gated finalize (an FC-A refinement). finalizeBlockedBySpine gates on the SPINE — the
 * checkpoint bookkeeping. That bookkeeping can be STALE or WRONG while the deliverable is
 * OBSERVABLY met: a delegate deployed the change (staging serves it, HTTP 200), then a later
 * re-plan re-tasked the deploy onto the orchestrator's OWN motor, which failed (no perms) and
 * marked the terminal checkpoint 'failed' — so FC-A blocks a mission whose deliverable is
 * actually live (the false-negative that stranded a 'change the hero → staging link' mission at
 * iter 9+ though the new hero was live). The spine can't tell truth from bookkeeping; only
 * re-deriving the ARTIFACT can. So when the mission rests on a DELEGATED observable deliverable,
 * DEFER the spine block to the mandatory delegated-outcome re-derivation the synthesize verify
 * already runs, and re-apply the block fail-closed unless that re-derivation explicitly confirms
 * the deliverable (PASS). Honesty is preserved: a live artifact PASSES and finalizes; a genuinely
 * missing one FAILS (→ honest failure) or is inconclusive (→ fail-closed, exactly as FC-A now).
 *
 * Two-phase (the caller runs the re-derivation between the phases): call with
 * deliverableVerdict === undefined at the gate to decide defer-vs-block; call again with the
 * re-derivation's verdict to decide allow-vs-block.
 *
 * @param {{flagOn:boolean, restsOnDelegation:boolean, deliverableVerdict?:('PASS'|'FAIL'|null)}} o
 * @returns {'block'|'defer'|'allow'}
 */
export function probeGatedFinalizeAction({ flagOn, restsOnDelegation, deliverableVerdict } = {}) {
  if (!flagOn || !restsOnDelegation) return 'block';   // flag off / not delegated → original FC-A block
  if (deliverableVerdict === undefined) return 'defer'; // gate phase: run the ground-truth re-derivation
  if (deliverableVerdict === 'PASS') return 'allow';    // re-derivation confirms it → finalize despite the spine
  return 'block';                                       // FAIL / inconclusive / null → fail-closed (B-28/FC-A)
}

/**
 * Should a FAILED checkpoint HALT the whole plan (stop and re-plan), or may the mission
 * proceed to the next checkpoint?
 *
 * A checkpoint fails for one of two reasons: a TASK hard-failed (the work itself failed), or
 * its MILESTONE verdict did not pass (cerebellum could not confirm the outcome, over tasks
 * that all succeeded). A milestone-only failure on a NON-terminal checkpoint must NOT halt the
 * mission: the checkpoint's work is frequently done by a DELEGATE in the delegate's OWN
 * workspace/branch, which the delegator's verifier cannot see — so the delegator's FAIL is not
 * proof the work is wrong — and the DELIVERABLE (the terminal checkpoint) carries its own
 * OBSERVABLE milestone (a reachable URL, a served page) that is the real gate. Proceeding lets
 * the terminal run and prove — or, if the earlier work really was wrong, disprove — the end
 * state; a genuinely bad edit still surfaces as a terminal-milestone FAIL, which halts honestly.
 *
 * Halts when: a real task failed, OR the failure is on the TERMINAL (deliverable) checkpoint.
 * Proceeds when: a non-terminal checkpoint's milestone failed but its tasks all succeeded.
 * Fail-closed is preserved for real work failures and for the deliverable itself (B-28/FC-A).
 *
 * @param {{isTerminal:boolean, taskFailure:boolean}} o
 * @returns {boolean} true = halt (planFailed + break); false = flag needs_review and continue
 */
export function checkpointFailureHalts({ isTerminal, taskFailure } = {}) {
  if (taskFailure) return true;   // the work itself failed → halt (fail-closed)
  if (isTerminal) return true;    // the deliverable milestone failed → halt (honest escalate)
  return false;                   // non-terminal, tasks OK, milestone-only → proceed; terminal gates
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
