// test/rollout-gate.test.mjs — "better" is measurable, and rollback is automatic
//
// §11.3 scenario 9: a deliberately regressive candidate must pause or roll back
// on its own and leave evidence. That only works if the gate is total — every
// input produces a decision with a reason — so this exercises the decision space
// rather than a happy path.
//
// The two cases most worth getting right:
//   * a candidate that clears every absolute floor but is worse than what it
//     replaced (a floor alone misses this);
//   * a candidate judged too early (promoting on two missions turns luck into
//     policy).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveMetrics, groupBySpec, compareMetrics, hasEnoughEvidence } from '../corekit/lib/fleet-config/metrics.mjs';
import { evaluateRollout, renderDecision, nextStage, DEFAULT_THRESHOLDS } from '../corekit/lib/fleet-config/rollout.mjs';

const AT = '2026-08-15T12:00:00Z';

const mission = (over = {}) => ({
  id: `m-${Math.random().toString(36).slice(2, 8)}`,
  type: 'M', status: 'complete', output: 'the thing was done', iteration: 1,
  created_at: AT, updated_at: AT, completed_at: AT, ...over,
});
const task = (over = {}) => ({ id: `t-${Math.random().toString(36).slice(2, 8)}`, type: 'T', status: 'complete', ...over });

/** n missions, of which `bad` are the given shape. */
function run({ n, complete = n, failed = 0, falseComplete = 0, stalled = 0, tasks = 0, failedTasks = 0 }) {
  const out = [];
  for (let i = 0; i < complete - falseComplete; i++) out.push(mission());
  for (let i = 0; i < falseComplete; i++) out.push(mission({ output: '' }));
  for (let i = 0; i < failed; i++) out.push(mission({ status: 'failed', error: 'x' }));
  for (let i = 0; i < stalled; i++) out.push(mission({ status: 'needs_input' }));
  for (let i = 0; i < tasks - failedTasks; i++) out.push(task());
  for (let i = 0; i < failedTasks; i++) out.push(task({ status: 'failed' }));
  return out;
}

// ── Metrics ────────────────────────────────────────────────────────────

test('a clean run reads as clean', () => {
  const m = deriveMetrics(run({ n: 10, complete: 10 }));
  assert.equal(m.missions_finished, 10);
  assert.equal(m.completion_rate, 1);
  assert.equal(m.false_complete_rate, 0);
});

test('a completion with nothing to show is a false complete, not a completion', () => {
  const m = deriveMetrics(run({ n: 10, complete: 10, falseComplete: 2 }));
  assert.equal(m.counts.false_completes, 2);
  assert.equal(m.false_complete_rate, 0.2);
  assert.equal(m.completion_rate, 0.8, 'it must not be counted as success');
});

test('a completion carrying an error is a false complete', () => {
  const m = deriveMetrics([mission({ status: 'complete', output: 'done', error: 'deploy returned 404' })]);
  assert.equal(m.counts.false_completes, 1);
});

test('rates are computed over finished work, not over everything created', () => {
  // Five finished, five still running. Counting the running ones as non-failures
  // would flatter the candidate.
  const envelopes = [...run({ n: 5, complete: 5 }), ...Array.from({ length: 5 }, () => mission({ status: 'active' }))];
  const m = deriveMetrics(envelopes);
  assert.equal(m.missions_total, 10);
  assert.equal(m.missions_finished, 5);
  assert.equal(m.completion_rate, 1);
});

test('metrics over nothing are null, never zero', () => {
  const m = deriveMetrics([]);
  assert.equal(m.completion_rate, null, 'zero would read as "totally broken" rather than "unknown"');
  assert.equal(m.false_complete_rate, null);
  assert.equal(m.mean_iterations, null);
});

test('envelopes group by the spec digest that produced them (C-32)', () => {
  const a = 'sha256:' + 'a'.repeat(64);
  const b = 'sha256:' + 'b'.repeat(64);
  const { groups, unstamped } = groupBySpec([
    mission({ agent_spec_digest: a }), mission({ agent_spec_digest: a }),
    mission({ agent_spec_digest: b }), mission(),
  ]);
  assert.equal(groups.get(a).length, 2);
  assert.equal(groups.get(b).length, 1);
  assert.equal(unstamped.length, 1, 'unstamped work is reported, not folded into a release it may not belong to');
});

test('comparison knows which direction is better for each metric', () => {
  const baseline = deriveMetrics(run({ n: 10, complete: 10 }));
  const worse = deriveMetrics(run({ n: 10, complete: 6, failed: 4 }));
  const c = compareMetrics(baseline, worse);

  assert.equal(c.deltas.completion_rate.verdict, 'regressed');
  assert.equal(c.deltas.failure_rate.verdict, 'regressed', 'more failures is worse, not "improved"');
  assert.ok(c.regressed.includes('completion_rate'));
});

test('an unknown metric compares to unknown rather than guessing', () => {
  const c = compareMetrics(deriveMetrics([]), deriveMetrics(run({ n: 3 })));
  assert.equal(c.deltas.completion_rate.verdict, 'unknown');
  assert.deepEqual(c.regressed, []);
});

test('evidence sufficiency is reported separately from the verdict', () => {
  const e = hasEnoughEvidence(deriveMetrics(run({ n: 2 })), 5);
  assert.equal(e.enough, false);
  assert.match(e.reason, /too early to judge/);
});

// ── The gate ───────────────────────────────────────────────────────────

test('a clean canary with enough evidence is ready to promote', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 8, complete: 8 })), stage: 'canary' });
  assert.equal(d.action, 'promote');
  assert.deepEqual(d.breaches, []);
});

test('a clean candidate judged too early holds rather than promoting', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 2, complete: 2 })), stage: 'canary' });
  assert.equal(d.action, 'hold', 'promoting on two missions turns luck into policy');
  assert.match(d.reason, /too early/);
});

test('a low completion rate pauses', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 10, complete: 6, failed: 4 })), stage: 'canary' });
  assert.equal(d.action, 'pause');
  assert.ok(d.breaches.some((b) => b.metric === 'completion_rate'));
});

test('false completes roll back immediately — the agent reported success it did not achieve', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 10, complete: 10, falseComplete: 3 })), stage: 'canary' });
  assert.equal(d.action, 'rollback');
  assert.match(d.reason, /reported success it did not achieve/);
});

test('a critical breach does not wait for the observation window', () => {
  // Two missions is not enough evidence to PROMOTE, but it is enough to stop
  // something actively doing harm.
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 2, complete: 2, falseComplete: 1 })), stage: 'canary' });
  assert.equal(d.action, 'rollback');
  assert.equal(d.evidence.enough, false, 'and it says the evidence was thin, rather than pretending otherwise');
});

test('a candidate that clears every floor but is worse than the baseline rolls back', () => {
  // 91% completion clears the 90% floor. It is still a 9-point regression from a
  // baseline of 100%, which is the case an absolute floor alone misses.
  const baseline = deriveMetrics(run({ n: 100, complete: 100 }));
  const candidate = deriveMetrics(run({ n: 100, complete: 85, failed: 15 }));

  const withoutBaseline = evaluateRollout({ candidate, stage: 'canary' });
  assert.equal(withoutBaseline.action, 'pause', 'the floor catches an 85% rate');

  const withBaseline = evaluateRollout({ candidate, baseline, stage: 'canary' });
  assert.equal(withBaseline.action, 'rollback');
  assert.match(withBaseline.reason, /worse than what it replaced/);
});

test('a small regression inside tolerance does not trip the gate', () => {
  const baseline = deriveMetrics(run({ n: 100, complete: 100 }));
  const candidate = deriveMetrics(run({ n: 100, complete: 96, failed: 4 }));
  const d = evaluateRollout({ candidate, baseline, stage: 'canary' });
  assert.equal(d.action, 'promote', 'a gate that fires on noise gets switched off');
});

test('tool errors above the limit pause', () => {
  const candidate = deriveMetrics(run({ n: 10, complete: 10, tasks: 100, failedTasks: 40 }));
  const d = evaluateRollout({ candidate, stage: 'canary' });
  assert.equal(d.action, 'pause');
  assert.ok(d.breaches.some((b) => b.metric === 'tool_error_rate'));
});

test('widening beyond a canary needs approval even when clean', () => {
  const candidate = deriveMetrics(run({ n: 20, complete: 20 }));
  const held = evaluateRollout({ candidate, stage: 'fleet' });
  assert.equal(held.action, 'hold');
  assert.match(held.reason, /needs approval/);

  const approved = evaluateRollout({ candidate, stage: 'fleet', approved: true });
  assert.equal(approved.action, 'promote');
});

test('thresholds are overridable per rollout', () => {
  const candidate = deriveMetrics(run({ n: 10, complete: 7, failed: 3 }));
  assert.equal(evaluateRollout({ candidate, stage: 'canary' }).action, 'pause');
  assert.equal(
    evaluateRollout({ candidate, stage: 'canary', thresholds: { min_pass_rate: 0.6 } }).action,
    'promote'
  );
});

test('the gate is total — every decision carries a readable reason', () => {
  const cases = [
    { candidate: deriveMetrics([]) },
    { candidate: deriveMetrics(run({ n: 1 })) },
    { candidate: deriveMetrics(run({ n: 50, complete: 50 })) },
    { candidate: deriveMetrics(run({ n: 50, complete: 20, failed: 30 })) },
    { candidate: deriveMetrics(run({ n: 50, complete: 50, falseComplete: 10 })) },
  ];
  for (const c of cases) {
    const d = evaluateRollout({ ...c, stage: 'canary' });
    assert.ok(['promote', 'hold', 'pause', 'rollback'].includes(d.action));
    assert.ok(d.reason && d.reason.length > 10, `every decision explains itself: ${JSON.stringify(d)}`);
    assert.ok(d.evidence, 'and reports how much evidence it had');
  }
});

// ── Explanation ────────────────────────────────────────────────────────

test('a rollback renders with its breaches and its target', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 10, complete: 10, falseComplete: 3 })), stage: 'canary' });
  const text = renderDecision(d, { release: 'fr-abc', rollbackTarget: 'fr-prev' });

  assert.match(text, /Rolling back/);
  assert.match(text, /fr-abc/);
  assert.match(text, /Breaches:/);
  assert.match(text, /Rolling back to: fr-prev/, 'an operator must not have to look up the target');
});

test('a hold explains what it is still waiting for', () => {
  const d = evaluateRollout({ candidate: deriveMetrics(run({ n: 1 })), stage: 'canary' });
  assert.match(renderDecision(d), /Still observing/);
  assert.match(renderDecision(d), /1 of 5/);
});

// ── Staging ────────────────────────────────────────────────────────────

test('rollout widens stepwise and then stops', () => {
  assert.equal(nextStage('canary'), 'partial');
  assert.equal(nextStage('partial'), 'fleet');
  assert.equal(nextStage('fleet'), null, 'there is nowhere past the whole fleet');
  assert.equal(nextStage('nonsense'), null);
});

test('the defaults are conservative enough to be worth having', () => {
  assert.ok(DEFAULT_THRESHOLDS.min_pass_rate >= 0.8);
  assert.ok(DEFAULT_THRESHOLDS.max_false_complete_rate <= 0.05);
  assert.ok(DEFAULT_THRESHOLDS.observation_missions >= 3, 'fewer than three is not a rate');
});
