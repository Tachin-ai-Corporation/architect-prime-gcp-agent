// test/contract-planes.test.mjs — C-7: one compiled contract, provenance per plane
//
// The split is only safe if it is provably lossless and the boundary is
// enforced. Three properties:
//
//   1. Splitting and recompiling reproduces the same effective contract — no
//      value is dropped, renamed or silently defaulted.
//   2. A deployment cannot redefine a Foundation mechanism by moving its key
//      into fleet-policy.json; the attempt is reported, not ignored.
//   3. The checked-in artifact matches its sources, so nobody is reading a
//      contract that no longer reflects what was authored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  PLATFORM_PATHS, isPlatformPath, splitContracts, compileContracts, leafPaths,
} from '../platform/contracts/contract-planes.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));

const PLATFORM = readJson('infra/platform-defaults.json');
const POLICY = readJson('infra/fleet-policy.json');
const COMPILED = readJson('infra/contracts.json');

const sortDeep = (o) => {
  if (Array.isArray(o)) return o.map(sortDeep);
  if (o && typeof o === 'object') {
    return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sortDeep(o[k]); return acc; }, {});
  }
  return o;
};

// ── The artifact matches its sources ───────────────────────────────────

test('the checked-in contracts.json is what its sources compile to', () => {
  const { effective, conflicts } = compileContracts(PLATFORM, POLICY);
  assert.deepEqual(conflicts, [], 'fleet-policy must not set Foundation paths');

  const expected = { ...effective };
  const actual = { ...COMPILED };
  delete expected._provenance;
  delete actual._provenance;

  assert.equal(
    JSON.stringify(sortDeep(actual)),
    JSON.stringify(sortDeep(expected)),
    'infra/contracts.json is stale — run corekit/system/compile-contracts --write'
  );
});

test('compile-contracts --check agrees', () => {
  // The same gate CI runs, exercised here so a local edit fails fast.
  const out = execFileSync('node', [join(REPO, 'corekit', 'system', 'compile-contracts')], {
    cwd: REPO, encoding: 'utf8',
  });
  assert.match(out, /up to date/);
});

test('the compiled artifact records where its values came from', () => {
  assert.ok(COMPILED._provenance, 'the artifact must carry provenance');
  assert.match(COMPILED._provenance._comment, /GENERATED/);
  assert.match(COMPILED._provenance.compiled_from.platform_defaults, /^sha256:[0-9a-f]{64}$/);
  assert.match(COMPILED._provenance.compiled_from.fleet_policy, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(COMPILED._provenance.platform_paths, PLATFORM_PATHS);
});

// ── The split is lossless ──────────────────────────────────────────────

test('splitting the compiled artifact and recompiling is a round trip', () => {
  const { platform, policy } = splitContracts(COMPILED);
  const { effective } = compileContracts(platform, policy);

  const a = { ...COMPILED }; delete a._provenance;
  const b = { ...effective }; delete b._provenance;
  assert.equal(JSON.stringify(sortDeep(a)), JSON.stringify(sortDeep(b)));
});

test('every authored value reaches the compiled artifact exactly once', () => {
  const compiledLeaves = leafPaths(COMPILED).filter((p) => !p.startsWith('_provenance')).sort();
  const authored = [...leafPaths(PLATFORM), ...leafPaths(POLICY)].sort();
  assert.deepEqual(authored, compiledLeaves, 'the two sources must partition the artifact');
  assert.equal(new Set(authored).size, authored.length, 'no path is authored twice');
});

test('the split is not degenerate — both planes carry real values', () => {
  assert.ok(leafPaths(PLATFORM).length >= 20, 'Foundation must own the mechanism');
  assert.ok(leafPaths(POLICY).length >= 100, 'the deployment must own its choices');
});

// ── The boundary is enforced ───────────────────────────────────────────

test('policy attempting to redefine a Foundation path is reported, not ignored', () => {
  const { conflicts } = compileContracts(
    { gateway: { port: 18789 }, agents: { defaultId: 'cortex' } },
    { gateway: { port: 9999 }, vertex: { location: 'global' } }
  );
  assert.deepEqual(conflicts, ['gateway.port']);
});

test('a rejected override does not leak into the effective contract', () => {
  const { effective } = compileContracts(
    { gateway: { port: 18789 } },
    { gateway: { port: 9999, timeoutSeconds: 180 } }
  );
  assert.equal(effective.gateway.port, 18789, 'Foundation wins');
  assert.equal(effective.gateway.timeoutSeconds, 180, 'policy still contributes its own keys');
});

test('a mixed subtree splits leaf by leaf', () => {
  // `vertex` holds both an ABI fact (context_windows) and a deployment choice
  // (which model to run). Neither may swallow the other.
  assert.ok(isPlatformPath('vertex.context_windows'));
  assert.ok(!isPlatformPath('vertex.models'));
  assert.ok(PLATFORM.vertex?.context_windows, 'context windows are Foundation');
  assert.ok(!PLATFORM.vertex?.models, 'model choice is not Foundation');
  assert.ok(POLICY.vertex?.models, 'model choice is deployment policy');
  assert.ok(!POLICY.vertex?.context_windows, 'a deployment does not decide a model context window');
});

test('the Foundation set holds mechanism, not choices', () => {
  // Spot-check the classification test from C-29: would two unrelated
  // deployments reasonably want different values?
  for (const mechanism of ['agents', 'gateway.port', 'versioning', 'workspaces', 'env', 'tools']) {
    assert.ok(isPlatformPath(mechanism), `${mechanism} is machinery`);
  }
  for (const choice of ['vertex.models', 'dispatch.max_iterations', 'github.owner', 'git.bucket', 'mouth.model']) {
    assert.ok(!isPlatformPath(choice), `${choice} is a deployment choice`);
  }
});

test('the organ topology is Foundation-owned (B-36)', () => {
  assert.deepEqual(
    Object.keys(PLATFORM.agents).sort(),
    ['defaultId', 'subagentIds'],
    'which organs exist is machinery, not a deployment preference'
  );
  assert.equal(POLICY.agents, undefined);
});

test('the tenant bucket stays deployment-owned while the substrate protocol does not', () => {
  assert.ok(POLICY.git?.bucket, 'the bucket name is tenant-specific');
  assert.ok(PLATFORM.git?.defaultBranch, 'the CAS protocol is Foundation');
  assert.ok(PLATFORM.git?.maxPushRetries !== undefined);
});
