// test/coordinates.test.mjs — what an agent is running, said plainly
//
// The dashboard has no test runner of its own; `tsc --noEmit` and lint are the
// whole of its coverage, so its logic has been judged on whether it compiles.
// Node strips TypeScript natively, which means the pure parts can simply be
// imported and exercised — this is the first dashboard module to get that.
//
// The rule being enforced is C-32's: desired and actual are separate facts and
// are never collapsed. The registry's record says what an apply *reported*,
// which is a claim about the past. Presenting it as current state is how an
// agent runs Foundation defaults for a week while the operator view says
// "converged" — the exact failure this program hit on millie.
//
// The derivation is total on purpose: a blank cell in an operator view is
// indistinguishable from a healthy one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveCoordinates, summarize } from '../app/src/lib/coordinates.ts';

const DIGEST = 'sha256:f9a980797b8d5a381e2f6daea1a6cbd27100f348d587a3e4fe6620d5c2e00269';
const OTHER = 'sha256:' + 'b'.repeat(64);
const PLATFORM = 'a5e8138769563ca2c458dbca3665cea856b7daec';

const assignment = (over = {}) => ({
  role_id: 'assistant',
  desired_release: 'fr-6a524ab97fd1',
  actual_release: 'fr-6a524ab97fd1',
  desired_spec_digest: null,
  actual_spec_digest: DIGEST,
  applied_at: '2026-08-15T20:48:15.465Z',
  last_error: null,
  ...over,
});

test('a converged agent reports all three coordinates', () => {
  // millie's real record at the close of the P5 canary proof.
  const c = deriveCoordinates('millie', assignment(), PLATFORM);
  assert.equal(c.drift, 'converged');
  assert.equal(c.platformVersion, PLATFORM);
  assert.equal(c.fleetRelease.actual, 'fr-6a524ab97fd1');
  assert.equal(c.agentSpecDigest.actual, DIGEST);
  assert.match(c.explanation, /Running fr-6a524ab97fd1/);
});

test('an assigned release that has not landed is pending, not converged', () => {
  const c = deriveCoordinates('millie', assignment({ desired_release: 'fr-new', actual_release: 'fr-old' }), PLATFORM);
  assert.equal(c.drift, 'pending');
  assert.match(c.explanation, /Assigned fr-new but running fr-old/);
});

test('an agent that has never applied anything says so rather than showing blanks', () => {
  const c = deriveCoordinates('millie', assignment({ actual_release: null }), PLATFORM);
  assert.equal(c.drift, 'pending');
  assert.match(c.explanation, /running nothing/);
});

test('a pinned digest that does not match is a refusal, not a delay', () => {
  // The VM compiled something other than what was validated and approved.
  // Calling that "pending" would suggest waiting; it will never converge.
  const c = deriveCoordinates('millie', assignment({ desired_spec_digest: OTHER }), PLATFORM);
  assert.equal(c.drift, 'failed');
  assert.match(c.explanation, /refusing content that is not what was released/);
});

test('a reported error outranks every other verdict', () => {
  const c = deriveCoordinates('millie', assignment({ last_error: 'compile: no base firmware' }), PLATFORM);
  assert.equal(c.drift, 'failed');
  assert.match(c.explanation, /no base firmware/);
  assert.equal(c.lastError, 'compile: no base firmware');
});

test('an agent with no assignment is unmanaged, which is not the same as broken', () => {
  const c = deriveCoordinates('tom', null, PLATFORM);
  assert.equal(c.drift, 'unmanaged');
  assert.equal(c.fleetRelease.desired, null);
  assert.match(c.explanation, /not managed by a release/);
});

test('an assignment naming no release has nothing to converge on', () => {
  const c = deriveCoordinates('tom', assignment({ desired_release: null }), PLATFORM);
  assert.equal(c.drift, 'unmanaged');
});

test('a release assigned but never attested is unknown, not converged', () => {
  // Silence about what is live must not read as confirmation that it is right.
  const c = deriveCoordinates('millie', assignment({ actual_spec_digest: null }), PLATFORM);
  assert.equal(c.drift, 'unknown');
  assert.match(c.explanation, /cannot be confirmed/);
});

test('a missing platform version is reported as missing, not guessed', () => {
  const c = deriveCoordinates('millie', assignment(), null);
  assert.equal(c.platformVersion, null);
  assert.equal(c.drift, 'converged', 'the platform coordinate is independent of the content ones (C-32)');
});

test('the derivation is total — every input yields a state and a sentence', () => {
  const cases = [
    null,
    {},
    assignment(),
    assignment({ desired_release: null, actual_release: null }),
    assignment({ last_error: 'x' }),
    assignment({ desired_spec_digest: OTHER }),
    assignment({ actual_spec_digest: null }),
  ];
  for (const a of cases) {
    const c = deriveCoordinates('agent', a, PLATFORM);
    assert.ok(['converged', 'pending', 'failed', 'unmanaged', 'unknown'].includes(c.drift));
    assert.ok(c.explanation.length > 20, `every state explains itself: ${JSON.stringify(c)}`);
  }
});

// ── Fleet summary ──────────────────────────────────────────────────────

test('unmanaged agents do not count towards "all converged"', () => {
  // Counting them as healthy would make an empty rollout look complete — the
  // same shape as a gate reporting 0 missions as "nothing wrong".
  const s = summarize([
    deriveCoordinates('a', assignment(), PLATFORM),
    deriveCoordinates('b', assignment(), PLATFORM),
    deriveCoordinates('c', null, PLATFORM),
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.managed, 2);
  assert.equal(s.counts.converged, 2);
  assert.equal(s.counts.unmanaged, 1);
  assert.equal(s.allConverged, true, 'every managed agent is converged');
});

test('a fleet with nothing managed is not "all converged"', () => {
  const s = summarize([deriveCoordinates('a', null, PLATFORM)]);
  assert.equal(s.allConverged, false, 'zero of zero must not read as success');
});

test('one failure is enough to deny the fleet a clean bill', () => {
  const s = summarize([
    deriveCoordinates('a', assignment(), PLATFORM),
    deriveCoordinates('b', assignment({ last_error: 'boom' }), PLATFORM),
  ]);
  assert.equal(s.allConverged, false);
  assert.equal(s.counts.failed, 1);
});
