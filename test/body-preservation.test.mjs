// The guard that would have stopped the first autonomous authoring run from
// wiping a skill.
//
// That run handed the motor a 40,268-char procedure to "edit"; the motor
// resubmitted a 166-char rewrite (a 99.6% loss), and it validated and released
// because nothing checked the body survived. Two defenses are tested here:
//   1. catastrophicShrink — the pure predicate: a substantial body collapsing to
//      a stub is refused; ordinary edits and new definitions are not.
//   2. createChange refuses such an edit (fail closed at authoring), and
//      allowShrink is the explicit escape hatch for a genuine rewrite.
//
// The real fix for the failure is `change edit` (surgical find/replace, no large
// body in the caller's hands); this guard is the backstop for when a full body is
// submitted anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { createRegistry, catastrophicShrink } from '../platform/deployment/registry.mjs';

// ---- the pure predicate ---------------------------------------------------

const long = (n) => 'x'.repeat(n);

test('a 40k body collapsing to a stub is caught', () => {
  const r = catastrophicShrink('skill', { procedure: long(40268) }, { procedure: long(166) });
  assert.ok(r, 'the exact failure that shipped must be caught');
  assert.equal(r.field, 'procedure');
  assert.equal(r.before, 40268);
  assert.equal(r.after, 166);
});

test('a new definition (no existing) is never a shrink', () => {
  assert.equal(catastrophicShrink('skill', null, { procedure: long(10) }), null);
});

test('an ordinary edit is not a shrink', () => {
  // Tightening a body by a third is normal authoring, not a collapse.
  assert.equal(catastrophicShrink('skill', { procedure: long(3000) }, { procedure: long(2000) }), null);
});

test('even a large deliberate trim (down to 20%) is allowed', () => {
  // The guard catches near-total loss, not aggressive editing — 85% is the line.
  assert.equal(catastrophicShrink('skill', { procedure: long(1000) }, { procedure: long(200) }), null);
});

test('a small body is not guarded — losing most of 100 chars is not a body collapse', () => {
  assert.equal(catastrophicShrink('skill', { procedure: long(100) }, { procedure: long(1) }), null);
});

test('process narrative and responsibility instruction are guarded too', () => {
  assert.ok(catastrophicShrink('process', { narrative: long(5000) }, { narrative: long(10) }));
  assert.ok(catastrophicShrink('responsibility', { instruction: long(5000) }, { instruction: long(10) }));
});

test('a kind with no substantial body field is never guarded', () => {
  assert.equal(catastrophicShrink('role', { name: long(5000) }, { name: 'x' }), null);
});

// ---- the guard inside createChange ---------------------------------------
// Minimal in-memory doubles — the same shape the registry lifecycle test uses.

function fakeDb() {
  const docs = new Map();
  return {
    docs,
    async read(path) { return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async write(path, data) { docs.set(path, structuredClone(data)); return data; },
    async patch(path, _f, data) { docs.set(path, { ...(docs.get(path) || {}), ...data }); },
    async del(path) { docs.delete(path); },
    async query(_p, collectionId, filters = [], opts = {}) {
      const out = [];
      for (const [path, doc] of docs) {
        if (!path.startsWith(`${collectionId}/`)) continue;
        if (filters.every((f) => doc[f.field] === f.value.stringValue)) out.push(structuredClone(doc));
      }
      return opts.limit ? out.slice(0, opts.limit) : out;
    },
  };
}

function fakeGit() {
  const root = join(tmpdir(), `fake-git-bp-${process.pid}-${Math.abs(Date.now() % 100000)}`);
  rmSync(root, { recursive: true, force: true });
  const branches = new Map();
  let counter = 0;
  return {
    root, branches,
    async ensureRepo() { mkdirSync(root, { recursive: true }); },
    async cloneRepo(_r, branch, dest) {
      const src = branches.get(branch);
      if (!src) throw new Error(`no such branch '${branch}'`);
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    },
    async pushWithRetry(_r, branch, dir) {
      if (!existsSync(join(dir, '.git'))) return { status: 'up_to_date', sha: null };
      let head;
      try { head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim(); }
      catch { return { status: 'up_to_date', sha: null }; }
      const dest = join(root, branch.replace(/\//g, '__'));
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(dir, dest, { recursive: true });
      branches.set(branch, dest);
      return { status: 'pushed', sha: head };
    },
    async mergeBranch(_r, source, target) {
      const src = branches.get(source);
      if (!src) throw new Error(`no such branch '${source}'`);
      const dest = join(root, target.replace(/\//g, '__'));
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      branches.set(target, dest);
      counter++;
    },
    async readRef(_r, branch) {
      return branches.has(branch) ? { sha: String(counter).padStart(40, 'a'), bundle_keys: [], updateTime: null } : null;
    },
  };
}

const skill = (procedure) => ({
  id: 'demo-skill',
  name: 'Demo',
  summary: 'A demo skill for the body-preservation guard test.',
  triggers: ['when demonstrating the guard'],
  procedure,
});

async function seedSkill(registry) {
  // The guard compares an edit against the definition on MAIN, so the seed must be
  // released, not merely drafted — a change alone lives on a change branch and
  // readDefinitions (which reads main) would not see it, leaving `existing` null.
  const r = await registry.createChange({ title: 'seed', edits: [{ kind: 'skill', draft: skill(long(5000)) }] });
  assert.ok(r.ok, `seed failed: ${JSON.stringify(r.conflicts)}`);
  await registry.recordValidation(r.change.id, { passed: true, errors: [], checks: ['references'] });
  await registry.createRelease({ changeIds: [r.change.id], platformVersion: 'v1' });
  return r.change.revisions.find((x) => x.id === 'demo-skill').revision;
}

test('createChange REFUSES an edit that collapses the body', async () => {
  const registry = createRegistry({ projectId: 't', actor: 'prime', db: fakeDb(), git: fakeGit(), logger: () => {} });
  const base = await seedSkill(registry);

  // >= 20 chars so it passes SKILL_SCHEMA (procedure minLength) and actually
  // reaches the guard — the real collapse was 166 chars, well past schema too.
  const stub = 'A stub that replaced the whole body.';
  const r = await registry.createChange({
    title: 'wipe it',
    edits: [{ kind: 'skill', draft: skill(stub), baseRevision: base }],
  });
  assert.equal(r.ok, false, 'a body collapse must not become a change');
  assert.match(r.conflicts[0].reason, /full-body-resubmit|shrink/i);
});

test('allowShrink lets a deliberate rewrite through', async () => {
  const registry = createRegistry({ projectId: 't', actor: 'prime', db: fakeDb(), git: fakeGit(), logger: () => {} });
  const base = await seedSkill(registry);

  const r = await registry.createChange({
    title: 'intended rewrite',
    edits: [{ kind: 'skill', draft: skill('a deliberately shorter but complete rewrite of the procedure body'), baseRevision: base }],
    allowShrink: true,
  });
  assert.equal(r.ok, true, `allowShrink must permit it: ${JSON.stringify(r.conflicts)}`);
});

test('an ordinary edit passes the guard without allowShrink', async () => {
  const registry = createRegistry({ projectId: 't', actor: 'prime', db: fakeDb(), git: fakeGit(), logger: () => {} });
  const base = await seedSkill(registry);

  const r = await registry.createChange({
    title: 'tighten',
    edits: [{ kind: 'skill', draft: skill(long(4200)), baseRevision: base }],
  });
  assert.equal(r.ok, true, `an ordinary edit must not be blocked: ${JSON.stringify(r.conflicts)}`);
});
