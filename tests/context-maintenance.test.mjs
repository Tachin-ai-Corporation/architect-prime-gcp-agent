// tests/context-maintenance.test.mjs — pure-core tests for the temporal-memory auto-maintenance reflex.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMaintainContext, buildMaintenancePrompt, parseMaintenanceResponse, shouldMaintainProcesses, buildProcessMaintenancePrompt } from '../platform/context/context-maintenance.mjs';

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
  it('caps the update at 400 chars by default', () => {
    assert.equal(parseMaintenanceResponse(JSON.stringify({ update: 'y'.repeat(900) })).update.length, 400);
  });
  it('honors a custom cap (playbook narratives use 700)', () => {
    assert.equal(parseMaintenanceResponse(JSON.stringify({ update: 'y'.repeat(900) }), 700).update.length, 700);
  });
});

const MP = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'tachin-web', recalled_processes: ['p-audit', 'p-review'], ...over });

describe('shouldMaintainProcesses', () => {
  it('runs for a completed mission that recalled playbooks (flag on); dedups + bounds to 3', () => {
    const r = shouldMaintainProcesses(MP({ recalled_processes: ['a', 'a', 'b', 'c', 'd'] }), FLAG_ON);
    assert.equal(r.run, true);
    assert.deepEqual(r.processIds, ['a', 'b', 'c']);
  });
  it('does not run with no recalled playbooks, flag off, or a non-complete mission', () => {
    assert.equal(shouldMaintainProcesses(MP({ recalled_processes: [] }), FLAG_ON).run, false);
    assert.equal(shouldMaintainProcesses(MP({ recalled_processes: null }), FLAG_ON).run, false);
    assert.equal(shouldMaintainProcesses(MP(), FLAG_OFF).run, false);
    assert.equal(shouldMaintainProcesses(MP({ status: 'blocked' }), FLAG_ON).run, false);
  });
  it('is null-safe and filters non-string ids', () => {
    assert.equal(shouldMaintainProcesses(null, FLAG_ON).run, false);
    assert.deepEqual(shouldMaintainProcesses(MP({ recalled_processes: ['ok', 42, '', null] }), FLAG_ON).processIds, ['ok']);
  });
});

describe('buildProcessMaintenancePrompt', () => {
  it('frames a conservative narrative refinement with the playbook, the mission, and a strict JSON contract', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p-audit', name: 'Codebase Audit', narrative: 'An audit measures.' }, MP({ title: 'Audit X', output: 'found 3 issues' }));
    assert.match(p, /PROCESS PLAYBOOK/);
    assert.match(p, /Codebase Audit/);
    assert.match(p, /An audit measures/);
    assert.match(p, /Audit X/);
    assert.match(p, /NO tool[\s\S]*syntax/i);
    assert.match(p, /EMPTY string to leave it as-is/i);
    assert.match(p, /"update"/);
  });
  it('bounds long outcomes and is null-safe on narrative', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p' }, MP({ output: 'z'.repeat(9000) }));
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /CURRENT NARRATIVE: \(none\)/);
  });
});
