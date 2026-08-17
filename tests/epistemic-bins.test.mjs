// tests/epistemic-bins.test.mjs — B-29 labelling, from a live defect.
//
// A web-master agent closed a fleet report with five claims, every one rendered
// `[undefined]`, while millie, bobby and candicejr rendered `[verified]` /
// `[inferred]` correctly at three different refs. The claims themselves were
// true — the 1health live channel really did return HTTP 200 with the reported
// title, confirmed from a different VM — so this was never a truthfulness
// problem. It was a labelling one, and that is worse than it sounds: B-29 exists
// so a reader can separate an observation from an inference, and `[undefined]`
// erases that on every claim at once while looking like a rendering glitch
// rather than a caveat, which is the reading most likely to be waved past.
//
// Cause: `\`• [${a.status}]\`` interpolated whatever cortex returned. The SORT on
// the line above already coped with a missing status (`order[a.status] ?? 3`);
// only the render did not.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { epistemicBin } from '../platform/runtime/actions/synthesize.mjs';

describe('epistemicBin — an unlabelled claim is not a labelled one', () => {
  it('passes the three real bins through unchanged', () => {
    for (const b of ['verified', 'inferred', 'assumed']) assert.equal(epistemicBin(b), b);
  });

  it('falls back to the MOST cautious bin, never to undefined', () => {
    // Downgrading is safe. Anything else invents a warrant the agent never gave,
    // and `undefined` gives the reader no warrant at all while looking like a bug.
    for (const bad of [undefined, null, '', '   ', 'confirmed', 'true', 42, {}, []]) {
      assert.equal(epistemicBin(bad), 'assumed', `${JSON.stringify(bad)} should fall to assumed`);
    }
  });

  it('is tolerant of case and padding, since it labels a model\'s output', () => {
    assert.equal(epistemicBin('Verified'), 'verified');
    assert.equal(epistemicBin('  INFERRED '), 'inferred');
  });

  it('never returns a value the sort order does not know', () => {
    // The render and the sort must agree on the vocabulary. They did not before:
    // the sort had a `?? 3` fallback for unknowns and the render had none.
    const order = { assumed: 0, inferred: 1, verified: 2 };
    for (const input of ['verified', 'inferred', 'assumed', 'nonsense', undefined]) {
      assert.notEqual(order[epistemicBin(input)], undefined, `${input} produced an unsortable bin`);
    }
  });
});
