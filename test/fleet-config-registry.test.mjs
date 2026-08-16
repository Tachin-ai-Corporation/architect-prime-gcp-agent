// test/fleet-config-registry.test.mjs — the lifecycle, without GCP
//
// The registry's transport (bundles over GCS, refs in Firestore) is git-store's
// own and already tested. What is new here — and what an operator's safety rests
// on — is the decision layer:
//
//   * a concurrent edit conflicts instead of silently winning (C-31);
//   * re-authoring identical content is a no-op, not fabricated history;
//   * a release refuses to form without validation evidence;
//   * rollback is a pointer operation with a target named in advance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { createRegistry } from '../platform/deployment/registry.mjs';
import { sealRevision } from '../platform/contracts/index.mjs';
import { pathFor } from '../platform/contracts/ids.mjs';

// ── In-memory doubles ──────────────────────────────────────────────────

function fakeDb() {
  const docs = new Map();
  return {
    docs,
    async read(path) { return docs.has(path) ? structuredClone(docs.get(path)) : null; },
    async write(path, data) { docs.set(path, structuredClone(data)); return data; },
    async patch(path, _fields, data) { docs.set(path, { ...(docs.get(path) || {}), ...data }); },
    async del(path) { docs.delete(path); },
    async query(_parent, collectionId, filters = [], opts = {}) {
      const out = [];
      for (const [path, doc] of docs) {
        if (!path.startsWith(`${collectionId}/`)) continue;
        const match = filters.every((f) => doc[f.field] === f.value.stringValue);
        if (match) out.push(structuredClone(doc));
      }
      // Honouring `limit` matters: a caller that reads a capped slice and then
      // filters locally looks correct against an unbounded fake and returns the
      // wrong sample against Firestore.
      return opts.limit ? out.slice(0, opts.limit) : out;
    },
  };
}

/**
 * A git double backed by a directory per branch.
 *
 * Faithful on the property the registry depends on: a clone of a branch yields
 * the files that were pushed to it, and a merge makes a source branch's files
 * visible on the target.
 */
function fakeGit() {
  const root = join(tmpdir(), `fake-git-${process.pid}-${Math.abs(Date.now() % 100000)}`);
  rmSync(root, { recursive: true, force: true });
  const branches = new Map();
  let counter = 0;

  return {
    root, branches,
    async ensureRepo() { mkdirSync(root, { recursive: true }); },
    async cloneRepo(_repo, branch, dest) {
      const src = branches.get(branch);
      if (!src) throw new Error(`no such branch '${branch}'`);
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    },
    async pushWithRetry(_repo, branch, dir) {
      // Faithful to the real store on the property that actually broke: a push
      // carries a COMMIT. git-store answers an uncommitted tree with a
      // success-shaped `up_to_date`, which is how 106 definitions were reported
      // as pushed and none were stored.
      if (!existsSync(join(dir, '.git'))) return { status: 'up_to_date', sha: null };
      let head;
      try {
        head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
      } catch {
        return { status: 'up_to_date', sha: null };
      }
      const dest = join(root, branch.replace(/\//g, '__'));
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(dir, dest, { recursive: true });
      branches.set(branch, dest);
      return { status: 'pushed', sha: head };
    },
    async mergeBranch(_repo, source, target) {
      const src = branches.get(source);
      if (!src) throw new Error(`no such branch '${source}'`);
      const dest = join(root, target.replace(/\//g, '__'));
      // Replace rather than overlay: git object files are read-only, and copying
      // onto an existing one fails with EIO on Windows.
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      branches.set(target, dest);
      counter++;
    },
    async readRef(_repo, branch) {
      // git-store returns { sha, bundle_keys, updateTime } — the registry read
      // `.commit` and always saw undefined.
      return branches.has(branch)
        ? { sha: String(counter).padStart(40, 'a'), bundle_keys: [], updateTime: null }
        : null;
    },
  };
}

function newRegistry(actor = 'prime') {
  const db = fakeDb();
  const git = fakeGit();
  // A fresh registry has NO main — that is the state the first release seeds
  // from, and modelling it as pre-existing hid the seed path entirely.
  return { registry: createRegistry({ projectId: 'test-tenant', actor, db, git, logger: () => {} }), db, git };
}

/** Draft, validate and release one role edit; returns the resulting revision. */
async function release(registry, draft, baseRevision = null) {
  const change = await registry.createChange({
    title: `set ${draft.id}`,
    rationale: 'Inbound tickets are being triaged by hand and the backlog is growing.',
    edits: [{ kind: 'role', draft, baseRevision }],
  });
  assert.equal(change.ok, true, JSON.stringify(change.conflicts));
  await registry.recordValidation(change.change.id, { passed: true, errors: [], checks: ['references'] });
  await registry.createRelease({ changeIds: [change.change.id], platformVersion: 'v1' });
  return change.change.revisions[0].revision;
}

const roleDraft = (over = {}) => ({
  id: 'support-analyst',
  name: 'Customer Support Analyst',
  purpose: 'Classify inbound support tickets and draft replies for human review before anything is sent.',
  owned_outcomes: ['Every ticket is classified within the working day'],
  default_skills: [],
  capabilities: [],
  ...over,
});

// ── Authoring ──────────────────────────────────────────────────────────

test('a first change seals a revision and records it', async () => {
  const { registry, db } = newRegistry();
  const result = await registry.createChange({
    title: 'Add the support analyst role',
    rationale: 'Inbound tickets are being triaged by hand and the backlog is growing.',
    edits: [{ kind: 'role', draft: roleDraft() }],
  });

  assert.equal(result.ok, true, JSON.stringify(result.conflicts));
  assert.match(result.change.id, /^fc-[0-9a-f]{12}$/);
  assert.equal(result.change.status, 'draft');
  assert.equal(result.change.revisions.length, 1);
  assert.equal(result.change.revisions[0].base_revision, null, 'a first revision has no parent');
  assert.ok(db.docs.has(pathFor('fleetChange', result.change.id)));
});

test('re-authoring identical released content is a no-op, not fabricated history', async () => {
  const { registry } = newRegistry();
  const rev = await release(registry, roleDraft());

  const again = await registry.createChange({
    title: 'Add the role again', rationale: 'Same content, submitted a second time by mistake.',
    edits: [{ kind: 'role', draft: roleDraft(), baseRevision: rev }],
  });
  assert.equal(again.ok, false);
  assert.match(again.conflicts[0].reason, /no content changed/);
});

test('an edit without a baseRevision against released content conflicts', async () => {
  const { registry } = newRegistry();
  await release(registry, roleDraft());

  const blind = await registry.createChange({
    title: 'Change the purpose', rationale: 'A second author who did not read the current revision.',
    edits: [{ kind: 'role', draft: roleDraft({ purpose: 'Something entirely different from what it said before.' }) }],
  });
  assert.equal(blind.ok, false);
  assert.equal(blind.conflicts[0].id, 'support-analyst');
  assert.match(blind.conflicts[0].reason, /supply its revision as baseRevision/);
});

test('an edit drafted against a superseded revision conflicts', async () => {
  const { registry } = newRegistry();
  const base = await release(registry, roleDraft());
  // Someone else releases on top of it.
  await release(registry, roleDraft({ decision_posture: 'Drafts, never sends.' }), base);

  const stale = await registry.createChange({
    title: 'A late edit', rationale: 'Drafted before the posture change landed.',
    edits: [{ kind: 'role', draft: roleDraft({ purpose: 'A different purpose entirely, drafted from the old base.' }), baseRevision: base }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflicts[0].expected, base);
  assert.notEqual(stale.conflicts[0].actual, base);
  assert.match(stale.conflicts[0].reason, /moved since this edit was drafted/);
});

test('two drafts from the same base collide at release, not silently (§11.3 #6)', async () => {
  const { registry } = newRegistry();
  const base = await release(registry, roleDraft());

  // Both authors draft concurrently against the same released revision. Drafts
  // live on separate branches, so both legitimately succeed.
  const a = await registry.createChange({
    title: 'A: tighten the posture', rationale: 'Drafts only — it must never send without review.',
    edits: [{ kind: 'role', draft: roleDraft({ decision_posture: 'Drafts, never sends.' }), baseRevision: base }],
  });
  const b = await registry.createChange({
    title: 'B: add an outcome', rationale: 'Response time is the outcome nobody wrote down.',
    edits: [{
      kind: 'role',
      draft: roleDraft({ owned_outcomes: ['Every ticket is classified within the working day', 'First response within an hour'] }),
      baseRevision: base,
    }],
  });
  assert.equal(a.ok, true, 'concurrent drafting is allowed');
  assert.equal(b.ok, true);

  await registry.recordValidation(a.change.id, { passed: true, errors: [], checks: ['references'] });
  await registry.recordValidation(b.change.id, { passed: true, errors: [], checks: ['references'] });

  // Releasing both together would apply one over the other.
  await assert.rejects(
    () => registry.createRelease({ changeIds: [a.change.id, b.change.id], platformVersion: 'v1' }),
    (e) => e.code === 'CONFLICT' && /both modify role\/support-analyst/.test(e.message)
  );

  // A lands.
  await registry.createRelease({ changeIds: [a.change.id], platformVersion: 'v1' });

  // B is now stale, and says so instead of erasing A.
  await assert.rejects(
    () => registry.createRelease({ changeIds: [b.change.id], platformVersion: 'v1' }),
    (e) => e.code === 'CONFLICT' && /moved since change/.test(e.message)
  );
});

test('a revision derived from a released one records its parent', async () => {
  const { registry } = newRegistry();
  const base = await release(registry, roleDraft());

  const second = await registry.createChange({
    title: 'Refine the posture', rationale: 'Make the escalation boundary explicit for billing questions.',
    edits: [{ kind: 'role', draft: roleDraft({ decision_posture: 'Escalates anything touching billing.' }), baseRevision: base }],
  });
  assert.equal(second.ok, true);
  assert.equal(second.change.revisions[0].base_revision, base);
});

// ── Release ────────────────────────────────────────────────────────────

async function draftAndValidate(registry, over = {}) {
  const change = await registry.createChange({
    title: 'Add the support analyst role',
    rationale: 'Inbound tickets are being triaged by hand and the backlog is growing.',
    edits: [{ kind: 'role', draft: roleDraft(over) }],
  });
  assert.equal(change.ok, true, JSON.stringify(change.conflicts));
  await registry.recordValidation(change.change.id, { passed: true, errors: [], checks: ['references', 'no-secrets'] });
  return change.change;
}

test('a release refuses to form without passing validation (C-31)', async () => {
  const { registry } = newRegistry();
  const change = await registry.createChange({
    title: 'Add the role', rationale: 'Inbound tickets are being triaged by hand.',
    edits: [{ kind: 'role', draft: roleDraft() }],
  });
  await assert.rejects(
    () => registry.createRelease({ changeIds: [change.change.id], platformVersion: 'v1' }),
    /no passing validation/
  );
});

test('a validated change releases, pinning its content commit', async () => {
  const { registry } = newRegistry();
  const change = await draftAndValidate(registry);
  const release = await registry.createRelease({ changeIds: [change.id], platformVersion: 'v2026.08.15.4.0' });

  assert.match(release.id, /^fr-[0-9a-f]{12}$/);
  assert.equal(release.status, 'pending');
  assert.equal(release.evidence.validated, true);
  assert.match(release.content_ref.commit, /^[0-9a-f]{40}$/);
  assert.equal(release.parent_release, null, 'the first release has no predecessor');
});

test('recording a failed validation leaves the change in draft', async () => {
  const { registry } = newRegistry();
  const change = await registry.createChange({
    title: 'Add the role', rationale: 'Inbound tickets are being triaged by hand.',
    edits: [{ kind: 'role', draft: roleDraft() }],
  });
  const v = await registry.recordValidation(change.change.id, { passed: false, errors: ['ref:skill'], checks: ['references'] });
  assert.equal(v.passed, false);
  const stored = await registry._db.read(pathFor('fleetChange', change.change.id));
  assert.equal(stored.status, 'draft');
});

// ── Activation and rollback ────────────────────────────────────────────

test('a canary assignment pins the agent and marks the release canary', async () => {
  const { registry } = newRegistry();
  const change = await draftAndValidate(registry);
  const release = await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });

  const written = await registry.assign({
    releaseId: release.id, agents: ['millie'],
    specDigests: { millie: { digest: 'sha256:' + 'a'.repeat(64), roleId: 'support-analyst' } },
    pinned: true,
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].pinned, true, 'a canary does not follow fleet-wide promotion');
  assert.equal(written[0].drift, 'pending');
  const stored = await registry._db.read(pathFor('fleetRelease', release.id));
  assert.equal(stored.status, 'canary');
});

test('reporting applied state closes the desired/actual loop', async () => {
  const { registry } = newRegistry();
  const change = await draftAndValidate(registry);
  const release = await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });
  const digest = 'sha256:' + 'b'.repeat(64);
  await registry.assign({ releaseId: release.id, agents: ['millie'], specDigests: { millie: { digest, roleId: 'support-analyst' } } });

  const converged = await registry.reportApplied({ agentId: 'millie', releaseId: release.id, specDigest: digest });
  assert.equal(converged.drift, 'converged');
  assert.equal(converged.actual_spec_digest, digest);
  assert.ok(converged.applied_at);

  const failed = await registry.reportApplied({ agentId: 'millie', releaseId: release.id, specDigest: digest, error: 'render failed' });
  assert.equal(failed.drift, 'failed');
  assert.equal(failed.last_error, 'render failed');
});

test('a digest that does not match the desired one stays pending, not converged', async () => {
  const { registry } = newRegistry();
  const change = await draftAndValidate(registry);
  const release = await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });
  await registry.assign({
    releaseId: release.id, agents: ['millie'],
    specDigests: { millie: { digest: 'sha256:' + 'c'.repeat(64), roleId: 'support-analyst' } },
  });

  const other = await registry.reportApplied({ agentId: 'millie', releaseId: release.id, specDigest: 'sha256:' + 'd'.repeat(64) });
  assert.equal(other.drift, 'pending', 'applying a different bundle is drift, not convergence');
});

test('rollback is an atomic repoint to a predecessor named in advance', async () => {
  const { registry } = newRegistry();

  const c1 = await draftAndValidate(registry);
  const r1 = await registry.createRelease({ changeIds: [c1.id], platformVersion: 'v1' });
  await registry.assign({ releaseId: r1.id, agents: ['millie'], specDigests: {} });

  const base = c1.revisions[0].revision;
  const c2 = await registry.createChange({
    title: 'A regressive change', rationale: 'This one turns out to make the agent worse.',
    edits: [{ kind: 'role', draft: roleDraft({ decision_posture: 'Sends replies immediately without review.' }), baseRevision: base }],
  });
  await registry.recordValidation(c2.change.id, { passed: true, errors: [], checks: ['references'] });
  const r2 = await registry.createRelease({ changeIds: [c2.change.id], platformVersion: 'v1' });
  assert.equal(r2.parent_release, r1.id, 'the rollback target is recorded when the release is built');
  await registry.assign({ releaseId: r2.id, agents: ['millie'], specDigests: {} });

  const result = await registry.rollback({ releaseId: r2.id, reason: 'accept-criteria pass rate fell below threshold' });
  assert.equal(result.to, r1.id);
  assert.deepEqual(result.agents, ['millie']);

  const assignment = await registry._db.read(pathFor('fleetAssignment', 'millie'));
  assert.equal(assignment.desired_release, r1.id, 'the agent is repointed, not re-authored');
  assert.equal(assignment.drift, 'pending');
  assert.match(assignment.last_error, /rolled back from/);

  assert.equal((await registry._db.read(pathFor('fleetRelease', r2.id))).status, 'rolled-back');
  assert.equal((await registry._db.read(pathFor('fleetRelease', r1.id))).status, 'active');
});

test('rollback refuses when there is no predecessor', async () => {
  const { registry } = newRegistry();
  const change = await draftAndValidate(registry);
  const release = await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });
  await assert.rejects(() => registry.rollback({ releaseId: release.id, reason: 'x' }), /no predecessor/);
});

// ── Integrity on read ──────────────────────────────────────────────────

test('a revision edited outside the lifecycle is excluded and reported', async () => {
  const { registry, git } = newRegistry();
  const change = await draftAndValidate(registry);
  await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });

  // Tamper with the stored content, leaving its recorded digest behind.
  const file = join(git.branches.get('main'), 'roles', 'support-analyst', 'role.json');
  assert.ok(existsSync(file), 'the release wrote the definition to main');
  const record = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8')));
  writeFileSync(file, JSON.stringify({ ...record, purpose: 'Quietly altered on disk, bypassing the lifecycle.' }, null, 2));

  const { definitions, corrupt } = await registry.readDefinitions();
  assert.equal(definitions.has('role/support-analyst'), false, 'tampered content is not served');
  assert.equal(corrupt.length, 1);
  assert.match(corrupt[0].reason, /digest mismatch/);
});

// ── Reading the evidence a release produced ────────────────────────────
//
// The gate reported "0 missions — too early to judge" for a release that had run
// three, all correctly stamped. It read `work` with no filter and a cap, then
// grouped locally; `work` holds every mission the deployment has ever run, so the
// read returned an arbitrary slice that did not contain the release being judged.
// The verdict was indistinguishable from a genuinely young release, so the
// operator would have waited for evidence that could never arrive.

/** Seed n work docs onto a release/digest. */
function seedWork(db, { release, digest, n, prefix = 'w' }) {
  for (let i = 0; i < n; i++) {
    db.docs.set(`work/${prefix}-${release}-${i}`, {
      id: `${prefix}-${release}-${i}`, type: 'M', status: 'complete',
      output: 'done', fleet_release: release, agent_spec_digest: digest,
    });
  }
}

test('reading a release\'s work asks for that release, rather than sampling the collection', async () => {
  const { registry, db } = newRegistry();
  const mine = 'sha256:' + 'a'.repeat(64);
  seedWork(db, { release: 'fr-mine', digest: mine, n: 3 });
  seedWork(db, { release: 'fr-someone-else', digest: 'sha256:' + 'b'.repeat(64), n: 900, prefix: 'x' });

  const { work, truncated, unstamped } = await registry.readReleaseWork('fr-mine', [mine]);
  assert.equal(work.length, 3, 'the release\'s own missions are found regardless of how much other work exists');
  assert.equal(truncated, false);
  assert.equal(unstamped, 0);
});

test('work on the release but from another spec digest is not counted as this one\'s', async () => {
  const { registry, db } = newRegistry();
  const applied = 'sha256:' + 'a'.repeat(64);
  seedWork(db, { release: 'fr-x', digest: applied, n: 2 });
  seedWork(db, { release: 'fr-x', digest: 'sha256:' + 'c'.repeat(64), n: 5, prefix: 'stale' });

  const { work } = await registry.readReleaseWork('fr-x', [applied]);
  assert.equal(work.length, 2, 'an agent mid-apply must not have its old work attributed to the new spec');
});

test('unstamped work is reported, not silently dropped', async () => {
  const { registry, db } = newRegistry();
  const d = 'sha256:' + 'a'.repeat(64);
  seedWork(db, { release: 'fr-x', digest: d, n: 2 });
  db.docs.set('work/w-nostamp', { id: 'w-nostamp', type: 'M', status: 'complete', output: 'ok', fleet_release: 'fr-x' });

  const { work, unstamped } = await registry.readReleaseWork('fr-x', [d]);
  assert.equal(work.length, 2);
  assert.equal(unstamped, 1, 'work that cannot be attributed must be visible, or the sample looks complete');
});

test('a truncated read says so — a sample must not read as a census', async () => {
  const { registry, db } = newRegistry();
  const d = 'sha256:' + 'a'.repeat(64);
  seedWork(db, { release: 'fr-x', digest: d, n: 10 });

  const capped = await registry.readReleaseWork('fr-x', [d], { limit: 4 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.work.length, 4);

  const full = await registry.readReleaseWork('fr-x', [d], { limit: 50 });
  assert.equal(full.truncated, false);
  assert.equal(full.work.length, 10);
});

test('a release with no work reads as empty rather than borrowing another release\'s', async () => {
  const { registry, db } = newRegistry();
  seedWork(db, { release: 'fr-other', digest: 'sha256:' + 'b'.repeat(64), n: 50 });

  const { work } = await registry.readReleaseWork('fr-new', ['sha256:' + 'a'.repeat(64)]);
  assert.deepEqual(work, []);
});

// ── Rollback has a target, even before anything reaches `active` ────────
//
// C-31 makes rollback a pointer operation with a target named in advance. The
// target came from `activeReleaseId()`, which matches only `status === 'active'`
// — but a release reaches `active` only after a full promotion, and a
// canary-first workflow may never take it there. In the first live registry both
// releases sat at `canary`, so every release recorded `parent_release: null` and
// none of them had anywhere to roll back to. `evaluateRollout` can decide
// `rollback`, and `observe --apply` would then find no target and pause instead:
// the one moment the promise matters is the one where it was missing.

const releaseDoc = (id, status, created_at) => ({ id, status, created_at, schema_version: 1 });

test('a canary release is a rollback target, not just an active one', async () => {
  const { registry, db } = newRegistry();
  db.docs.set('fleet_releases/fr-first', releaseDoc('fr-first', 'canary', '2026-08-15T10:00:00Z'));

  assert.equal(await registry.activeReleaseId(), null, 'nothing has been promoted');
  assert.equal(await registry.previousLiveReleaseId(), 'fr-first',
    'but something IS live, and that is what a new release supersedes');
});

test('the newest live release wins', async () => {
  const { registry, db } = newRegistry();
  db.docs.set('fleet_releases/fr-old', releaseDoc('fr-old', 'active', '2026-08-14T10:00:00Z'));
  db.docs.set('fleet_releases/fr-new', releaseDoc('fr-new', 'canary', '2026-08-15T10:00:00Z'));

  assert.equal(await registry.previousLiveReleaseId(), 'fr-new');
});

test('superseded and rolled-back releases are not rollback targets', async () => {
  // Rolling forward onto something already rolled back would undo the undo.
  const { registry, db } = newRegistry();
  db.docs.set('fleet_releases/fr-bad', releaseDoc('fr-bad', 'rolled-back', '2026-08-15T12:00:00Z'));
  db.docs.set('fleet_releases/fr-old', releaseDoc('fr-old', 'superseded', '2026-08-15T11:00:00Z'));
  db.docs.set('fleet_releases/fr-live', releaseDoc('fr-live', 'canary', '2026-08-15T10:00:00Z'));

  assert.equal(await registry.previousLiveReleaseId(), 'fr-live');
});

test('a genuinely first release still has no parent', async () => {
  const { registry } = newRegistry();
  assert.equal(await registry.previousLiveReleaseId(), null, 'null must remain possible, or the first release lies');
});

test('a release created after a canary records it as the rollback target', async () => {
  const { registry, db } = newRegistry();
  const change = await draftAndValidate(registry);
  await registry.createRelease({ changeIds: [change.id], platformVersion: 'v1' });

  // The first release is pending; mark it canary as a real rollout would.
  const first = [...db.docs.entries()].find(([k]) => k.startsWith('fleet_releases/'));
  db.docs.set(first[0], { ...first[1], status: 'canary' });

  // A different role, so this is a genuine second change rather than a
  // baseRevision conflict against the first.
  const second = await draftAndValidate(registry, {
    id: 'billing-analyst',
    name: 'Billing Analyst',
    purpose: 'Reconcile invoices against delivered work and flag discrepancies for a human to settle.',
  });
  const rel2 = await registry.createRelease({ changeIds: [second.id], platformVersion: 'v1' });

  assert.equal(rel2.parent_release, first[1].id,
    'without this, a regressive canary has nowhere to roll back to');
});
