// A registry-authored responsibility must actually fire (P0-8, Phase D item 10).
//
// The contract and the runtime described different objects, so a responsibility
// could be authored, validated, released, delivered to an agent — and do nothing:
//
//   * the compiler emitted `trigger` (an OBJECT); the scheduler read a top-level
//     `schedule` STRING that nothing produced, so `enabled && schedule` was false
//     and it was never scheduled;
//   * the event path compared that object to an event NAME
//     (`r.trigger === eventType`), which is never true;
//   * the scheduler took accept criteria from `resp.context?.success_criteria`
//     while responsibilities declare `success_criteria` at the top level.
//
// That last one was not latent. Two of the five shipped responsibilities —
// r-fleet-improvement-review and r-fleet-drift-check, the pair that makes Prime
// self-improving — declare top-level criteria and were handing their missions
// `accept_criteria: null`.
//
// v2 splits the trigger into `schedule` and `event` and the scheduler reads the
// shape the compiler emits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaFor, sealRevision } from '../platform/contracts/index.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scheduler = readFileSync(join(repo, 'platform', 'work', 'scheduler.mjs'), 'utf8');
const compiler = readFileSync(join(repo, 'platform', 'deployment', 'compiler.mjs'), 'utf8');

const draft = (over = {}) => ({
  id: 'r-probe',
  name: 'Probe',
  schedule: '0 9 * * 1',
  instruction: 'Do the thing that this responsibility exists to do.',
  success_criteria: 'The thing was done and a report says how it was verified.',
  ...over,
});

// ---- the schema now describes what runs -------------------------------------

test('the schema is v2 and the trigger object is gone', () => {
  const s = schemaFor('responsibility');
  assert.equal(s.version, 2);
  assert.equal(s.spec.properties.trigger, undefined, 'the nested trigger must be gone, not shadowed');
  assert.ok(s.spec.properties.schedule, 'schedule is what the scheduler reads');
  assert.ok(s.spec.properties.event, 'and event is the other way to fire');
});

test('the schema declares every field the scheduler reads', () => {
  // The v1 gap was not only `trigger`: singleton and min_spacing_minutes were read
  // by the scheduler and undeclarable through the registry, so a registry-authored
  // responsibility could not say "only one at a time".
  const props = schemaFor('responsibility').spec.properties;
  for (const f of ['schedule', 'event', 'timezone', 'catch_up', 'singleton',
    'min_spacing_minutes', 'context', 'instruction', 'success_criteria',
    'project_id', 'enabled']) {
    assert.ok(props[f], `the scheduler reads ${f}; the contract must declare it`);
  }
});

test('exactly one of schedule or event — neither can never fire, both is undefined', () => {
  assert.ok(sealRevision('responsibility', draft(), { actor: 't' }), 'a schedule alone is valid');
  assert.ok(sealRevision('responsibility', draft({ schedule: null, event: 'mission.failed' }), { actor: 't' }),
    'an event alone is valid');

  assert.throws(() => sealRevision('responsibility', draft({ schedule: null }), { actor: 't' }),
    /never fire/, 'neither must be refused — this is the state that validates and does nothing');
  assert.throws(() => sealRevision('responsibility', draft({ event: 'mission.failed' }), { actor: 't' }),
    /not both/, 'both must be refused — which one wins would be undefined');
});

test('a schedule that is not five-field cron is refused', () => {
  // `cron` was nullable in v1 with the requirement expressed only in prose, so a
  // schedule trigger with no usable expression could be sealed.
  assert.throws(() => sealRevision('responsibility', draft({ schedule: 'every monday' }), { actor: 't' }),
    /five-field cron/);
});

// ---- the compiler emits it ---------------------------------------------------

test('the compiled record carries schedule and event, not trigger', () => {
  assert.match(compiler, /schedule: r\.schedule \?\? null,/);
  assert.match(compiler, /event: r\.event \?\? null,/);
  assert.doesNotMatch(compiler, /^\s+trigger: r\.trigger,$/m, 'the object shape must be gone');
});

test('the compiled record carries the scheduler-only fields', () => {
  for (const f of ['singleton', 'min_spacing_minutes', 'context', 'timezone', 'catch_up']) {
    assert.match(compiler, new RegExp(`${f}:`), `${f} must reach the runtime record`);
  }
});

// ---- the scheduler reads it --------------------------------------------------

test('the scheduler matches an event by NAME', () => {
  assert.match(scheduler, /return r\.event === eventType;/);
  assert.doesNotMatch(scheduler, /return r\.trigger === eventType;/,
    'comparing an object to a string can never be true');
});

test('accept criteria come from the top level, with context as the legacy fallback', () => {
  // Top-level FIRST. The fallback keeps the two responsibilities that nest it
  // working, so no data migration is needed — but the declared field wins.
  const hits = [...scheduler.matchAll(/\(resp\.success_criteria \?\? resp\.context\?\.success_criteria\)/g)];
  assert.ok(hits.length >= 3, `expected every read to prefer the top level, found ${hits.length}`);
  assert.doesNotMatch(scheduler, /accept_criteria: resp\.context\?\.success_criteria \|\| null/,
    'the context-only read is the live bug: two shipped responsibilities were getting null');
});

// ---- the shipped responsibilities actually benefit ---------------------------

test('every shipped responsibility now yields accept criteria', () => {
  // The regression this fixes, measured against the real files rather than a
  // fixture. Before: three of five resolved to null.
  const resolve = (r) => r.success_criteria ?? r.context?.success_criteria ?? null;
  const files = [
    'corekit/config/responsibilities-prime.json',
    'corekit/config/responsibilities.json',
  ];
  let checked = 0;
  const missing = [];
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(repo, f), 'utf8'));
    for (const r of parsed.responsibilities || []) {
      checked += 1;
      if (!resolve(r)) missing.push(`${f}:${r.id}`);
    }
  }
  assert.ok(checked >= 4, `expected several shipped responsibilities, saw ${checked}`);
  assert.deepEqual(missing, [],
    'a responsibility whose criteria the scheduler cannot find creates a mission with no bar to meet');
});
