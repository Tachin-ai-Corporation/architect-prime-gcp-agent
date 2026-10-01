// test/ci-node-parity.test.mjs — CI tests each surface on the Node it runs on.
//
// From 2026-08-15 to 2026-10-01 every CI run failed. Four tests imported the
// dashboard's TypeScript directly, which local development's newer Node strips
// natively and CI's Node 20 cannot load at all ("Unknown file extension .ts").
// Raising CI to the newer Node would have hidden the real constraint: the VMs run
// Node 20, so the VM runtime must be tested on 20, while the dashboard runs on the
// Node its image uses. These tests pin that split to its sources of truth, and
// fail locally — with a reason — before CI fails remotely without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/** The Node major a bootstrap installs (nodesource setup_<N>.x). */
function bootstrapNodeMajor(rel) {
  const m = /deb\.nodesource\.com\/setup_(\d+)\.x/.exec(read(rel));
  assert.ok(m, `${rel} no longer installs Node from nodesource — update this test with the new source of truth`);
  return m[1];
}

/** The Node major the dashboard image is built FROM. */
function dashboardNodeMajor() {
  const m = /^FROM node:(\d+)/m.exec(read('app/Dockerfile'));
  assert.ok(m, 'app/Dockerfile no longer starts FROM node:<major>');
  return m[1];
}

/** Each CI job's setup-node versions, keyed by job id (no YAML parser at the repo root). */
function ciNodeVersions() {
  const src = read('.github/workflows/ci.yml');
  const jobsAt = src.indexOf('\njobs:\n');
  assert.ok(jobsAt >= 0, 'ci.yml has no jobs: block');
  const body = src.slice(jobsAt + '\njobs:\n'.length);
  const jobs = {};
  let current = null;
  for (const line of body.split('\n')) {
    const job = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (job) { current = job[1]; jobs[current] = []; continue; }
    const v = /^\s+node-version:\s*['"]?(\d+)['"]?\s*$/.exec(line);
    if (v && current) jobs[current].push(v[1]);
  }
  return jobs;
}

/** Test files under a directory (not recursive), as repo-relative paths. */
const testFiles = (dir) => readdirSync(join(REPO, dir))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => `${dir}/${f}`);

// An import of dashboard TypeScript: static `from '…app/src/….ts'` or dynamic `import('…')`.
const IMPORTS_DASHBOARD_TS = /(?:\bfrom\s+|\bimport\s*\(\s*)['"`](?:\.\.\/)+app\/src\/[^'"`]+\.tsx?['"`]/;

test('both bootstraps install the same Node major', () => {
  assert.equal(bootstrapNodeMajor('infra/bootstrap/fleet-bootstrap.sh'), bootstrapNodeMajor('infra/bootstrap/prime-bootstrap.sh'),
    'a fleet VM and a Prime VM must run the same Node, or CI can only test one of them');
});

test('CI tests the VM runtime on the Node the VMs install', () => {
  const vm = bootstrapNodeMajor('infra/bootstrap/fleet-bootstrap.sh');
  const jobs = ciNodeVersions();
  for (const id of ['unit', 'lint', 'contracts', 'manifest-integrity', 'boundaries']) {
    assert.ok(jobs[id], `ci.yml has no '${id}' job`);
    assert.deepEqual(jobs[id], [vm], `the '${id}' job checks code the VMs run, so it must use Node ${vm}, not ${jobs[id].join(', ') || 'none'}`);
  }
});

test('CI tests the dashboard on the Node its image uses', () => {
  const dash = dashboardNodeMajor();
  const jobs = ciNodeVersions();
  for (const id of ['dashboard', 'dashboard-logic']) {
    assert.ok(jobs[id], `ci.yml has no '${id}' job`);
    assert.deepEqual(jobs[id], [dash], `the '${id}' job must use Node ${dash} (app/Dockerfile), not ${jobs[id].join(', ') || 'none'}`);
  }
});

test('the dashboard logic job runs the dashboard suite, and the unit job does not', () => {
  const src = read('.github/workflows/ci.yml');
  assert.match(src, /run: node --test test\/dashboard\/\*\.test\.mjs/, 'Dashboard Logic must run test/dashboard/');
  assert.match(src, /run: node --test test\/\*\.test\.mjs/, 'the unit job must run test/ (a non-recursive glob)');
});

test('only test/dashboard/ imports dashboard TypeScript — Node 20 cannot load it', () => {
  const offenders = [...testFiles('test'), ...testFiles('tests')]
    .filter((f) => IMPORTS_DASHBOARD_TS.test(read(f)));
  assert.deepEqual(offenders, [],
    'these run on the VMs\' Node in CI, which cannot import .ts — move them to test/dashboard/ ' +
    '(or read the source as text, as test/auth-boundary.test.mjs does)');
});

test('every test in test/dashboard/ really is a dashboard test', () => {
  const files = testFiles('test/dashboard');
  assert.ok(files.length >= 1, 'test/dashboard/ is empty — the Dashboard Logic job would run nothing');
  for (const f of files) {
    assert.match(read(f), IMPORTS_DASHBOARD_TS, `${f} imports no dashboard TypeScript — it belongs in test/, where it runs on the VMs' Node`);
  }
});

test('the detector sees both import forms, and not a source read', () => {
  // Counterfactual for the guard above: a detector that matched nothing would
  // report "no offenders" forever. The samples are assembled at runtime so this
  // file's own source does not match the scan it runs.
  const mod = (up) => `${up}app/src/lib/x.ts`;
  assert.ok(IMPORTS_DASHBOARD_TS.test(`import { x } from '${mod('../')}';`));
  assert.ok(IMPORTS_DASHBOARD_TS.test(`const { x } = await import('${mod('../')}');`));
  assert.ok(IMPORTS_DASHBOARD_TS.test(`import { x } from '${mod('../../')}';`));
  assert.ok(!IMPORTS_DASHBOARD_TS.test(`const src = read('${mod('')}');`));
});
