// test/mission-invariant.test.mjs — C-15 mission-parent invariant (R→M→C→T)
//
// Regression: the guard used to demote EVERY parented mission to a checkpoint, so a
// routine-spawned mission (legitimately parented to its R envelope) rendered as a
// checkpoint-under-a-checkpoint instead of R→M→C→T. The invariant must exempt
// responsibility-spawned missions while still catching genuinely nested ones.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enforceMissionParentInvariant } from '../platform/work/plan-utils.mjs';

describe('enforceMissionParentInvariant (C-15: missions never nest)', () => {
  it('demotes a parented M with no responsibility origin to C (nesting bug)', () => {
    const env = { id: 'w1', type: 'M', parent_id: 'p1', source_meta: {} };
    assert.equal(enforceMissionParentInvariant(env), true);
    assert.equal(env.type, 'C');
    assert.equal(env.delivery_status, 'internal');
  });

  it('EXEMPTS a responsibility-spawned mission (R→M) — keeps type M', () => {
    const env = {
      id: 'w2', type: 'M', parent_id: 'r-routine',
      source_meta: { responsibility_id: 'resp-nightly-memory' },
    };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'M');                 // stays a mission
    assert.equal(env.delivery_status, undefined); // untouched (delivery gated on parent_id elsewhere)
  });

  it('leaves a top-level M (no parent) alone', () => {
    const env = { id: 'w3', type: 'M', parent_id: null, source_meta: {} };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'M');
  });

  it('ignores non-mission envelopes (C under M is normal)', () => {
    const env = { id: 'w4', type: 'C', parent_id: 'm1' };
    assert.equal(enforceMissionParentInvariant(env), false);
    assert.equal(env.type, 'C');
  });

  it('handles null / missing source_meta without throwing', () => {
    const nullMeta = { id: 'w5', type: 'M', parent_id: 'x', source_meta: null };
    assert.equal(enforceMissionParentInvariant(nullMeta), true);
    assert.equal(nullMeta.type, 'C');

    const noMeta = { id: 'w6', type: 'M', parent_id: 'x' };
    assert.equal(enforceMissionParentInvariant(noMeta), true);
    assert.equal(noMeta.type, 'C');
  });

  it('is a no-op on null/garbage input', () => {
    assert.equal(enforceMissionParentInvariant(null), false);
    assert.equal(enforceMissionParentInvariant(undefined), false);
    assert.equal(enforceMissionParentInvariant({}), false);
  });
});
