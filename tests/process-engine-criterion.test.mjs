// tests/process-engine-criterion.test.mjs — pure tests for synthesizeCheckpointCriterion.
//
// The process→checkpoint conversion historically stamped accept_criteria:'' on every process
// checkpoint. The checkpoint executor gates cerebellum verification on a NON-EMPTY criterion,
// so process missions ran with verification disarmed and could false-complete (a deploy step
// that failed silently still reported ✅). This helper synthesizes a real milestone criterion
// from the grouped steps so verification re-arms (B-28 re-derivation).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeCheckpointCriterion } from '../corekit/lib/process-engine.mjs';

describe('synthesizeCheckpointCriterion', () => {
  it('joins the grouped steps’ own accept_criteria', () => {
    const c = synthesizeCheckpointCriterion([
      { accept_criteria: 'The site is deployed to the staging channel' },
      { accept_criteria: 'A preview URL is returned and reachable' },
    ], 'Checkpoint 1: Deploy');
    assert.equal(c, 'The site is deployed to the staging channel AND A preview URL is returned and reachable');
  });

  it('dedups shared criteria while preserving order', () => {
    const c = synthesizeCheckpointCriterion([
      { accept_criteria: 'Outcome X holds' },
      { accept_criteria: 'outcome x holds' }, // case-insensitive dup
      { accept_criteria: 'Outcome Y holds' },
    ], 'CP');
    assert.equal(c, 'Outcome X holds AND Outcome Y holds');
  });

  it('is NEVER empty — falls back to the checkpoint title when no step carries a criterion', () => {
    const c = synthesizeCheckpointCriterion([{ task: 'do a thing' }, { accept_criteria: '' }], 'Checkpoint 2: Publish');
    assert.ok(c.length > 0);
    assert.match(c, /Checkpoint 2: Publish/);
    assert.match(c, /tool evidence/i);
  });

  it('falls back to a generic outcome clause when there is neither a criterion nor a title', () => {
    const c = synthesizeCheckpointCriterion([], '');
    assert.ok(c.length > 0);
    assert.match(c, /achieved its stated outcome/i);
  });

  it('is total on junk input (never throws, always arms verification)', () => {
    for (const bad of [null, undefined, 'nope', 42, [{ accept_criteria: null }]]) {
      const c = synthesizeCheckpointCriterion(bad, '');
      assert.equal(typeof c, 'string');
      assert.ok(c.length > 0);
    }
  });
});
