// corekit/lib/fleet-config/metrics.mjs — what a release actually did
//
// The §12 measures, derived from work envelopes rather than from a separate
// telemetry pipeline. That is deliberate: the envelopes are already the record of
// what happened, and P3 stamped each one with the spec digest that produced it
// (C-32). Grouping by digest turns "is the candidate better?" from an opinion
// into arithmetic over work that actually ran.
//
// Pure. The caller fetches envelopes; this decides what they mean.

/** Envelope statuses that represent a finished attempt, good or bad. */
const TERMINAL = new Set(['complete', 'failed', 'rejected', 'timed_out', 'cancelled']);

/** Statuses that mean the agent stopped and asked rather than finishing. */
const STALLED = new Set(['needs_input', 'blocked', 'timed_out']);

/**
 * A false-complete is the failure mode that matters most and is hardest to see:
 * the envelope says `complete` while its own evidence says otherwise. Detected
 * structurally rather than by reading prose — a completion with no deliverable,
 * or one whose verification never ran, is not a completion anyone should count.
 */
function isFalseComplete(env) {
  if (env.status !== 'complete') return false;
  if (env.type !== 'M') return false;
  const output = (env.output || '').trim();
  if (!output) return true;                       // completed with nothing to show
  if (env.error) return true;                     // completed carrying an error
  return false;
}

/**
 * Derive the metric set for one group of envelopes.
 *
 * Rates are computed over the missions that finished, not over everything ever
 * created: a mission still running is not evidence for or against a candidate,
 * and counting it as a non-failure flatters the numbers.
 */
export function deriveMetrics(envelopes) {
  const missions = (envelopes || []).filter((e) => e.type === 'M');
  const finished = missions.filter((e) => TERMINAL.has(e.status));

  const completed = finished.filter((e) => e.status === 'complete');
  const falseCompletes = completed.filter(isFalseComplete);
  const stalled = missions.filter((e) => STALLED.has(e.status));

  const iterations = finished.map((e) => e.iteration || 0);
  const totalTasks = (envelopes || []).filter((e) => e.type === 'T');
  const failedTasks = totalTasks.filter((e) => e.status === 'failed');

  const rate = (n, d) => (d === 0 ? null : n / d);

  return {
    missions_total: missions.length,
    missions_finished: finished.length,

    // The headline: did the work actually get done, honestly.
    completion_rate: rate(completed.length - falseCompletes.length, finished.length),
    false_complete_rate: rate(falseCompletes.length, finished.length),
    failure_rate: rate(finished.filter((e) => e.status === 'failed').length, finished.length),
    stalled_rate: rate(stalled.length, missions.length),

    // Effort. A candidate that reaches the same outcome in fewer iterations is
    // better even when the pass rate is unchanged (B-8).
    mean_iterations: iterations.length ? iterations.reduce((a, b) => a + b, 0) / iterations.length : null,
    max_iterations: iterations.length ? Math.max(...iterations) : null,

    tool_error_rate: rate(failedTasks.length, totalTasks.length),

    // Kept separate from the rates: a count is evidence, a rate over a tiny
    // denominator is noise wearing a percentage sign.
    counts: {
      completed: completed.length,
      false_completes: falseCompletes.length,
      failed: finished.filter((e) => e.status === 'failed').length,
      stalled: stalled.length,
      tasks: totalTasks.length,
      failed_tasks: failedTasks.length,
    },
  };
}

/**
 * Group envelopes by the spec digest that produced them (C-32).
 *
 * Envelopes with no digest predate content-sync; they are returned under
 * `unstamped` rather than silently folded into a group, because attributing them
 * to a release nobody can name is exactly the error the stamping exists to
 * prevent.
 */
export function groupBySpec(envelopes) {
  const groups = new Map();
  const unstamped = [];

  for (const env of envelopes || []) {
    const digest = env.agent_spec_digest;
    if (!digest) { unstamped.push(env); continue; }
    if (!groups.has(digest)) groups.set(digest, []);
    groups.get(digest).push(env);
  }
  return { groups, unstamped };
}

/**
 * Compare a candidate against a baseline, metric by metric.
 *
 * Direction is per-metric and explicit: a higher completion rate is better, a
 * higher false-complete rate is worse, and getting that backwards would make a
 * regression look like an improvement.
 */
const HIGHER_IS_BETTER = new Set(['completion_rate']);
const LOWER_IS_BETTER = new Set([
  'false_complete_rate', 'failure_rate', 'stalled_rate', 'tool_error_rate',
  'mean_iterations', 'max_iterations',
]);

export function compareMetrics(baseline, candidate) {
  const deltas = {};

  for (const key of [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER]) {
    const b = baseline?.[key];
    const c = candidate?.[key];
    if (b === null || b === undefined || c === null || c === undefined) {
      deltas[key] = { baseline: b ?? null, candidate: c ?? null, delta: null, verdict: 'unknown' };
      continue;
    }
    const delta = c - b;
    const better = HIGHER_IS_BETTER.has(key) ? delta > 0 : delta < 0;
    const worse = HIGHER_IS_BETTER.has(key) ? delta < 0 : delta > 0;
    deltas[key] = {
      baseline: b, candidate: c, delta,
      verdict: delta === 0 ? 'unchanged' : better ? 'improved' : worse ? 'regressed' : 'unchanged',
    };
  }

  const regressed = Object.entries(deltas).filter(([, d]) => d.verdict === 'regressed').map(([k]) => k);
  const improved = Object.entries(deltas).filter(([, d]) => d.verdict === 'improved').map(([k]) => k);

  return { deltas, regressed, improved };
}

/**
 * Is there enough evidence to judge at all?
 *
 * The most common way an automated gate goes wrong is deciding early: two
 * missions is not a pass rate, and promoting on it converts luck into policy.
 * Reported separately from the verdict so a caller can say "not yet" rather than
 * "fine".
 */
export function hasEnoughEvidence(metrics, minMissions) {
  const observed = metrics?.missions_finished ?? 0;
  return {
    enough: observed >= minMissions,
    observed,
    required: minMissions,
    reason: observed >= minMissions
      ? `${observed} finished mission(s)`
      : `only ${observed} of ${minMissions} finished mission(s) — too early to judge`,
  };
}
