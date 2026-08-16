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

// A line that says something an operator could act on. `[FAILED]` markers, bare tool
// echoes and empty frames are structure, not explanation.
const isSubstantive = (line) => {
  const t = line.trim();
  if (t.length < 12) return false;
  if (/^\[(TOOL|FAILED|SKIPPED|CHECKPOINT)\b/.test(t)) return false;
  if (/^[-=*#\s]+$/.test(t)) return false;
  return true;
};

/**
 * The blocker, stated from evidence the mission already produced.
 *
 * `blocked` exists to hand a problem back to a human. A handback that says
 * "Blocked on external dependency." with blocker "Unknown blocker" is a dead end:
 * the operator learns that something stopped, not what to do about it, and the
 * mission's own diagnosis is thrown away on the way out.
 *
 * That is not hypothetical. A live assistant mission was asked to create a
 * spreadsheet, discovered there is no tool that creates one, read its own
 * SKILL.md to confirm, and reported: "Provide the motor agent with a functional
 * tool or command to create Google Sheets." Exactly the sentence the operator
 * needed. Cortex then chose `blocked` without carrying any of it forward, and
 * the terminal output was the constant.
 *
 * So when cortex articulates nothing, do not invent and do not fall back to a
 * phrase — recover what the failing task already said. Deterministic (C-4): the
 * daemon moves evidence that exists, it does not ask anyone to describe it again.
 *
 * @param {Array} priorResults - the mission's accumulated dispatch results
 * @param {(text: string) => string} extractRecommendation - verdict.mjs's
 *   extractFailRecommendation, injected so this module stays pure and testable
 * @returns {{ step: string, agent: string, detail: string } | null} null when the
 *   evidence is genuinely empty — the caller must then say so, not paper over it
 */
export function articulateBlocker(priorResults, extractRecommendation) {
  const failed = (Array.isArray(priorResults) ? priorResults : []).filter(isRealTaskFailure);
  if (!failed.length) return null;

  // The LAST failure: after a re-plan the earlier ones are superseded attempts,
  // and handing back the first thing that went wrong describes a mission the
  // agent has already moved on from.
  const last = failed[failed.length - 1];
  const text = String(last.result ?? last.summary ?? '');

  let detail = '';
  try {
    const rec = extractRecommendation ? extractRecommendation(text) : '';
    if (rec && rec !== 'No recommendation available') detail = String(rec).trim();
  } catch { /* a malformed tool log is not a reason to lose the row entirely */ }

  if (!detail) detail = (text.split('\n').find(isSubstantive) || '').trim();
  if (!detail) return null;

  return {
    step: String(last.step ?? ''),
    agent: String(last.agent ?? ''),
    detail: detail.length > 600 ? `${detail.slice(0, 600)}…` : detail,
  };
}
