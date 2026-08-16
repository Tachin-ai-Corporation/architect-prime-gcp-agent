// platform/work/finalization.mjs — pure predicates for terminal-status classification.
//
// A milestone-verification verdict (cerebellum, a pushed step "N.verify") judges a
// CHECKPOINT, not the mission's deliverable. Conflating the two once terminated a FINISHED
// mission as `blocked`, with the mission's own success summary written into the blocker
// field — a complete 2-page flyer PDF delivered to the operator as an on_failure outcome.
//
// These predicates draw the line the daemon needs at finalization: a `blocked` terminal
// requires a genuinely failed task, not a milestone verdict; and a milestone FAIL over
// tasks that all succeeded is not "failed work" — the same exclusion synthesize.mjs already
// applies to inconclusive/timed-out rows. Pure functions, no I/O (B-19).

// A cerebellum checkpoint-milestone verdict pseudo-step, e.g. { step: '2.verify', ... }.
// It is a statement about a checkpoint milestone, never a unit of dispatched work.
export const isMilestoneVerdict = (r) =>
  typeof r?.step === 'string' && r.step.endsWith('.verify');

// A row representing real dispatched WORK (a task an organ actually ran) — not a system
// nudge, a human note, or a milestone verdict.
export const isWorkRow = (r) =>
  !!r && r.agent !== 'system' && r.agent !== 'human' && !isMilestoneVerdict(r);

// A genuine failed task: real work, hard-failed, and NOT merely inconclusive (the verifier
// could not SEE the evidence) or timed out (outcome unknown). Neither of those is a
// judgement that the work is wrong, so neither counts as a failure here — mirroring
// synthesize.mjs's hasUnresolvedFail exclusions.
export const isRealTaskFailure = (r) =>
  isWorkRow(r) && r.success === false && !r.inconclusive && !r.timedOut;

// A real task that succeeded.
export const isRealTaskSuccess = (r) =>
  isWorkRow(r) && r.success === true;

/**
 * True when a mission's deliverable stands despite a milestone verdict: at least one real
 * task succeeded and NO real task failed. In that state a `blocked` terminal is a mislabel —
 * the only "failure" present is a checkpoint verdict, which judges a checkpoint, not the
 * deliverable. This does NOT assert the mission is complete (that call stays with
 * cerebellum, B-28); it only asserts that recording `blocked` would be wrong.
 *
 * @param {Array} priorResults - the mission's accumulated dispatch results
 * @returns {boolean}
 */
export function deliverableStandsDespiteMilestone(priorResults) {
  const rows = Array.isArray(priorResults) ? priorResults : [];
  return rows.some(isRealTaskSuccess) && !rows.some(isRealTaskFailure);
}
