// test/effort.test.mjs — per-prime effort → dispatch temperature scale (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, DEFAULT_EFFORT, normalizeEffort, effortScale, applyEffort } from '../platform/contracts/effort.mjs';

test('levels + default', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'max']);
  assert.equal(DEFAULT_EFFORT, 'medium');
});

test('normalizeEffort: known passes, unknown/absent → medium', () => {
  for (const l of EFFORT_LEVELS) assert.equal(normalizeEffort(l), l);
  assert.equal(normalizeEffort('nonsense'), 'medium');
  assert.equal(normalizeEffort(undefined), 'medium');
  assert.equal(normalizeEffort(null), 'medium');
});

test('effortScale is monotonic increasing; medium = 1.0 (baseline)', () => {
  assert.equal(effortScale('medium'), 1.0);
  assert.ok(effortScale('low') < effortScale('medium'));
  assert.ok(effortScale('medium') < effortScale('high'));
  assert.ok(effortScale('high') < effortScale('max'));
});

test('applyEffort: medium leaves base unchanged', () => {
  assert.equal(applyEffort(0.4, 'medium'), 0.4);
  assert.equal(applyEffort(0.6, 'medium'), 0.6);
});

test('applyEffort: low reduces, high/max raise (more exploratory)', () => {
  assert.ok(applyEffort(0.4, 'low') < 0.4);
  assert.ok(applyEffort(0.4, 'high') > 0.4);
  assert.ok(applyEffort(0.4, 'max') > applyEffort(0.4, 'high'));
});

test('applyEffort: clamps to the [0, 1.0] ceiling (safe for Anthropic cortex)', () => {
  // a high base at max would exceed 1.0 → clamped
  assert.equal(applyEffort(0.9, 'max'), 1.0);
  assert.ok(applyEffort(0.6, 'max') <= 1.0);
  // never negative
  assert.ok(applyEffort(0, 'low') >= 0);
});

test('applyEffort: non-numeric base falls back to 0.5', () => {
  assert.equal(applyEffort(undefined, 'medium'), 0.5);
  assert.equal(applyEffort('x', 'medium'), 0.5);
});

test('unknown effort behaves as medium (safe default)', () => {
  assert.equal(applyEffort(0.4, 'garbage'), applyEffort(0.4, 'medium'));
});
