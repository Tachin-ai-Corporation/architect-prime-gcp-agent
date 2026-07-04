// test/git-store.local.test.mjs — Pure-local tests for git-store.mjs
// No network, no GCS, no Firestore. Uses a filesystem-backed mock store.
//
// Test cases:
//   1. A1 regression: two clones diverge → push race → loser's commit survives after retry
//   2. Concurrent merge: two missions merge into main → both file sets present
//   3. BUNDLE_MISSING: delete a bundle from store → hard error (not silent skip)
//   4. Validation: reject invalid repoId/branch names
//
// Run: node --test test/git-store.local.test.mjs
//   or: node test/git-store.local.test.mjs

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  _setTestStore,
  _setTestConfig,
  ensureRepo,
  cloneRepo,
  fetchBranch,
  pushBranch,
  pushWithRetry,
  mergeBranch,
  readRef,
  sanitizeRepoId,
  buildManifest,
} from '../corekit/lib/git-store.mjs';

// ═══════════════════════════════════════════════════════════════════════
//  Filesystem-backed mock store
// ═══════════════════════════════════════════════════════════════════════

/**
 * Creates a filesystem-backed mock that implements the same interface as
 * the real GCS + Firestore helpers. Bundle blobs live in `{root}/gcs/`,
 * Firestore docs live in `{root}/firestore/` as JSON files.
 *
 * CAS is implemented via a per-doc monotonic counter (updateTime).
 */
function createFsStore(rootDir) {
  const gcsDir = join(rootDir, 'gcs');
  const fsDir = join(rootDir, 'firestore');
  mkdirSync(gcsDir, { recursive: true });
  mkdirSync(fsDir, { recursive: true });

  // ---- GCS ----
  function objectFile(bucket, name) {
    // Flatten the object path into a safe filename
    const safe = name.replace(/\//g, '__');
    return join(gcsDir, `${bucket}__${safe}`);
  }

  async function gcsPut(bucket, objectName, data) {
    const file = objectFile(bucket, objectName);
    writeFileSync(file, data);
    return { name: objectName, size: data.length };
  }

  async function gcsGet(bucket, objectName) {
    const file = objectFile(bucket, objectName);
    if (!existsSync(file)) return null;
    return readFileSync(file);
  }

  async function gcsExists(bucket, objectName) {
    return existsSync(objectFile(bucket, objectName));
  }

  async function gcsDelete(bucket, objectName) {
    const file = objectFile(bucket, objectName);
    try { rmSync(file); } catch { /* ignore */ }
    return true;
  }

  // ---- Firestore ----
  function docFile(projectId, docPath) {
    const safe = docPath.replace(/\//g, '__');
    return join(fsDir, `${safe}.json`);
  }

  /** monotonic counter per doc for CAS updateTime simulation */
  const _versions = {};

  async function firestoreRead(projectId, docPath) {
    const file = docFile(projectId, docPath);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  }

  async function firestoreWrite(projectId, docPath, fields, precondition) {
    const file = docFile(projectId, docPath);
    const exists = existsSync(file);
    const current = exists ? JSON.parse(readFileSync(file, 'utf8')) : null;

    // Check precondition
    if (precondition) {
      if (precondition.exists === false && exists) {
        return { ok: false, reason: 'PRECONDITION_FAILED', detail: 'already exists' };
      }
      if (precondition.updateTime && current?.updateTime !== precondition.updateTime) {
        return { ok: false, reason: 'PRECONDITION_FAILED', detail: `updateTime mismatch: expected ${precondition.updateTime}, got ${current?.updateTime}` };
      }
    }

    // Bump version
    const vKey = docPath;
    _versions[vKey] = (_versions[vKey] || 0) + 1;
    const updateTime = `2026-01-01T00:00:${String(_versions[vKey]).padStart(2, '0')}.000Z`;

    const doc = {
      name: `projects/${projectId}/databases/(default)/documents/${docPath}`,
      fields,
      updateTime,
    };
    writeFileSync(file, JSON.stringify(doc, null, 2));
    return { ok: true, result: { writeResults: [{ updateTime }] } };
  }

  async function firestoreDelete(projectId, docPath) {
    const file = docFile(projectId, docPath);
    try { rmSync(file); } catch { /* ignore */ }
    return true;
  }

  async function firestoreList(projectId, collectionPath) {
    // List all docs whose path starts with collectionPath
    const prefix = collectionPath.replace(/\//g, '__');
    const files = readdirSync(fsDir).filter(f => f.startsWith(prefix + '__') && f.endsWith('.json'));
    return files.map(f => JSON.parse(readFileSync(join(fsDir, f), 'utf8')));
  }

  /** Delete a specific GCS object (for BUNDLE_MISSING tests) */
  function deleteGcsObject(bucket, objectName) {
    const file = objectFile(bucket, objectName);
    try { rmSync(file); } catch { /* ignore */ }
  }

  return {
    gcsPut, gcsGet, gcsExists, gcsDelete,
    firestoreRead, firestoreWrite, firestoreDelete, firestoreList,
    // Test helpers
    deleteGcsObject,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Test helpers
// ═══════════════════════════════════════════════════════════════════════

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function makeTmpDir(label) {
  return mkdtempSync(join(tmpdir(), `gs-local-test-${label}-`));
}

function createWorkingTree(dir) {
  mkdirSync(dir, { recursive: true });
  git('init', dir);
  git('checkout -b main', dir);
  // Configure git identity
  git('config user.name "test-agent"', dir);
  git('config user.email "test@agent"', dir);
  // Initial commit so HEAD exists
  writeFileSync(join(dir, '.gitkeep'), '');
  git('add -A', dir);
  git('commit -m "init"', dir);
}

function commitFile(dir, name, content, msg) {
  writeFileSync(join(dir, name), content);
  git('add -A', dir);
  git(`commit -m ${JSON.stringify(msg)}`, dir);
  return git('rev-parse HEAD', dir);
}

// ═══════════════════════════════════════════════════════════════════════
//  Test suite
// ═══════════════════════════════════════════════════════════════════════

let storeRoot;
let store;

before(() => {
  storeRoot = makeTmpDir('store');
  store = createFsStore(storeRoot);
  _setTestStore(store);
  _setTestConfig({
    bucket: 'test-bucket',
    prefix: 'git/',
    defaultBranch: 'main',
    maxPushRetries: 5,
    gcBundleThreshold: 25,
    gcpProject: 'test-project',
  });
});

after(() => {
  _setTestStore(null);
  _setTestConfig(null);
  try { rmSync(storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────
//  Test 1: A1 regression — push race, loser's commit survives
// ─────────────────────────────────────────────────────────────────────

describe('A1 regression: push race', () => {
  const repoId = 'test-a1-race';
  let dirA, dirB;

  before(async () => {
    // Setup: create repo, make an initial commit via agent A, push to establish main
    await ensureRepo(repoId);

    dirA = makeTmpDir('a1-agentA');
    createWorkingTree(dirA);
    const initSha = commitFile(dirA, 'shared.txt', 'initial content', 'v1.0.0: initial');
    const pushInit = await pushBranch(repoId, 'main', dirA, 'agent-a');
    assert.equal(pushInit.status, 'pushed', 'initial push should succeed');

    // Clone the repo into agent B's workspace
    dirB = makeTmpDir('a1-agentB');
    await cloneRepo(repoId, 'main', dirB);
    git('config user.name "agent-b"', dirB);
    git('config user.email "b@agent"', dirB);
  });

  after(() => {
    try { rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('loser commit survives after pushWithRetry', async () => {
    // Agent A makes a new commit and pushes first (wins the race)
    const shaA = commitFile(dirA, 'file-a.txt', 'agent A data', 'v1.0.1: agent A work');
    const pushA = await pushBranch(repoId, 'main', dirA, 'agent-a');
    assert.equal(pushA.status, 'pushed', 'agent A push succeeds (winner)');

    // Agent B makes a different commit (diverging from A)
    const shaB = commitFile(dirB, 'file-b.txt', 'agent B data', 'v1.0.2: agent B work');

    // Agent B tries pushWithRetry — should get NON_FAST_FORWARD, fetch, rebase, retry
    const pushB = await pushWithRetry(repoId, 'main', dirB, 'agent-b');
    assert.equal(pushB.status, 'pushed', 'agent B push succeeds after retry');

    // The critical assertion: both files must exist in the final state
    // Re-read HEAD in B's dir (rebase may have changed it)
    const finalShaB = git('rev-parse HEAD', dirB);
    assert.ok(existsSync(join(dirB, 'file-a.txt')), 'agent A file survives in B workdir');
    assert.ok(existsSync(join(dirB, 'file-b.txt')), 'agent B file survives in B workdir');

    // Verify the remote ref has B's rebased commit
    const ref = await readRef(repoId, 'main');
    assert.equal(ref.sha, finalShaB, 'remote ref points to B\'s rebased HEAD');

    // Clone into a fresh dir and verify both files exist
    const verify = makeTmpDir('a1-verify');
    try {
      await cloneRepo(repoId, 'main', verify);
      assert.ok(existsSync(join(verify, 'file-a.txt')), 'file-a.txt in fresh clone');
      assert.ok(existsSync(join(verify, 'file-b.txt')), 'file-b.txt in fresh clone');
      assert.equal(readFileSync(join(verify, 'file-a.txt'), 'utf8'), 'agent A data');
      assert.equal(readFileSync(join(verify, 'file-b.txt'), 'utf8'), 'agent B data');
    } finally {
      try { rmSync(verify, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Test 2: Concurrent merge — two missions merge into main
// ─────────────────────────────────────────────────────────────────────

describe('Concurrent merge: two missions into main', () => {
  const repoId = 'test-merge-concurrent';
  let dir1, dir2;

  before(async () => {
    // Setup: create repo with initial commit on main
    await ensureRepo(repoId);
    const initDir = makeTmpDir('merge-init');
    createWorkingTree(initDir);
    commitFile(initDir, 'base.txt', 'base', 'v1.0.0: base');
    await pushBranch(repoId, 'main', initDir, 'setup');

    // Mission 1: branch off main, add mission1.txt
    dir1 = makeTmpDir('merge-m1');
    await cloneRepo(repoId, 'main', dir1);
    git('config user.name "m1"', dir1);
    git('config user.email "m1@agent"', dir1);
    git('checkout -b mission/m1', dir1);
    commitFile(dir1, 'mission1.txt', 'mission 1 output', 'v1.0.1: mission 1');
    await pushBranch(repoId, 'mission/m1', dir1, 'm1');

    // Mission 2: branch off main, add mission2.txt
    dir2 = makeTmpDir('merge-m2');
    await cloneRepo(repoId, 'main', dir2);
    git('config user.name "m2"', dir2);
    git('config user.email "m2@agent"', dir2);
    git('checkout -b mission/m2', dir2);
    commitFile(dir2, 'mission2.txt', 'mission 2 output', 'v1.0.2: mission 2');
    await pushBranch(repoId, 'mission/m2', dir2, 'm2');

    rmSync(initDir, { recursive: true, force: true });
  });

  after(() => {
    try { rmSync(dir1, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('both mission file sets present in final main', async () => {
    // Merge mission 1 first
    const merge1 = await mergeBranch(repoId, 'mission/m1', 'main', 'auto', 'm1');
    assert.equal(merge1.status, 'merged', 'mission 1 merges successfully');

    // Merge mission 2 (target has now advanced)
    const merge2 = await mergeBranch(repoId, 'mission/m2', 'main', 'auto', 'm2');
    assert.equal(merge2.status, 'merged', 'mission 2 merges successfully');

    // Verify: clone main and check all files are present
    const verify = makeTmpDir('merge-verify');
    try {
      await cloneRepo(repoId, 'main', verify);
      assert.ok(existsSync(join(verify, 'base.txt')), 'base.txt present');
      assert.ok(existsSync(join(verify, 'mission1.txt')), 'mission1.txt present');
      assert.ok(existsSync(join(verify, 'mission2.txt')), 'mission2.txt present');
      assert.equal(readFileSync(join(verify, 'mission1.txt'), 'utf8'), 'mission 1 output');
      assert.equal(readFileSync(join(verify, 'mission2.txt'), 'utf8'), 'mission 2 output');
    } finally {
      try { rmSync(verify, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Test 3: BUNDLE_MISSING — hard error, not silent skip
// ─────────────────────────────────────────────────────────────────────

describe('BUNDLE_MISSING: hard error on missing bundle', () => {
  const repoId = 'test-bundle-missing';

  it('fetchBranch throws when bundle is deleted from GCS', async () => {
    // Setup: create repo, push an initial commit
    await ensureRepo(repoId);
    const dir = makeTmpDir('bundle-missing');
    createWorkingTree(dir);
    commitFile(dir, 'data.txt', 'important data', 'v1.0.0: data');
    const pushResult = await pushBranch(repoId, 'main', dir, 'test');
    assert.equal(pushResult.status, 'pushed');

    // Read the ref to get bundle keys
    const ref = await readRef(repoId, 'main');
    assert.ok(ref.bundle_keys.length > 0, 'should have at least one bundle key');

    // Delete the bundle from the mock GCS
    const bundleKey = ref.bundle_keys[0];
    const objectPath = `git/${repoId}/bundles/${bundleKey}.bundle`;
    store.deleteGcsObject('test-bucket', objectPath);

    // Now try to fetch into a fresh dir — should HARD FAIL
    const freshDir = makeTmpDir('bundle-fetch');
    try {
      createWorkingTree(freshDir);
      await assert.rejects(
        () => fetchBranch(repoId, 'main', freshDir),
        (err) => {
          assert.ok(err.message.includes('BUNDLE_MISSING'), `error should mention BUNDLE_MISSING, got: ${err.message}`);
          return true;
        },
        'fetchBranch should throw on missing bundle'
      );
    } finally {
      try { rmSync(freshDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Test 4: Validation — reject bad repoId/branch names
// ─────────────────────────────────────────────────────────────────────

describe('Input validation', () => {
  it('rejects repoId with spaces', () => {
    assert.throws(
      () => sanitizeRepoId(''),
      /repoId is required/,
      'empty string should throw'
    );
  });

  it('sanitizeRepoId lowercases and strips invalid chars', () => {
    assert.equal(sanitizeRepoId('My Project!'), 'my-project');
    assert.equal(sanitizeRepoId('UPPER_CASE'), 'upper-case');
    assert.equal(sanitizeRepoId('x;rm -rf'), 'x-rm-rf');
    assert.equal(sanitizeRepoId('normal-repo-123'), 'normal-repo-123');
  });

  it('ensureRepo rejects invalid repoId', async () => {
    await assert.rejects(
      () => ensureRepo('Repo With Space'),
      /Invalid repoId/,
      'repoId with spaces rejected after validation'
    );
    await assert.rejects(
      () => ensureRepo('UPPER'),
      /Invalid repoId/,
      'uppercase repoId rejected'
    );
  });

  it('readRef rejects invalid branch', async () => {
    await assert.rejects(
      () => readRef('valid-repo', 'branch with space'),
      /Invalid branch/,
      'branch with space rejected'
    );
    await assert.rejects(
      () => readRef('valid-repo', ''),
      /Invalid branch/,
      'empty branch rejected'
    );
  });

  it('pushBranch rejects shell injection in repoId', async () => {
    await assert.rejects(
      () => pushBranch('x;rm -rf /', 'main', '/tmp', 'test'),
      /Invalid repoId/,
      'shell injection in repoId rejected'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Test 5: gated merge policy returns AWAITING_APPROVAL
// ─────────────────────────────────────────────────────────────────────

describe('Merge policy: gated', () => {
  const repoId = 'test-gated-merge';

  it('mergeBranch returns AWAITING_APPROVAL for gated policy', async () => {
    await ensureRepo(repoId, { mergePolicy: 'gated' });
    const result = await mergeBranch(repoId, 'mission/test', 'main', 'gated', 'tester');
    assert.equal(result.status, 'AWAITING_APPROVAL', 'gated policy should return AWAITING_APPROVAL');
    assert.equal(result.sha, null, 'no sha for gated merge');
  });
});
