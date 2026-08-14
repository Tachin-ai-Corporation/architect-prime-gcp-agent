// tests/context-maintenance.test.mjs — pure-core tests for the temporal-memory auto-maintenance reflex.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMaintainContext, buildMaintenancePrompt, parseMaintenanceResponse } from '../corekit/lib/context-maintenance.mjs';

const FLAG_ON = { dispatch: { context_maintenance: true } };
const FLAG_OFF = { dispatch: { context_maintenance: false } };
const M = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'tachin-web', title: 'g', output: 'o', ...over });

describe('shouldMaintainContext', () => {
  it('runs for a completed mission that touched a project, flag on', () => {
    const r = shouldMaintainContext(M(), FLAG_ON);
    assert.equal(r.run, true);
    assert.equal(r.projectId, 'tachin-web');
  });
  it('does not run when the flag is off', () => {
    assert.equal(shouldMaintainContext(M(), FLAG_OFF).run, false);
    assert.equal(shouldMaintainContext(M(), {}).run, false);
  });
  it('does not run for a non-mission, a non-complete, or a project-less mission', () => {
    assert.equal(shouldMaintainContext(M({ type: 'C' }), FLAG_ON).run, false);
    assert.equal(shouldMaintainContext(M({ status: 'blocked' }), FLAG_ON).run, false);
    assert.equal(shouldMaintainContext(M({ project_id: null }), FLAG_ON).run, false);
  });
  it('is null-safe', () => {
    assert.equal(shouldMaintainContext(null, FLAG_ON).run, false);
    assert.equal(shouldMaintainContext(M(), null).run, false);
  });
});

describe('buildMaintenancePrompt', () => {
  it('carries the steward disposition, the project, the outcome, and a strict JSON contract', () => {
    const p = buildMaintenancePrompt(M({ title: 'Add FAQ', output: 'FAQ planned' }), { id: 'tachin-web', name: 'Tachin Web', context: { a: 1 } });
    assert.match(p, /temporal-memory organ/);
    assert.match(p, /steward/i);
    assert.match(p, /Tachin Web/);
    assert.match(p, /Add FAQ/);
    assert.match(p, /FAQ planned/);
    assert.match(p, /"update"/);
    assert.match(p, /EMPTY string if nothing durable/i);
  });
  it('bounds long outcomes and is null-safe on context', () => {
    const p = buildMaintenancePrompt(M({ output: 'x'.repeat(9000) }), { id: 'p' });
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /CURRENT CONTEXT: \(none\)/);
  });
});

describe('parseMaintenanceResponse', () => {
  it('extracts a durable update', () => {
    assert.equal(parseMaintenanceResponse('{"update": "Now uses a git source of truth."}').update, 'Now uses a git source of truth.');
  });
  it('returns empty when nothing was learned', () => {
    assert.equal(parseMaintenanceResponse('{"update": ""}').update, '');
  });
  it('extracts JSON embedded in prose', () => {
    assert.equal(parseMaintenanceResponse('Here is my note:\n{"update": "X changed."}\ndone').update, 'X changed.');
  });
  it('never throws on garbage / empty / non-string update', () => {
    assert.equal(parseMaintenanceResponse('not json').update, '');
    assert.equal(parseMaintenanceResponse('').update, '');
    assert.equal(parseMaintenanceResponse('{"update": 42}').update, '');
  });
  it('caps the update at 400 chars', () => {
    assert.equal(parseMaintenanceResponse(JSON.stringify({ update: 'y'.repeat(900) })).update.length, 400);
  });
});
