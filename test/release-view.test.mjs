// test/release-view.test.mjs — the P6 exit gate, as a testable structure
//
// The gate is seven questions: what changed, why, who authored it, where it is
// active, how it performed, what approval occurred, how to undo it. Encoding
// them as a structure rather than a page layout makes the gate checkable, and
// forces a missing answer to say so.
//
// That is the property under test. A dashboard that renders a blank where it has
// no evidence is indistinguishable from one reporting good news, and this
// program has already been bitten twice by that exact shape: a rollout gate that
// said "0 missions" when it meant "I looked somewhere else", and an assignment
// that said "converged" about a file reverted underneath it. So every assertion
// here about a missing answer is really an assertion about not lying.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerOperatorQuestions, unanswered } from '../app/src/lib/release-view.ts';
import { deriveCoordinates } from '../app/src/lib/coordinates.ts';

const DIGEST = 'sha256:f9a980797b8d5a381e2f6daea1a6cbd27100f348d587a3e4fe6620d5c2e00269';
const PLATFORM = 'a5e8138769563ca2c458dbca3665cea856b7daec';

const release = (over = {}) => ({
  id: 'fr-6a524ab97fd1',
  created_at: '2026-08-15T18:00:00Z',
  created_by: 'candicejr',
  change_ids: ['fc-2b380a2f921b'],
  digest: DIGEST,
  parent_release: 'fr-bc76ebe656e2',
  status: 'canary',
  evidence: { validated: true, evaluation_ids: [], approved_by: null, approved_at: null },
  ...over,
});

const change = (over = {}) => ({
  id: 'fc-2b380a2f921b',
  title: 'Sharpen the assistant cortex overlay',
  rationale: 'Replies buried the answer under preamble; lead with the answer instead.',
  author: 'candicejr',
  created_at: '2026-08-15T17:55:00Z',
  status: 'released',
  risk: 'low',
  diff: [{ kind: 'persona', id: 'assistant-cortex', summary: "persona 'assistant-cortex': body: rewritten" }],
  revisions: [{ kind: 'persona', id: 'assistant-cortex', revision: 'rev-0000000000a1' }],
  validation: { at: '2026-08-15T17:58:00Z', passed: true, errors: [], checks: ['references'] },
  ...over,
});

const millie = (over = {}) => deriveCoordinates('millie', {
  role_id: 'assistant',
  desired_release: 'fr-6a524ab97fd1', actual_release: 'fr-6a524ab97fd1',
  desired_spec_digest: null, actual_spec_digest: DIGEST,
  applied_at: '2026-08-15T20:48:15Z', last_error: null, ...over,
}, PLATFORM);

const PERF = { missions_finished: 5, completion_rate: 1, false_complete_rate: 0, decision: { action: 'promote', reason: 'clean over 5 finished mission(s)' } };

// ── The gate, satisfied ────────────────────────────────────────────────

test('a fully evidenced release answers all seven questions', () => {
  const a = answerOperatorQuestions(
    release({ evidence: { validated: true, approved_by: 'operator', approved_at: '2026-08-15T21:00:00Z' } }),
    [change()], [millie()], PERF,
  );
  assert.deepEqual(unanswered(a), [], 'the exit gate is exactly this list being empty');

  assert.equal(a.why.known && a.why.value[0].rationale.startsWith('Replies buried'), true);
  assert.equal(a.whoAuthored.known && a.whoAuthored.value[0], 'candicejr');
  assert.equal(a.whereActive.known && a.whereActive.value.converged[0], 'millie');
  assert.equal(a.howToUndo.known && a.howToUndo.value.rollbackTo, 'fr-bc76ebe656e2');
  assert.match(a.howToUndo.known ? a.howToUndo.value.command : '', /fleet-config rollback fr-6a524ab97fd1/);
});

// ── The gate, honestly unsatisfied ─────────────────────────────────────

test('a release nobody approved says so instead of showing an empty approver', () => {
  const a = answerOperatorQuestions(release(), [change()], [millie()], PERF);
  assert.equal(a.whatApproval.known, false);
  assert.match(a.whatApproval.known ? '' : a.whatApproval.why, /validated, but no human approval/);
});

test('a release the gate has never judged does not report zeros as performance', () => {
  // Zero would read as "totally broken"; never-measured is a different fact.
  const a = answerOperatorQuestions(release(), [change()], [millie()], null);
  assert.equal(a.howItPerformed.known, false);
  assert.match(a.howItPerformed.known ? '' : a.howItPerformed.why, /has not been run/);
});

test('a release observed with no finished missions is distinguished from an unjudged one', () => {
  const a = answerOperatorQuestions(release(), [change()], [millie()], { missions_finished: 0, completion_rate: null });
  assert.equal(a.howItPerformed.known, false);
  assert.match(a.howItPerformed.known ? '' : a.howItPerformed.why, /no finished missions have been observed/);
});

test('a release reaching no agent is not quietly shown as deployed', () => {
  const a = answerOperatorQuestions(release(), [change()], [], PERF);
  assert.equal(a.whereActive.known, false);
  assert.match(a.whereActive.known ? '' : a.whereActive.why, /no agent is assigned/);
});

test('the first release has nothing to roll back to, and says that rather than offering a broken undo', () => {
  const a = answerOperatorQuestions(release({ parent_release: null }), [change()], [millie()], PERF);
  assert.equal(a.howToUndo.known, false);
  assert.match(a.howToUndo.known ? '' : a.howToUndo.why, /no predecessor/);
});

test('unreadable change records are named, not silently dropped', () => {
  // The release claims a change; if it cannot be read, the operator must learn
  // that rather than see a release that apparently changed nothing.
  const a = answerOperatorQuestions(release({ change_ids: ['fc-aaa', 'fc-bbb'] }), [], [millie()], PERF);
  assert.equal(a.whatChanged.known, false);
  assert.match(a.whatChanged.known ? '' : a.whatChanged.why, /2 change\(s\) but none could be read/);
  assert.match(a.why.known ? '' : a.why.why, /fc-aaa, fc-bbb/);
});

test('the release creator is not passed off as the content author', () => {
  // `created_by` is who cut the release. Reporting it as the author would be a
  // plausible-sounding guess, which is the kind this codebase keeps punishing.
  const a = answerOperatorQuestions(release(), [change({ author: undefined })], [millie()], PERF);
  assert.equal(a.whoAuthored.known, false);
  assert.match(a.whoAuthored.known ? '' : a.whoAuthored.why, /cut by candicejr/);
});

test('a change with revisions but no rendered diff still reports what it touched', () => {
  const a = answerOperatorQuestions(release(), [change({ diff: [] })], [millie()], PERF);
  assert.equal(a.whatChanged.known, true);
  assert.match(a.whatChanged.known ? a.whatChanged.value[0].entries[0] : '', /persona 'assistant-cortex' → rev-/);
});

// ── Where it is active, in detail ──────────────────────────────────────

test('agents assigned but not yet converged are listed apart from those running it', () => {
  const a = answerOperatorQuestions(
    release(),
    [change()],
    [millie(), deriveCoordinates('candicejr', {
      role_id: 'prime', desired_release: 'fr-6a524ab97fd1', actual_release: 'fr-bc76ebe656e2',
      actual_spec_digest: 'sha256:' + 'c'.repeat(64), last_error: null,
    }, PLATFORM)],
    PERF,
  );
  assert.equal(a.whereActive.known, true);
  const v = a.whereActive.known ? a.whereActive.value : null;
  assert.deepEqual(v?.converged, ['millie']);
  assert.deepEqual(v?.notConverged, ['candicejr'], 'assigned is not the same as running');
});

test('every question is either answered or carries a reason — never blank', () => {
  const cases = [
    [release(), [change()], [millie()], PERF],
    [release({ change_ids: [] }), [], [], null],
    [release({ parent_release: null, evidence: {} }), [change({ rationale: undefined })], [], null],
  ];
  for (const [r, c, coords, perf] of cases) {
    const a = answerOperatorQuestions(r, c, coords, perf);
    for (const [q, ans] of Object.entries(a)) {
      if (q === 'release' || q === 'status') continue;
      if (ans.known) assert.notEqual(ans.value, undefined, `${q} claims to be known`);
      else assert.ok(ans.why.length > 10, `${q} must explain why it cannot answer, got: ${ans.why}`);
    }
  }
});
