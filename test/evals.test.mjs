// test/evals.test.mjs — measuring a candidate before any agent meets it
//
// The rollout gate judges a release on the work it produced, which is honest and
// late: something has to go wrong in production first. An evaluation asks the
// same question of the compiled spec, before exposure.
//
// The case that justifies the whole file is `occurs`. The soul-doubling defect
// would have been caught by an assertion that the overlay appears exactly ONCE —
// not that it appears, which it did, twice, while every "contains" check stayed
// green. "Is it there" and "is it there once" are different questions and only
// one of them was being asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runCase, runSuite, compareRuns, regressions, evaluationRecord, renderEvaluation, ASSERTIONS,
} from '../corekit/lib/fleet-config/evals.mjs';

const OVERLAY = 'I am an assistant. I keep the calendar honest.';

const ctx = (over = {}) => ({
  spec: {
    skills: [{ id: 'workspace-drive' }, { id: 'memory-consolidate' }],
    capabilities: ['tool.drive-ls.invoke'],
    egress_class: 'tenant',
    ...over.spec,
  },
  files: {
    'workspace-cortex/SOUL.md': `# Cortex\n\nI decide what happens next.\n\n${OVERLAY}\n`,
    ...over.files,
  },
});

// ── The assertion that would have caught the defect ────────────────────

test('an overlay present twice fails `occurs`, though it passes `contains`', () => {
  const doubled = ctx({ files: { 'workspace-cortex/SOUL.md': `# Cortex\n${OVERLAY}\n${OVERLAY}\n` } });

  const contains = runCase({ id: 'c', file: 'workspace-cortex/SOUL.md', assert: { kind: 'contains', value: OVERLAY } }, doubled);
  assert.equal(contains.pass, true, 'this is why the defect survived: the overlay WAS there');

  const once = runCase({ id: 'o', file: 'workspace-cortex/SOUL.md', assert: { kind: 'occurs', value: OVERLAY, times: 1 } }, doubled);
  assert.equal(once.pass, false);
  assert.match(once.notes, /2×, expected 1×/, 'and it says what it actually found');
});

test('`occurs` passes on a correctly rendered soul', () => {
  const r = runCase({ id: 'o', file: 'workspace-cortex/SOUL.md', assert: { kind: 'occurs', value: OVERLAY, times: 1 } }, ctx());
  assert.equal(r.pass, true);
});

// ── Grading is total and says what it found ────────────────────────────

test('an unknown assertion fails rather than passing silently', () => {
  // A typo that passes is a case that has stopped testing anything while still
  // reporting green.
  const r = runCase({ id: 'x', assert: { kind: 'contians', value: 'x' } }, ctx());
  assert.equal(r.pass, false);
  assert.match(r.notes, /unknown assertion/);
});

test('a missing file is distinguished from wrong content', () => {
  const r = runCase({ id: 'm', file: 'workspace-motor/SOUL.md', assert: { kind: 'contains', value: 'x' } }, ctx());
  assert.equal(r.pass, false);
  assert.match(r.notes, /missing from the bundle/, 'a shared message would hide the more serious cause');
});

test('a file assertion with no file named fails cleanly', () => {
  const r = runCase({ id: 'n', assert: { kind: 'contains', value: 'x' } }, ctx());
  assert.equal(r.pass, false);
  assert.match(r.notes, /needs a file/);
});

test('an invalid regex is a failed case, not a thrown runner', () => {
  const r = runCase({ id: 'r', file: 'workspace-cortex/SOUL.md', assert: { kind: 'matches', value: '([unclosed' } }, ctx());
  assert.equal(r.pass, false);
  assert.match(r.notes, /invalid pattern/);
});

test('every declared assertion is implemented', () => {
  // A kind listed but unimplemented would return "declared but not implemented"
  // — which fails, but only when someone writes a case for it.
  for (const kind of ASSERTIONS) {
    const r = runCase(
      { id: kind, file: 'workspace-cortex/SOUL.md', assert: { kind, value: 'x', times: 0, max: 100000 } },
      ctx(),
    );
    assert.doesNotMatch(r.notes, /not implemented/, `${kind} is declared but not implemented`);
  }
});

// ── Spec-level assertions ──────────────────────────────────────────────

test('skills, capabilities and egress are checkable facts about the spec', () => {
  const c = ctx();
  assert.equal(runCase({ id: 'a', assert: { kind: 'has_skill', value: 'workspace-drive' } }, c).pass, true);
  assert.equal(runCase({ id: 'b', assert: { kind: 'has_skill', value: 'github-pr' } }, c).pass, false);
  assert.equal(runCase({ id: 'c', assert: { kind: 'lacks_skill', value: 'github-pr' } }, c).pass, true);
  assert.equal(runCase({ id: 'd', assert: { kind: 'has_capability', value: 'tool.drive-ls.invoke' } }, c).pass, true);
  assert.equal(runCase({ id: 'e', assert: { kind: 'egress_class', value: 'tenant' } }, c).pass, true);
  assert.equal(runCase({ id: 'f', assert: { kind: 'egress_class', value: 'none' } }, c).pass, false);
});

test('a missing skill failure names what the role does hold', () => {
  const r = runCase({ id: 'a', assert: { kind: 'has_skill', value: 'firebase' } }, ctx());
  assert.match(r.notes, /has: workspace-drive, memory-consolidate/, 'so the fix does not need a second query');
});

test('a prompt budget is enforceable before the runtime truncates it', () => {
  const big = ctx({ files: { 'workspace-cortex/SOUL.md': 'x'.repeat(50_000) } });
  const r = runCase({ id: 'b', file: 'workspace-cortex/SOUL.md', assert: { kind: 'max_chars', max: 40_000 } }, big);
  assert.equal(r.pass, false);
  assert.match(r.notes, /50000 chars, over the 40000 limit/);
});

// ── Suites ─────────────────────────────────────────────────────────────

test('an empty suite fails rather than reporting a clean sweep', () => {
  // "Every case passed" over no cases is the same lie as a validator that
  // approves an empty definition set.
  const r = runSuite({ cases: [] }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /proves nothing/);
});

test('a suite reports each case and the totals', () => {
  const suite = { cases: [
    { id: 'has-drive', assert: { kind: 'has_skill', value: 'workspace-drive' } },
    { id: 'no-pr', assert: { kind: 'has_skill', value: 'github-pr' } },
  ] };
  const r = runSuite(suite, ctx());
  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.results.find((x) => x.case_id === 'no-pr').pass, false);
});

// ── Comparison ─────────────────────────────────────────────────────────

test('a case that stops passing is a regression', () => {
  const c = compareRuns(
    [{ case_id: 'a', pass: true }, { case_id: 'b', pass: true }],
    [{ case_id: 'a', pass: true }, { case_id: 'b', pass: false, notes: 'overlay appears 2×' }],
  );
  assert.deepEqual(c.map((r) => r.verdict), ['unchanged', 'regressed']);
  assert.equal(regressions(c).length, 1);
});

test('a case dropped from the candidate is a regression, not a silent improvement', () => {
  // Deleting the case you fail is the cheapest way to turn a red suite green.
  const c = compareRuns([{ case_id: 'a', pass: false }], []);
  assert.equal(c[0].verdict, 'regressed');
  assert.match(c[0].notes, /missing from the candidate run/);
});

test('a new case is reported as new rather than compared against nothing', () => {
  const c = compareRuns([], [{ case_id: 'new', pass: true }]);
  assert.equal(c[0].verdict, 'improved');
  assert.match(c[0].notes, /no baseline/);
});

test('a fix reads as improved', () => {
  const c = compareRuns([{ case_id: 'a', pass: false }], [{ case_id: 'a', pass: true }]);
  assert.equal(c[0].verdict, 'improved');
});

// ── The record ─────────────────────────────────────────────────────────

const SIDE = (digest) => ({ agent_spec_digest: `sha256:${digest.repeat(64).slice(0, 64)}`, platform_version: 'a5e8138', model: 'gemini-3.6-flash' });

test('an evaluation record carries the metrics the gate needs', () => {
  const results = compareRuns(
    [{ case_id: 'a', pass: true }, { case_id: 'b', pass: false }],
    [{ case_id: 'a', pass: true }, { case_id: 'b', pass: true }],
  );
  const rec = evaluationRecord({
    id: 'fe-abc123', suiteId: 'assistant-core', baseline: SIDE('a'), candidate: SIDE('b'),
    results, createdAt: '2026-08-15T22:00:00Z',
  });

  assert.equal(rec.status, 'complete');
  assert.equal(rec.metrics.total, 2);
  assert.equal(rec.metrics.passed, 2);
  assert.equal(rec.metrics.improved, 1);
  assert.equal(rec.metrics.regressed, 0);
  assert.equal(rec.metrics.pass_rate, 1);
});

test('a regression renders with the case and the reason', () => {
  const results = compareRuns(
    [{ case_id: 'overlay-once', pass: true }],
    [{ case_id: 'overlay-once', pass: false, notes: 'contains it 2×, expected 1×' }],
  );
  const text = renderEvaluation(evaluationRecord({
    id: 'fe-x', suiteId: 'assistant-core', baseline: SIDE('a'), candidate: SIDE('b'),
    results, createdAt: '2026-08-15T22:00:00Z',
  }));

  assert.match(text, /❌/);
  assert.match(text, /REGRESSED/);
  assert.match(text, /overlay-once/);
  assert.match(text, /2×, expected 1×/, 'an operator must not have to open the fixture to see what broke');
});
