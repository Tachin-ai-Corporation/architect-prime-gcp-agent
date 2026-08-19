// The parity assertion that gates Phase D's deletions.
//
// Item 11 deletes agent-types.json, static kit.json persona assembly, the
// composition half of job-*.txt, local process JSON and the top-level Firestore
// process library — on the strength of "the release produces the same thing".
// This is the thing that says so, so its own failure modes matter more than most.
//
// The one it must not have: reporting MATCH when the release delivered nothing.
// That is the shape this program keeps finding — a removal set that could not be
// non-empty, an evidence array nothing appended to, a scan root that excluded its
// own subject — and here it would guard the largest deletion in the plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareSets, parityVerdict, renderParity, PARITY_FIELDS } from '../platform/deployment/parity.mjs';

const proc = (over = {}) => ({
  name: 'Triage',
  description: 'How to triage inbound work',
  narrative: 'Read the request. Decide whether it is one job or several.',
  intent_keywords: ['triage', 'inbound'],
  ...over,
});
const asMap = (...ps) => Object.fromEntries(ps.map((p, i) => [p.id ?? `p-${i}`, p]));

// ---- the failure this module exists to prevent ---------------------------

test('an EMPTY release never passes parity', () => {
  const r = compareSets(asMap(proc({ id: 'p-a' })), {}, PARITY_FIELDS.process);
  assert.equal(r.ok, false);
  assert.match(r.reason, /delivers NOTHING/,
    'the seed not happening must read differently from an item being dropped');
  assert.deepEqual(r.missing, ['p-a']);
});

test('both sides empty is still not a pass at the verdict level', () => {
  // Two empty sides compare equal, which is true and useless. The verdict layer
  // is where "we checked nothing" is caught.
  const bothEmpty = compareSets({}, {}, PARITY_FIELDS.process);
  assert.equal(bothEmpty.ok, true, 'the set comparison itself is honest: nothing vs nothing matches');
  assert.equal(parityVerdict({}).ok, false, 'but a run over no categories must fail');
  assert.match(parityVerdict({}).reason, /checks nothing is not a pass/);
});

// ---- what parity actually means ------------------------------------------

test('identical content on both sides passes', () => {
  const legacy = asMap(proc({ id: 'p-a' }), proc({ id: 'p-b', name: 'Other' }));
  const released = asMap(proc({ id: 'p-a' }), proc({ id: 'p-b', name: 'Other' }));
  const r = compareSets(legacy, released, PARITY_FIELDS.process);
  assert.equal(r.ok, true, r.reason);
});

test('a dropped process fails, and is named', () => {
  const r = compareSets(asMap(proc({ id: 'p-a' }), proc({ id: 'p-b' })), asMap(proc({ id: 'p-a' })), PARITY_FIELDS.process);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['p-b']);
});

test('an EXTRA process in the release also fails', () => {
  // Not a nice surprise: it means the seed picked up something the fleet is not
  // running, and switching the reader would start executing it.
  const r = compareSets(asMap(proc({ id: 'p-a' })), asMap(proc({ id: 'p-a' }), proc({ id: 'p-new' })), PARITY_FIELDS.process);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['p-new']);
});

test('a changed narrative fails and says which field', () => {
  const r = compareSets(
    asMap(proc({ id: 'p-a' })),
    asMap(proc({ id: 'p-a', narrative: 'Something else entirely.' })),
    PARITY_FIELDS.process,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, [{ id: 'p-a', fields: ['narrative'] }]);
});

// ---- deliberate looseness, each justified --------------------------------

test('provenance is NOT compared', () => {
  // revision and digest are SUPPOSED to differ — the released copy is a sealed
  // revision and the legacy one is a hand-maintained file. Comparing whole
  // records would fail every time and the check would be switched off.
  const r = compareSets(
    asMap(proc({ id: 'p-a', revision: 'rev-aaaaaaaaaaaa' })),
    asMap(proc({ id: 'p-a', revision: 'rev-bbbbbbbbbbbb', digest: 'sha256:x' })),
    PARITY_FIELDS.process,
  );
  assert.equal(r.ok, true, 'only the declared fields matter');
});

test('keyword ORDER does not count as a difference', () => {
  const r = compareSets(
    asMap(proc({ id: 'p-a', intent_keywords: ['triage', 'inbound'] })),
    asMap(proc({ id: 'p-a', intent_keywords: ['inbound', 'triage'] })),
    PARITY_FIELDS.process,
  );
  assert.equal(r.ok, true, 'these are a set wearing an array; a reorder is not a behaviour change');
});

test('a MISSING keyword does count', () => {
  // The looseness above must not swallow a real loss.
  const r = compareSets(
    asMap(proc({ id: 'p-a', intent_keywords: ['triage', 'inbound'] })),
    asMap(proc({ id: 'p-a', intent_keywords: ['triage'] })),
    PARITY_FIELDS.process,
  );
  assert.equal(r.ok, false);
});

test('trailing whitespace is a formatting artifact, not content', () => {
  const r = compareSets(
    asMap(proc({ id: 'p-a', narrative: 'Do the thing.' })),
    asMap(proc({ id: 'p-a', narrative: '  Do the thing.\n' })),
    PARITY_FIELDS.process,
  );
  assert.equal(r.ok, true);
});

// ---- responsibilities carry their own definition of sameness -------------

test('a responsibility that migrates DISABLED fails parity', () => {
  // The quiet capability loss: it migrates, validates, releases, and never runs.
  // `enabled` is in the field list precisely so this cannot pass.
  const legacy = { 'r-a': { name: 'R', schedule: '0 9 * * 1', instruction: 'do it', success_criteria: 'done', enabled: true } };
  const released = { 'r-a': { name: 'R', schedule: '0 9 * * 1', instruction: 'do it', success_criteria: 'done', enabled: false } };
  const r = compareSets(legacy, released, PARITY_FIELDS.responsibility);
  assert.equal(r.ok, false);
  assert.deepEqual(r.changed, [{ id: 'r-a', fields: ['enabled'] }]);
});

test('a responsibility whose schedule was lost fails parity', () => {
  // The exact P0-8 defect, now caught before a migration rather than after.
  const legacy = { 'r-a': { name: 'R', schedule: '0 9 * * 1', instruction: 'do it', success_criteria: 'done', enabled: true } };
  const released = { 'r-a': { name: 'R', schedule: null, instruction: 'do it', success_criteria: 'done', enabled: true } };
  assert.equal(compareSets(legacy, released, PARITY_FIELDS.responsibility).ok, false);
});

// ---- the verdict layer ---------------------------------------------------

test('one failing category fails the whole run', () => {
  const v = parityVerdict({
    process: compareSets(asMap(proc({ id: 'p-a' })), asMap(proc({ id: 'p-a' })), PARITY_FIELDS.process),
    responsibility: compareSets({ 'r-a': { name: 'R' } }, {}, PARITY_FIELDS.responsibility),
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /responsibility/);
});

test('the report names every difference, so a failure is actionable', () => {
  const v = parityVerdict({
    process: compareSets(
      asMap(proc({ id: 'p-a' }), proc({ id: 'p-gone' })),
      asMap(proc({ id: 'p-a', narrative: 'changed' }), proc({ id: 'p-new' })),
      PARITY_FIELDS.process,
    ),
  });
  const out = renderParity(v);
  assert.match(out, /PARITY FAILED/);
  assert.match(out, /missing from release: p-gone/);
  assert.match(out, /only in release:\s+p-new/);
  assert.match(out, /differs: p-a \(narrative\)/);
});
