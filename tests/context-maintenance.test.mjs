// tests/context-maintenance.test.mjs — pure-core tests for the temporal-memory LESSON reflex.
//
// Re-scoped by the memory boundary (BRAIN_CANON B-5): the reflex used to write project context and
// REPLACE playbook narratives; it now asks for a lesson that the daemon appends to working memory.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMaintainContext, buildMaintenancePrompt, parseMaintenanceResponse, shouldMaintainProcesses, buildProcessMaintenancePrompt, lessonLine } from '../platform/context/context-maintenance.mjs';

const FLAG_ON = { dispatch: { context_maintenance: true } };
const FLAG_OFF = { dispatch: { context_maintenance: false } };
const M = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'marketing-site', title: 'g', output: 'o', ...over });

describe('shouldMaintainContext', () => {
  it('runs for a completed mission that touched a project, flag on', () => {
    const r = shouldMaintainContext(M(), FLAG_ON);
    assert.equal(r.run, true);
    assert.equal(r.projectId, 'marketing-site');
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
  it('asks for a lesson for MEMORY, shows the project context read-only, with a strict JSON contract', () => {
    const p = buildMaintenancePrompt(M({ title: 'Add FAQ', output: 'FAQ planned' }), { id: 'marketing-site', name: 'Tachin Web', context: { a: 1 } });
    assert.match(p, /temporal-memory organ/);
    assert.match(p, /MEMORY/);
    assert.match(p, /never written into the project record/i);
    assert.match(p, /PROJECT CONTEXT \(read-only\)/);
    assert.match(p, /Tachin Web/);
    assert.match(p, /Add FAQ/);
    assert.match(p, /FAQ planned/);
    assert.match(p, /"lesson"/);
    assert.doesNotMatch(p, /"update"/, 'the old contract asked for a project-context update');
    assert.match(p, /EMPTY string if nothing durable/i);
  });
  it('bounds long outcomes and is null-safe on context', () => {
    const p = buildMaintenancePrompt(M({ output: 'x'.repeat(9000) }), { id: 'p' });
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /PROJECT CONTEXT \(read-only\): \(none\)/);
  });
});

describe('parseMaintenanceResponse', () => {
  it('extracts a durable lesson', () => {
    assert.equal(parseMaintenanceResponse('{"lesson": "Now uses a git source of truth."}').lesson, 'Now uses a git source of truth.');
  });
  it('still reads the pre-re-scope "update" key, so an organ on the old contract lands in memory', () => {
    assert.equal(parseMaintenanceResponse('{"update": "X changed."}').lesson, 'X changed.');
  });
  it('returns empty when nothing was learned', () => {
    assert.equal(parseMaintenanceResponse('{"lesson": ""}').lesson, '');
  });
  it('extracts JSON embedded in prose and flattens whitespace to one line', () => {
    assert.equal(parseMaintenanceResponse('Here is my note:\n{"lesson": "X\\nchanged."}\ndone').lesson, 'X changed.');
  });
  it('never throws on garbage / empty / non-string lesson', () => {
    assert.equal(parseMaintenanceResponse('not json').lesson, '');
    assert.equal(parseMaintenanceResponse('').lesson, '');
    assert.equal(parseMaintenanceResponse('{"lesson": 42}').lesson, '');
  });
  it('caps the lesson at 300 chars by default, and honors a custom cap', () => {
    assert.equal(parseMaintenanceResponse(JSON.stringify({ lesson: 'y'.repeat(900) })).lesson.length, 300);
    assert.equal(parseMaintenanceResponse(JSON.stringify({ lesson: 'y'.repeat(900) }), 120).lesson.length, 120);
  });
});

describe('lessonLine', () => {
  it('is one scoped working-memory line', () => {
    assert.equal(lessonLine({ scope: 'project', id: 'general', lesson: 'Folder ids live in the project.', date: '2026-09-24' }),
      '- [2026-09-24] lesson (project general): Folder ids live in the project.\n');
    assert.equal(lessonLine({ scope: 'playbook', id: 'p-audit', lesson: 'Read before  you\nwrite.', date: '2026-09-24' }),
      '- [2026-09-24] lesson (playbook p-audit): Read before you write.\n');
  });
  it('is empty when there is no lesson — nothing is appended', () => {
    assert.equal(lessonLine({ scope: 'project', id: 'x', lesson: '   ' }), '');
    assert.equal(lessonLine(), '');
  });
});

const MP = (over = {}) => ({ type: 'M', status: 'complete', project_id: 'marketing-site', recalled_processes: ['p-audit', 'p-review'], ...over });

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
  it('asks for a lesson about the playbook — never a rewrite — with the narrative shown read-only', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p-audit', name: 'Codebase Audit', narrative: 'An audit measures.' }, MP({ title: 'Audit X', output: 'found 3 issues' }));
    assert.match(p, /PROCESS PLAYBOOK/);
    assert.match(p, /Codebase Audit/);
    assert.match(p, /PLAYBOOK NARRATIVE \(read-only\): An audit measures/);
    assert.match(p, /Audit X/);
    assert.match(p, /read-only to memory: you never rewrite it/i);
    assert.match(p, /NO tool[\s\S]*syntax/i);
    assert.match(p, /"lesson"/);
    assert.doesNotMatch(p, /FULL refined narrative|complete replacement narrative/i,
      'the old contract asked for a replacement narrative the daemon wrote over the playbook');
  });
  it('bounds long outcomes and is null-safe on narrative', () => {
    const p = buildProcessMaintenancePrompt({ id: 'p' }, MP({ output: 'z'.repeat(9000) }));
    assert.ok(p.length < 4000, 'prompt stays bounded');
    assert.match(p, /PLAYBOOK NARRATIVE \(read-only\): \(none\)/);
  });
});
