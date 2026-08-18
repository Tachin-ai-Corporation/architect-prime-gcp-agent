// test/retired-content.test.mjs — a release that drops a skill must remove it.
//
// Audit P0-5, verified before fixing. The pure planner was always right:
//
//   const remove = Object.keys(current).filter((p) => !(p in desired));
//
// It was fed an inventory that made removal impossible. The daemon called
// `currentDigests(Object.keys(files))` — the DESIRED paths — so `current` could
// never contain a key `desired` lacked and `remove` was structurally empty. A
// skill dropped from a release stayed installed, stayed in the runtime index, and
// the sync reported success. Prime could add a capability and never subtract one.
//
// `bundleMatches` had the mirror of the same hole: it iterated only `expected`, so
// an extra managed file on disk still answered "already converged".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planApply, bundleMatches } from '../platform/deployment/content-sync.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const d = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

describe('planApply removes what the bundle dropped', () => {
  it('retires a path present before and absent now', () => {
    const current = { 'skills/a/SKILL.md': d('a'), 'skills/gone/SKILL.md': d('g') };
    const desired = { 'skills/a/SKILL.md': 'a' };
    const plan = planApply(current, desired);
    assert.deepEqual(plan.remove, ['skills/gone/SKILL.md']);
    assert.deepEqual(plan.unchanged, ['skills/a/SKILL.md']);
    assert.deepEqual(plan.write, []);
  });

  it('removes nothing when the inventory only ever held desired paths', () => {
    // The shape of the bug, preserved as documentation: feed it only desired
    // keys and it is correct AND useless.
    const desired = { 'skills/a/SKILL.md': 'a' };
    const narrowed = { 'skills/a/SKILL.md': d('a') };
    assert.deepEqual(planApply(narrowed, desired).remove, [],
      'with a desired-only inventory the planner cannot see a retired file');
  });
});

describe('bundleMatches counts an extra managed file as drift', () => {
  const spec = { bundle: { files: { 'skills/a/SKILL.md': d('a') } } };

  it('converged when disk matches exactly', () => {
    assert.equal(bundleMatches({ 'skills/a/SKILL.md': d('a') }, spec), true);
  });

  it('NOT converged when a retired file is still installed', () => {
    assert.equal(
      bundleMatches({ 'skills/a/SKILL.md': d('a'), 'skills/gone/SKILL.md': d('g') }, spec),
      false,
      'an extra managed file used to report converged, so the retired skill stayed'
    );
  });

  it('NOT converged when a wanted file is missing or wrong', () => {
    assert.equal(bundleMatches({}, spec), false);
    assert.equal(bundleMatches({ 'skills/a/SKILL.md': d('different') }, spec), false);
  });
});

describe('the daemon feeds it a union, and records what it managed', () => {
  const src = readFileSync(join(repoRoot, 'platform/runtime/agent-content-sync.mjs'), 'utf8');

  it('no longer inventories only the desired paths', () => {
    assert.doesNotMatch(src, /currentDigests\(Object\.keys\(files\)\)/,
      'a desired-only inventory makes removal structurally impossible');
  });

  it('inventories desired UNION previously-managed', () => {
    assert.match(src, /currentDigests\(new Set\(\[\.\.\.Object\.keys\(files\), \.\.\.\(prior \|\| \[\]\)\]\)\)/);
  });

  it('persists the managed path set, not just a count', () => {
    assert.match(src, /managed: spec\.bundle\.files/,
      'CONTENT.json stored only a file count, so the previous path set was unrecoverable');
  });

  it('distinguishes "unknowable" from "empty" and says so', () => {
    // Returning [] for a pre-manifest record would silently reproduce the bug
    // while looking like a clean answer.
    assert.match(src, /return null;/, 'previouslyManaged must return null, not []');
    assert.match(src, /pre-manifest record/, 'the degraded first pass must be logged, not silent');
  });
});
