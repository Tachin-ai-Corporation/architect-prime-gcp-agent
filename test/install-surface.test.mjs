// test/install-surface.test.mjs — the dest surface is locked; the repo tree is not.
//
// This exists to make a repo restructure a provable no-op for deployed agents.
// A manifest line is `<repo src> <vm dest>`; moving files changes only the left
// column. The lock records the right column — every bundle a deployment can
// produce, folded to one digest over dest→content. Rearranging folders leaves
// it untouched. Changing what an agent receives does not, and then the diff has
// to be stated rather than discovered on a VM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseManifest,
  fragmentsFor,
  resolveBundle,
  bundleDigest,
  installSurface,
  platformJobs,
} from '../corekit/system/install-surface.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repoRoot, 'infra', 'install-surface.lock.json');

/**
 * Dests a later fragment is *meant* to overwrite with different content.
 *
 * Layering by concatenation order is a real mechanism — base ships a default,
 * the role fragment replaces it. The problem is that an intended override and
 * an accidental collision look identical in a manifest, and the collision is
 * only visible once two agents behave differently. base.txt records one that
 * shipped: two fragments installed different `secret-read` scripts to one dest,
 * so the same documented command resolved different secrets by role.
 *
 * Listing the intended ones here makes order-dependence a statement. Anything
 * not listed is a conflict, and the test says which two sources collided.
 */
const DECLARED_OVERRIDES = Object.freeze({
  'corekit/agent-registry.json':
    'base ships the fleet organ defaults; role-prime.txt replaces them with Prime sampling params',
});

describe('install surface — parsing mirrors install.sh', () => {
  it('strips comments, trims, and drops blank lines', () => {
    const entries = parseManifest([
      '# a comment',
      '',
      '   ',
      'a/b c/d   # trailing comment',
      '  e/f   g/h  ',
    ].join('\n'));
    assert.deepEqual(entries.map((e) => [e.src, e.dest]), [['a/b', 'c/d'], ['e/f', 'g/h']]);
  });

  it('recognises the no-clobber marker rather than discarding it', () => {
    const [seed] = parseManifest('brain/SOUL.md workspace/SOUL.md ?');
    assert.equal(seed.noClobber, true);
    const [managed] = parseManifest('brain/SOUL.md workspace/SOUL.md');
    assert.equal(managed.noClobber, false);
  });

  it('ignores a line with no dest — half a pair installs nothing', () => {
    assert.deepEqual(parseManifest('corekit/lib/orphan.mjs'), []);
  });

  it('resolves job fragments operator-first', () => {
    const hasFile = (p) => p === 'operator/manifests/job-pm.txt';
    assert.deepEqual(
      fragmentsFor('fleet', ['pm', 'qa'], { hasFile }),
      [
        'infra/manifests/base.txt',
        'infra/manifests/role-fleet.txt',
        'operator/manifests/job-pm.txt',
        'infra/manifests/job-qa.txt',
      ],
    );
  });

  it('refuses an unknown role instead of building a bundle from base alone', () => {
    assert.throws(() => fragmentsFor('operator', [], { hasFile: () => false }), /unknown role/);
  });

  it('never gives Prime a job fragment — jobs are a fleet concept', () => {
    const frags = fragmentsFor('prime', ['devops'], { hasFile: () => true });
    assert.ok(!frags.some((f) => f.includes('job-')));
  });
});

describe('install surface — collision detection', () => {
  const readFrom = (files) => (p) => (p in files ? Buffer.from(files[p]) : null);

  it('two sources, same content, one dest is layering — not a conflict', () => {
    const files = {
      'm1.txt': 'a/one bin/tool',
      'm2.txt': 'b/two bin/tool',
      'a/one': 'same bytes',
      'b/two': 'same bytes',
    };
    const { conflicts } = resolveBundle(['m1.txt', 'm2.txt'], { readFile: readFrom(files) });
    assert.deepEqual(conflicts, []);
  });

  it('two sources, different content, one dest is a conflict naming both', () => {
    const files = {
      'm1.txt': 'a/one bin/secret-read',
      'm2.txt': 'b/two bin/secret-read',
      'a/one': 'plain name',
      'b/two': 'prefixes aps-secret-',
    };
    const { conflicts } = resolveBundle(['m1.txt', 'm2.txt'], { readFile: readFrom(files) });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].dest, 'bin/secret-read');
    assert.equal(conflicts[0].from, 'a/one');
    assert.equal(conflicts[0].to, 'b/two');
  });

  it('a missing src is reported, not silently skipped', () => {
    const files = { 'm1.txt': 'gone/file bin/tool' };
    const { missing, files: resolved } = resolveBundle(['m1.txt'], { readFile: readFrom(files) });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].src, 'gone/file');
    assert.deepEqual(resolved, {});
  });

  it('the no-clobber marker does not become part of the dest path', () => {
    const files = { 'm1.txt': 'a/one workspace/SOUL.md ?', 'a/one': 'x' };
    const { files: resolved } = resolveBundle(['m1.txt'], { readFile: readFrom(files) });
    assert.deepEqual(Object.keys(resolved), ['workspace/SOUL.md']);
  });
});

describe('install surface — the digest is over paths and content together', () => {
  it('same files at different dests are different bundles', () => {
    const a = bundleDigest({ 'bin/x': 'sha256:aa' });
    const b = bundleDigest({ 'bin/y': 'sha256:aa' });
    assert.notEqual(a, b);
  });

  it('key insertion order does not change the digest', () => {
    const a = bundleDigest({ 'bin/x': 'sha256:aa', 'bin/y': 'sha256:bb' });
    const b = bundleDigest({ 'bin/y': 'sha256:bb', 'bin/x': 'sha256:aa' });
    assert.equal(a, b);
  });
});

describe('install surface — the live repo', () => {
  const surface = installSurface(repoRoot);

  it('enumerates prime, bare fleet, and every platform job', () => {
    const jobs = platformJobs(repoRoot);
    assert.ok(jobs.length >= 12, `expected the full job set, saw ${jobs.length}`);
    for (const job of jobs) {
      assert.ok(surface.bundles[`fleet+${job}`], `no bundle resolved for job ${job}`);
    }
  });

  it('every manifest src resolves to a file in the tree', () => {
    const gaps = [];
    for (const [name, bundle] of Object.entries(surface.bundles)) {
      for (const m of bundle.missing) gaps.push(`${name}: ${m.src || m.fragment}`);
    }
    assert.deepEqual(gaps, [], `manifest points at files that are not in the repo:\n${gaps.join('\n')}`);
  });

  it('no bundle installs different content to one dest unless the override is declared', () => {
    const undeclared = [];
    for (const [name, bundle] of Object.entries(surface.bundles)) {
      for (const c of bundle.conflicts) {
        if (!DECLARED_OVERRIDES[c.dest]) {
          undeclared.push(`${name}: ${c.dest} — ${c.from} then ${c.to}`);
        }
      }
    }
    assert.deepEqual(
      undeclared,
      [],
      `these dests depend on manifest concatenation order and nothing says which should win:\n${undeclared.join('\n')}`,
    );
  });

  it('every bundle installs a non-trivial number of files', () => {
    for (const [name, bundle] of Object.entries(surface.bundles)) {
      assert.ok(bundle.fileCount > 100, `${name} resolved only ${bundle.fileCount} files`);
    }
  });

  it('matches the committed lock — a repo move must not change what a VM receives', () => {
    assert.ok(
      existsSync(lockPath),
      'infra/install-surface.lock.json is missing; regenerate with: node corekit/system/install-surface.mjs . > infra/install-surface.lock.json',
    );
    const lock = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^﻿/, ''));

    const drifted = [];
    for (const name of Object.keys({ ...lock.bundles, ...surface.bundles })) {
      const was = lock.bundles[name]?.digest;
      const now = surface.bundles[name]?.digest;
      if (was !== now) {
        drifted.push(`${name}: ${was || '(new bundle)'} -> ${now || '(bundle removed)'}`);
      }
    }

    assert.deepEqual(
      drifted,
      [],
      `the installed surface changed. If that was intended, regenerate the lock in the SAME commit:\n` +
      `  node corekit/system/install-surface.mjs . > infra/install-surface.lock.json\n${drifted.join('\n')}`,
    );
  });
});
