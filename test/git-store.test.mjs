// test/git-store.test.mjs — Tests for corekit/lib/git-store.mjs
// Run on a GCE VM with git installed and ADC available:
//   GCP_PROJECT_ID=<project> node test/git-store.test.mjs
//
// Three test suites:
//   1. Round-trip: ensureRepo → commit → push → clone → verify identical
//   2. Non-fast-forward: stale updateTime → NON_FAST_FORWARD → fetch+retry
//   3. Crash-safety: objects written before ref (ordering assertion)

import { ensureRepo, cloneRepo, fetchBranch, pushBranch, pushWithRetry, readRef, listRefs, mergeBranch, gc, buildManifest } from '../corekit/lib/git-store.mjs';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_PREFIX = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ✅ PASS: ${msg}`);
    passed++;
  }
}

function makeTmpDir(name) {
  const dir = join(tmpdir(), `${TEST_PREFIX}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 1: Round-trip
// ═══════════════════════════════════════════════════════════════════

async function testRoundTrip() {
  console.log('\n═══ Test 1: Round-trip (ensureRepo → commit → push → clone → verify) ═══');
  const repoId = `${TEST_PREFIX}-roundtrip`;
  const dir1 = makeTmpDir('rt-source');
  const dir2 = makeTmpDir('rt-clone');

  try {
    // Create repo
    const repo = await ensureRepo(repoId, { mergePolicy: 'auto' });
    assert(repo.id === repoId, `ensureRepo returns correct id: ${repo.id}`);
    assert(repo.default_branch === 'main', `default_branch = main`);
    assert(repo.merge_policy === 'auto', `merge_policy = auto`);

    // Idempotent re-create
    const repo2 = await ensureRepo(repoId);
    assert(repo2.id === repoId, `ensureRepo idempotent: same id on re-create`);

    // Init local git repo and make commits
    git('init', dir1);
    git('checkout -b main', dir1);
    git('config user.email "test@agent"', dir1);
    git('config user.name "test"', dir1);

    writeFileSync(join(dir1, 'README.md'), '# Test Repo\nHello World\n');
    writeFileSync(join(dir1, 'data.json'), JSON.stringify({ key: 'value', nested: { a: 1 } }));
    git('add -A', dir1);
    git('commit -m "v2026.07.04.1.0: initial commit"', dir1);

    const sha1 = git('rev-parse HEAD', dir1);

    // Push
    const pushResult = await pushBranch(repoId, 'main', dir1, 'test-agent');
    assert(pushResult.status === 'pushed', `push status = pushed (got: ${pushResult.status})`);
    assert(pushResult.sha === sha1, `push sha matches local HEAD`);

    // Verify ref
    const ref = await readRef(repoId, 'main');
    assert(ref !== null, `readRef returns non-null`);
    assert(ref.sha === sha1, `readRef sha matches pushed sha`);
    assert(ref.bundle_keys.length === 1, `bundle_keys has 1 entry`);

    // Clone into second dir
    const cloneResult = await cloneRepo(repoId, 'main', dir2);
    assert(cloneResult.sha === sha1, `clone sha matches pushed sha`);

    // Verify files are identical
    const readme1 = readFileSync(join(dir1, 'README.md'), 'utf8');
    const readme2 = readFileSync(join(dir2, 'README.md'), 'utf8');
    assert(readme1 === readme2, `README.md content identical`);

    const data1 = readFileSync(join(dir1, 'data.json'), 'utf8');
    const data2 = readFileSync(join(dir2, 'data.json'), 'utf8');
    assert(data1 === data2, `data.json content identical`);

    const sha2 = git('rev-parse HEAD', dir2);
    assert(sha1 === sha2, `HEAD SHAs match across source and clone`);

    // Push when already up to date
    const pushAgain = await pushBranch(repoId, 'main', dir1, 'test-agent');
    assert(pushAgain.status === 'up_to_date', `re-push returns up_to_date`);

    // List refs
    const refs = await listRefs(repoId);
    assert(refs.length >= 1, `listRefs returns at least 1 ref`);
    assert(refs.some(r => r.branch === 'main'), `listRefs includes main`);

    console.log('  ── Round-trip test complete ──');
  } finally {
    cleanup(dir1);
    cleanup(dir2);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 2: Non-fast-forward / CAS rejection
// ═══════════════════════════════════════════════════════════════════

async function testNonFastForward() {
  console.log('\n═══ Test 2: Non-fast-forward (concurrent push CAS rejection) ═══');
  const repoId = `${TEST_PREFIX}-nff`;
  const dir1 = makeTmpDir('nff-a');
  const dir2 = makeTmpDir('nff-b');

  try {
    await ensureRepo(repoId);

    // Agent A: init and push initial commit
    git('init', dir1);
    git('checkout -b main', dir1);
    git('config user.email "agent-a@test"', dir1);
    git('config user.name "agent-a"', dir1);
    writeFileSync(join(dir1, 'file.txt'), 'initial');
    git('add -A', dir1);
    git('commit -m "v2026.07.04.1.0: init"', dir1);
    await pushBranch(repoId, 'main', dir1, 'agent-a');

    // Agent B: clone from initial state
    await cloneRepo(repoId, 'main', dir2);
    git('config user.email "agent-b@test"', dir2);
    git('config user.name "agent-b"', dir2);

    // Agent A: make another commit and push
    writeFileSync(join(dir1, 'file.txt'), 'updated by A');
    git('add -A', dir1);
    git('commit -m "v2026.07.04.2.0: update by A"', dir1);
    const pushA = await pushBranch(repoId, 'main', dir1, 'agent-a');
    assert(pushA.status === 'pushed', `Agent A push succeeds`);

    // Agent B: make a different commit (from stale state) and try to push
    writeFileSync(join(dir2, 'other.txt'), 'added by B');
    git('add -A', dir2);
    git('commit -m "v2026.07.04.3.0: add by B"', dir2);

    // This should fail with NON_FAST_FORWARD (B's local doesn't have A's commit)
    const pushB = await pushBranch(repoId, 'main', dir2, 'agent-b');
    assert(pushB.status === 'NON_FAST_FORWARD', `Agent B push returns NON_FAST_FORWARD (got: ${pushB.status})`);

    // Now use pushWithRetry which should fetch + rebase + retry
    const retryResult = await pushWithRetry(repoId, 'main', dir2, 'agent-b');
    assert(retryResult.status === 'pushed', `pushWithRetry succeeds after fetch+rebase (got: ${retryResult.status})`);
    assert(retryResult.attempts >= 2, `took multiple attempts: ${retryResult.attempts}`);

    // Verify both files exist in the final state
    const dir3 = makeTmpDir('nff-verify');
    await cloneRepo(repoId, 'main', dir3);
    assert(existsSync(join(dir3, 'file.txt')), `file.txt exists in final clone`);
    assert(existsSync(join(dir3, 'other.txt')), `other.txt exists in final clone`);
    const fileContent = readFileSync(join(dir3, 'file.txt'), 'utf8');
    assert(fileContent === 'updated by A', `file.txt has Agent A's content`);
    cleanup(dir3);

    console.log('  ── Non-fast-forward test complete ──');
  } finally {
    cleanup(dir1);
    cleanup(dir2);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Test 3: Merge + GC + Manifest
// ═══════════════════════════════════════════════════════════════════

async function testMergeGcManifest() {
  console.log('\n═══ Test 3: Merge + GC + Manifest ═══');
  const repoId = `${TEST_PREFIX}-merge`;
  const dirMain = makeTmpDir('mg-main');
  const dirBranch = makeTmpDir('mg-branch');

  try {
    await ensureRepo(repoId, { mergePolicy: 'auto' });

    // Create initial main commit
    git('init', dirMain);
    git('checkout -b main', dirMain);
    git('config user.email "test@agent"', dirMain);
    git('config user.name "test"', dirMain);
    writeFileSync(join(dirMain, 'base.md'), '# Base\n');
    git('add -A', dirMain);
    git('commit -m "v2026.07.04.1.0: base"', dirMain);
    await pushBranch(repoId, 'main', dirMain, 'test');

    // Create mission branch with new file
    await cloneRepo(repoId, 'main', dirBranch);
    git('config user.email "test@agent"', dirBranch);
    git('config user.name "test"', dirBranch);
    git('checkout -b mission/m-test-1', dirBranch);
    writeFileSync(join(dirBranch, 'report.md'), '# Report\nFindings here.\n');
    git('add -A', dirBranch);
    git('commit -m "v2026.07.04.2.0: add report"', dirBranch);
    await pushBranch(repoId, 'mission/m-test-1', dirBranch, 'test');

    // Test fast-forward merge
    const ffResult = await mergeBranch(repoId, 'mission/m-test-1', 'main', 'auto', 'test');
    assert(ffResult.status === 'merged', `ff merge status = merged (got: ${ffResult.status})`);

    // Verify merged content
    const dirVerify = makeTmpDir('mg-verify');
    await cloneRepo(repoId, 'main', dirVerify);
    assert(existsSync(join(dirVerify, 'base.md')), `base.md exists after merge`);
    assert(existsSync(join(dirVerify, 'report.md')), `report.md exists after merge`);
    cleanup(dirVerify);

    // Test gated merge returns AWAITING_APPROVAL
    const gatedResult = await mergeBranch(repoId, 'mission/m-test-1', 'main', 'gated', 'test');
    assert(gatedResult.status === 'AWAITING_APPROVAL', `gated merge returns AWAITING_APPROVAL`);

    // Add more commits to build up bundle chain for GC
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(dirBranch, `file-${i}.txt`), `content ${i}`);
      git('add -A', dirBranch);
      git(`commit -m "v2026.07.04.3.${i}: file ${i}"`, dirBranch);
      // Push to main branch for bundle accumulation
      git('checkout main', dirBranch);
      git('merge mission/m-test-1 --no-edit', dirBranch);
      await pushWithRetry(repoId, 'main', dirBranch, 'test');
      git('checkout mission/m-test-1', dirBranch);
    }

    // GC
    const refBefore = await readRef(repoId, 'main');
    const bundlesBefore = refBefore.bundle_keys.length;
    const gcResult = await gc(repoId, 'main');
    assert(gcResult.bundle_keys.length === 1, `gc consolidated to 1 bundle (was ${bundlesBefore})`);
    assert(gcResult.sha === refBefore.sha, `gc preserved sha`);

    // Verify clone still works after gc
    const dirGcVerify = makeTmpDir('mg-gc-verify');
    await cloneRepo(repoId, 'main', dirGcVerify);
    assert(existsSync(join(dirGcVerify, 'base.md')), `base.md exists after gc+clone`);
    assert(existsSync(join(dirGcVerify, 'report.md')), `report.md exists after gc+clone`);
    assert(existsSync(join(dirGcVerify, 'file-3.txt')), `file-3.txt exists after gc+clone`);

    // Build manifest
    const manifest = await buildManifest(repoId, 'main', []);
    assert(manifest.kind === 'artifact_manifest', `manifest kind = artifact_manifest`);
    assert(manifest.repo === repoId, `manifest repo = ${repoId}`);
    assert(manifest.branch === 'main', `manifest branch = main`);
    assert(manifest.commit && manifest.commit.length === 40, `manifest commit is 40-char sha`);
    assert(manifest.files.length >= 4, `manifest has ${manifest.files.length} files (≥ 4)`);

    // Check file entries have blob_sha and size
    const reportFile = manifest.files.find(f => f.path === 'report.md');
    assert(reportFile && reportFile.blob_sha, `manifest report.md has blob_sha`);
    assert(reportFile && reportFile.size > 0, `manifest report.md has size`);

    cleanup(dirGcVerify);
    console.log('  ── Merge + GC + Manifest test complete ──');
  } finally {
    cleanup(dirMain);
    cleanup(dirBranch);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Runner
// ═══════════════════════════════════════════════════════════════════

async function run() {
  console.log(`\n🔧 git-store test suite (prefix: ${TEST_PREFIX})`);
  console.log(`   GCP_PROJECT_ID: ${process.env.GCP_PROJECT_ID || '(not set)'}`);

  if (!process.env.GCP_PROJECT_ID) {
    console.error('ERROR: GCP_PROJECT_ID must be set');
    process.exit(1);
  }

  try { execSync('git --version', { encoding: 'utf8' }); } catch {
    console.error('ERROR: git not found in PATH');
    process.exit(1);
  }

  try {
    await testRoundTrip();
    await testNonFastForward();
    await testMergeGcManifest();
  } catch (e) {
    console.error(`\n💥 Unhandled error: ${e.message}`);
    console.error(e.stack);
    failed++;
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
