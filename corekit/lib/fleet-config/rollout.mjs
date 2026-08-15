// corekit/lib/fleet-config/rollout.mjs — the gate that makes rollback automatic
//
// A canary is only a canary if something watches it and can undo it. This is that
// something: given what a candidate actually did (metrics.mjs, derived from
// stamped envelopes) and what was declared acceptable before it shipped, decide
// whether to promote, keep watching, pause, or roll back.
//
// Pure and total — every input produces a decision with a reason an operator can
// read. That matters more here than anywhere else in the system: a gate that
// fires without explaining itself gets switched off after its first false alarm.
//
// Two principles the thresholds encode:
//
//   * Absolute floors catch a candidate that is bad on its own terms.
//   * Relative regression catches a candidate that is worse than what it
//     replaced, even while clearing every floor — the case a floor alone misses,
//     and the one a rollback target exists for.

import { hasEnoughEvidence, compareMetrics } from './metrics.mjs';

/** Defaults when a rollout declares none. Deliberately conservative. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  min_pass_rate: 0.9,
  max_false_complete_rate: 0.02,
  max_tool_error_rate: 0.2,
  observation_missions: 5,
  // A regression this large rolls back even if every floor is cleared.
  max_completion_regression: 0.1,
  max_false_complete_increase: 0.02,
});

/** Metrics whose breach is severe enough to roll back rather than pause. */
const CRITICAL = Object.freeze(['false_complete_rate']);

const pct = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100)}%`);

/**
 * Decide what to do with a rollout.
 *
 * @param {object} input
 * @param {object} input.candidate   - metrics for the release under observation
 * @param {object} [input.baseline]  - metrics for what it replaced, when known
 * @param {object} [input.thresholds]
 * @param {string} [input.stage]     - canary | partial | fleet
 * @param {boolean} [input.approved] - whether a human has approved promotion
 * @returns {{ action:'promote'|'hold'|'pause'|'rollback', reason:string,
 *             breaches:object[], evidence:object, comparison:object|null }}
 */
export function evaluateRollout(input) {
  const {
    candidate, baseline = null, stage = 'canary', approved = false,
  } = input;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };

  const evidence = hasEnoughEvidence(candidate, thresholds.observation_missions);
  const breaches = [];

  // ---- Absolute floors ----
  const completion = candidate?.completion_rate;
  if (completion !== null && completion !== undefined && completion < thresholds.min_pass_rate) {
    breaches.push({
      metric: 'completion_rate', severity: 'major',
      observed: completion, limit: thresholds.min_pass_rate,
      detail: `completion ${pct(completion)} is below the ${pct(thresholds.min_pass_rate)} floor`,
    });
  }

  const falseComplete = candidate?.false_complete_rate;
  if (falseComplete !== null && falseComplete !== undefined && falseComplete > thresholds.max_false_complete_rate) {
    breaches.push({
      metric: 'false_complete_rate', severity: 'critical',
      observed: falseComplete, limit: thresholds.max_false_complete_rate,
      detail:
        `false-complete ${pct(falseComplete)} exceeds the ${pct(thresholds.max_false_complete_rate)} limit — ` +
        `the agent reported success it did not achieve`,
    });
  }

  const toolErrors = candidate?.tool_error_rate;
  if (toolErrors !== null && toolErrors !== undefined && toolErrors > thresholds.max_tool_error_rate) {
    breaches.push({
      metric: 'tool_error_rate', severity: 'major',
      observed: toolErrors, limit: thresholds.max_tool_error_rate,
      detail: `tool errors ${pct(toolErrors)} exceed the ${pct(thresholds.max_tool_error_rate)} limit`,
    });
  }

  // ---- Relative regression ----
  // A candidate can clear every floor and still be worse than what it replaced.
  // That is the case a rollback target exists for.
  let comparison = null;
  if (baseline) {
    comparison = compareMetrics(baseline, candidate);

    const c = comparison.deltas.completion_rate;
    if (c.delta !== null && -c.delta > thresholds.max_completion_regression) {
      breaches.push({
        metric: 'completion_rate', severity: 'critical',
        observed: candidate.completion_rate, limit: baseline.completion_rate,
        detail:
          `completion fell ${pct(-c.delta)} against the baseline (${pct(baseline.completion_rate)} → ` +
          `${pct(candidate.completion_rate)}) — worse than what it replaced`,
      });
    }

    const f = comparison.deltas.false_complete_rate;
    if (f.delta !== null && f.delta > thresholds.max_false_complete_increase) {
      breaches.push({
        metric: 'false_complete_rate', severity: 'critical',
        observed: candidate.false_complete_rate, limit: baseline.false_complete_rate,
        detail: `false-completes rose ${pct(f.delta)} against the baseline`,
      });
    }
  }

  // ---- Decide ----
  const critical = breaches.filter((b) => b.severity === 'critical');

  // A critical breach does not wait for a full observation window. Evidence
  // thresholds guard against promoting on luck; they must not delay withdrawing
  // something actively doing harm.
  if (critical.length) {
    return {
      action: 'rollback',
      reason: `critical: ${critical.map((b) => b.detail).join('; ')}`,
      breaches, evidence, comparison,
    };
  }

  if (breaches.length) {
    return {
      action: 'pause',
      reason: `${breaches.length} threshold breach(es): ${breaches.map((b) => b.detail).join('; ')}`,
      breaches, evidence, comparison,
    };
  }

  if (!evidence.enough) {
    return { action: 'hold', reason: evidence.reason, breaches, evidence, comparison };
  }

  // Clean, and enough evidence to say so. Promotion beyond a canary is still a
  // human's call by default (ADR-001 risk policy) — the gate says "ready", not
  // "done".
  if (stage !== 'canary' && !approved) {
    return {
      action: 'hold',
      reason: `clean over ${evidence.observed} mission(s), but a ${stage}-scope promotion needs approval`,
      breaches, evidence, comparison,
    };
  }

  return {
    action: 'promote',
    reason: `clean over ${evidence.observed} finished mission(s)` +
      (comparison?.improved.length ? `; improved: ${comparison.improved.join(', ')}` : ''),
    breaches, evidence, comparison,
  };
}

/**
 * Render a decision for a human.
 *
 * A gate that fires and cannot say why gets disabled after its first false
 * alarm, so the explanation is part of the mechanism rather than a nicety.
 */
export function renderDecision(decision, { release, rollbackTarget } = {}) {
  const head = {
    promote: '✅ Ready to promote',
    hold: '⏳ Still observing',
    pause: '⚠️ Paused',
    rollback: '⛔ Rolling back',
  }[decision.action];

  const lines = [`${head}${release ? ` — ${release}` : ''}`, '', decision.reason];

  if (decision.breaches.length) {
    lines.push('', 'Breaches:');
    for (const b of decision.breaches) lines.push(`  - [${b.severity}] ${b.detail}`);
  }

  if (decision.comparison?.regressed?.length) {
    lines.push('', `Regressed vs baseline: ${decision.comparison.regressed.join(', ')}`);
  }

  lines.push('', `Evidence: ${decision.evidence.reason}`);
  if (decision.action === 'rollback' && rollbackTarget) {
    lines.push(`Rolling back to: ${rollbackTarget}`);
  }
  return lines.join('\n');
}

/**
 * The next rollout stage, or null when there is nowhere further to go.
 *
 * Widening is stepwise on purpose: canary → partial → fleet. Jumping from one
 * agent to the whole fleet skips the only stage where a problem is both visible
 * and cheap.
 */
export function nextStage(stage) {
  return { canary: 'partial', partial: 'fleet', fleet: null }[stage] ?? null;
}
