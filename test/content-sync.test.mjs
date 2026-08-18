// test/content-sync.test.mjs — applying a release to an agent
//
// The properties that keep an apply safe, each traceable to a way the previous
// mechanism was unsafe:
//
//   * a partial or wrong render never reaches the live tree (assemble-persona
//     appended straight into the live SOUL.md);
//   * content never changes under running work (C-32);
//   * a compiled spec that differs from the assigned digest is refused, because
//     installing it would make the validation and approval meaningless;
//   * a file the new bundle drops is removed, not left behind (the drift that
//     let an agent keep a skill after the release that removed it).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planApply, verifyStaged, isIdle, reconcile, installPath, installPaths,
  managedFromRecord, STAGING_DIR,
} from '../platform/deployment/content-sync.mjs';
import { bytesDigest, treeDigest } from '../platform/contracts/digest.mjs';

const files = { 'workspace-cortex/SOUL.md': '# cortex\n', 'skills/a/SKILL.md': '# a\n' };
const specFor = (f) => ({
  digest: 'sha256:' + '1'.repeat(64),
  bundle: {
    tree_digest: treeDigest(f),
    files: Object.fromEntries(Object.entries(f).map(([p, c]) => [p, bytesDigest(c)])),
  },
});

// ── planApply ──────────────────────────────────────────────────────────

test('an unchanged bundle plans no writes', () => {
  const current = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, bytesDigest(c)]));
  const plan = planApply(current, files);
  assert.deepEqual(plan.write, []);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.unchanged.length, 2, 'a no-op apply must report a no-op, not 27 files written');
});

test('only changed files are written', () => {
  const current = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, bytesDigest(c)]));
  const next = { ...files, 'skills/a/SKILL.md': '# a, revised\n' };
  const plan = planApply(current, next);
  assert.deepEqual(plan.write, ['skills/a/SKILL.md']);
  assert.deepEqual(plan.unchanged, ['workspace-cortex/SOUL.md']);
});

test('a file the new bundle drops is removed, not left behind', () => {
  const current = {
    ...Object.fromEntries(Object.entries(files).map(([p, c]) => [p, bytesDigest(c)])),
    'skills/retired/SKILL.md': bytesDigest('# retired\n'),
  };
  const plan = planApply(current, files);
  assert.deepEqual(plan.remove, ['skills/retired/SKILL.md'],
    'leaving it behind is how an agent keeps a skill after the release that removed it');
});

test('a first apply writes everything', () => {
  const plan = planApply({}, files);
  assert.equal(plan.write.length, 2);
  assert.deepEqual(plan.remove, []);
});

// ── verifyStaged ───────────────────────────────────────────────────────

test('a faithful render verifies', () => {
  const v = verifyStaged(files, specFor(files));
  assert.equal(v.ok, true, v.reason);
});

test('a corrupted file is caught before anything live is touched', () => {
  const staged = { ...files, 'skills/a/SKILL.md': '# a, tampered\n' };
  const v = verifyStaged(staged, specFor(files));
  assert.equal(v.ok, false);
  assert.match(v.reason, /digest mismatch/);
});

test('a missing file is caught', () => {
  const staged = { 'workspace-cortex/SOUL.md': files['workspace-cortex/SOUL.md'] };
  const v = verifyStaged(staged, specFor(files));
  assert.equal(v.ok, false);
  assert.match(v.reason, /missing from the staged render/);
});

test('an extra file is caught — per-file checks alone would pass it', () => {
  const staged = { ...files, 'skills/smuggled/SKILL.md': '# not in the spec\n' };
  const v = verifyStaged(staged, specFor(files));
  assert.equal(v.ok, false);
  assert.match(v.reason, /staged but not declared/);
});

// ── Idle boundary (C-32) ───────────────────────────────────────────────

test('an agent with a mission in flight is not idle', () => {
  const r = isIdle([{ status: 'active', owner: 'm@x', type: 'M' }], { owner: 'm@x' });
  assert.equal(r.idle, false);
  assert.match(r.reason, /idle boundary/);
});

test('another agent\'s work does not block this one', () => {
  const r = isIdle([{ status: 'active', owner: 'other@x', type: 'M' }], { owner: 'm@x' });
  assert.equal(r.idle, true);
});

test('paused work does not block an apply', () => {
  const r = isIdle([{ status: 'needs_input', owner: 'm@x', type: 'M' }], { owner: 'm@x' });
  assert.equal(r.idle, true, 'a mission awaiting a human is not mid-thought');
});

test('an emergency rollback does not wait for a boundary', () => {
  const r = isIdle([{ status: 'active', owner: 'm@x', type: 'M' }], { owner: 'm@x', emergency: true });
  assert.equal(r.idle, true);
  assert.match(r.reason, /emergency/);
});

// ── reconcile ──────────────────────────────────────────────────────────

const assignment = (over = {}) => ({
  id: 'millie', role_id: 'assistant',
  desired_release: 'fr-1', desired_spec_digest: 'sha256:' + '1'.repeat(64),
  actual_release: null, actual_spec_digest: null, drift: 'pending', ...over,
});

test('an unmanaged agent is skipped, not failed', () => {
  const r = reconcile({ assignment: null, spec: specFor(files), envelopes: [], agentEmail: 'm@x' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /not managed by a fleet release/);
});

test('a converged agent does nothing', () => {
  const spec = specFor(files);
  const r = reconcile({
    assignment: assignment({ actual_release: 'fr-1', actual_spec_digest: spec.digest }),
    spec, envelopes: [], agentEmail: 'm@x',
  });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'already converged');
});

test('a spec that differs from the assigned digest is REFUSED', () => {
  const spec = { ...specFor(files), digest: 'sha256:' + '9'.repeat(64) };
  const r = reconcile({ assignment: assignment(), spec, envelopes: [], agentEmail: 'm@x' });
  assert.equal(r.action, 'fail');
  assert.match(r.reason, /not the content approved/);
  assert.equal(r.detail.computed, spec.digest);
});

test('a pending apply waits while work is in flight', () => {
  const r = reconcile({
    assignment: assignment(), spec: specFor(files),
    envelopes: [{ status: 'active', owner: 'm@x', type: 'M' }], agentEmail: 'm@x',
  });
  assert.equal(r.action, 'wait');
});

test('a pending apply proceeds at an idle boundary', () => {
  const r = reconcile({ assignment: assignment(), spec: specFor(files), envelopes: [], agentEmail: 'm@x' });
  assert.equal(r.action, 'apply');
  assert.equal(r.detail.release, 'fr-1');
});

test('an uncompilable release fails rather than silently skipping', () => {
  const r = reconcile({ assignment: assignment(), spec: null, envelopes: [], agentEmail: 'm@x' });
  assert.equal(r.action, 'fail');
  assert.match(r.reason, /could not compile/);
});

// ── Install layout ─────────────────────────────────────────────────────

test('cortex keeps its historical workspace path', () => {
  assert.equal(installPath('workspace-cortex/SOUL.md'), 'workspace/SOUL.md',
    'every manifest and daemon path already assumes workspace/, not workspace-cortex/');
  assert.equal(installPath('workspace-motor/SOUL.md'), 'workspace-motor/SOUL.md');
  assert.equal(installPath('skills/a/SKILL.md'), 'skills/a/SKILL.md');
});

test('install paths are derived from the bundle, not hard-coded', () => {
  assert.deepEqual(installPaths(files), ['skills/a/SKILL.md', 'workspace/SOUL.md']);
});

// ── The upgrade coupling is gone (C-36) ────────────────────────────────

test('upgrade-corekit no longer syncs content', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(repo, 'corekit', 'system', 'upgrade-corekit'), 'utf8');

  assert.doesNotMatch(src, /CUSTOM_SKILLS_DIR/, 'the upgrade must not install content');
  assert.doesNotMatch(src, /Syncing custom skills from Firestore/);
  assert.match(src, /agent-content-sync/, 'and should say where content comes from instead');
});

test('the daemon and its timer ship together', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = readFileSync(join(repo, 'infra', 'manifests', 'base.txt'), 'utf8');

  for (const entry of ['agent-content-sync.mjs', 'agent-content-sync.service', 'agent-content-sync.timer']) {
    assert.match(manifest, new RegExp(entry.replace('.', '\\.')), `${entry} must be manifest-installed (C-9)`);
  }
});

test('the staging directory is dotted, so it is never mistaken for installed content', () => {
  assert.ok(STAGING_DIR.startsWith('.'));
  // It is also the interrupted-apply marker, so it must not collide with a
  // bundle path — a managed file named the same would make every pass look
  // interrupted.
  assert.ok(!installPaths(files).some((p) => p.startsWith(STAGING_DIR)));
});

// ---- The interrupted-apply marker (P0-6, narrowed) --------------------------
//
// After an apply dies mid-swap the live tree is already mixed. Waiting for an
// idle boundary then prolongs exactly the harm C-32 names, and inFlight() fails
// closed to "busy", so under a Firestore error the wait never ends.

test('an interrupted apply converges even while work is in flight', () => {
  const r = reconcile({
    assignment: assignment(), spec: specFor(files),
    envelopes: [{ status: 'active', owner: 'm@x', type: 'M' }], agentEmail: 'm@x',
    interrupted: true,
  });
  assert.equal(r.action, 'apply');
  assert.match(r.reason, /already mixed/);
});

// The negative half. Without this the escape hatch has quietly repealed C-32 and
// nothing would say so — every guard needs the case where it must NOT fire
// (R-10), and an override is the guard most likely to be tested only one way.
test('work in flight still waits when nothing was interrupted', () => {
  const r = reconcile({
    assignment: assignment(), spec: specFor(files),
    envelopes: [{ status: 'active', owner: 'm@x', type: 'M' }], agentEmail: 'm@x',
    interrupted: false,
  });
  assert.equal(r.action, 'wait');
});

test('interrupted does not override a digest mismatch', () => {
  // Refusing content that was not approved outranks converging a mixed tree:
  // finishing an apply of the wrong bytes is not a repair.
  const spec = { ...specFor(files), digest: 'sha256:' + '9'.repeat(64) };
  const r = reconcile({
    assignment: assignment(), spec, envelopes: [], agentEmail: 'm@x', interrupted: true,
  });
  assert.equal(r.action, 'fail');
});

test('interrupted does not resurrect an already-converged agent', () => {
  // A stale staging tree left by a crash on a pass that changed nothing must not
  // manufacture work forever. Convergence is judged on the disk, not the marker.
  const spec = specFor(files);
  const installed = {};
  for (const [path, content] of Object.entries(files)) installed[path] = bytesDigest(content);
  const r = reconcile({
    assignment: assignment({ actual_spec_digest: spec.digest, actual_release: 'fr-1' }),
    spec, envelopes: [], agentEmail: 'm@x', installed, interrupted: true,
  });
  assert.equal(r.action, 'skip');
});

// ---- managedFromRecord: null is not empty ----------------------------------
//
// The whole reason this is a pure function: the interesting input is a CORRUPT
// record, and that is unreachable through a daemon that runs on import.

test('a torn CONTENT.json yields null, never an empty managed set', () => {
  const good = JSON.stringify({ managed: { 'skills/a/SKILL.md': 'sha256:aa' } }, null, 2);
  assert.deepEqual(managedFromRecord(good), ['skills/a/SKILL.md']);

  // Truncated exactly the way an interrupted writeFileSync leaves it.
  const torn = good.slice(0, Math.floor(good.length / 2));
  assert.equal(managedFromRecord(torn), null,
    'a half-written record must not read as "this agent manages nothing" — that is '
    + 'how a retired file becomes permanently invisible (Finding D by crash)');

  assert.equal(managedFromRecord(''), null);
  assert.equal(managedFromRecord(null), null);
  assert.equal(managedFromRecord(undefined), null);
});

test('a pre-manifest record yields null, not an empty set', () => {
  // The old record stored only a COUNT. There is no path set to recover, and
  // saying so is the difference between "unknown" and "nothing".
  assert.equal(managedFromRecord(JSON.stringify({ files: 27 })), null);
});

test('managedFromRecord accepts both record shapes', () => {
  assert.deepEqual(managedFromRecord(JSON.stringify({ managed: ['a', 'b'] })), ['a', 'b']);
  assert.deepEqual(managedFromRecord(JSON.stringify({ managed: { a: 'x', b: 'y' } })), ['a', 'b']);
  // Junk entries in an array form are dropped rather than becoming empty paths.
  assert.deepEqual(managedFromRecord(JSON.stringify({ managed: ['a', '', null, 3] })), ['a']);
});
