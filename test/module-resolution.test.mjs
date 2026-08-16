// test/module-resolution.test.mjs — the installed tree has to link, not just parse.
//
// CI checks that every .mjs parses. Parsing does not resolve imports, so a
// specifier pointing at nothing passes the syntax gate and fails when a VM
// restarts the daemon. This resolves the graph the way node will, against the
// tree the manifests actually lay down.
//
// The repo tree is checked separately, and as of the platform/ move it is also
// clean. Five daemons used to be unloadable from a checkout: they lived at
// `corekit/daemon/` and installed to `bin/`, so their imports resolved on a VM
// and nowhere else, and no test could import one. Every module now installs at
// the path it occupies in the repo, so both trees answer the same. The ratchet
// stays because that property is easy to lose and expensive to notice.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  relativeSpecifiers,
  normalize,
  followLinks,
  resolveFrom,
  bundleTree,
  brokenImports,
  brokenInRepo,
} from '../corekit/system/resolve-imports.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Modules that cannot be loaded from a checkout, only from an installed tree.
 *
 * Empty, and meant to stay that way. It held the five daemons until repo path
 * and VM path were made to agree; keeping the list rather than deleting the
 * check is the difference between "this is true now" and "this stays true".
 */
const UNLOADABLE_FROM_REPO = Object.freeze([]);

describe('module resolution — specifier extraction', () => {
  it('finds static, named, and namespace imports', () => {
    const specs = relativeSpecifiers([
      "import a from './a.mjs';",
      "import { b } from '../b/b.mjs';",
      "import * as c from './c.mjs';",
    ].join('\n')).map((s) => s.spec);
    assert.deepEqual(specs, ['./a.mjs', '../b/b.mjs', './c.mjs']);
  });

  it('finds re-exports — a broken export chain breaks the same way', () => {
    const specs = relativeSpecifiers("export { x } from './x.mjs';").map((s) => s.spec);
    assert.deepEqual(specs, ['./x.mjs']);
  });

  it('finds dynamic import()', () => {
    const specs = relativeSpecifiers("const m = await import('./lazy.mjs');").map((s) => s.spec);
    assert.deepEqual(specs, ['./lazy.mjs']);
  });

  it('ignores bare specifiers — node resolves those from node_modules', () => {
    assert.deepEqual(relativeSpecifiers("import { createHash } from 'node:crypto';"), []);
    assert.deepEqual(relativeSpecifiers("import x from 'google-auth-library';"), []);
  });

  it('reports the line so the fix has an address', () => {
    const [hit] = relativeSpecifiers("// header\n\nimport a from './a.mjs';");
    assert.equal(hit.line, 3);
  });
});

describe('module resolution — path arithmetic', () => {
  it('collapses parent segments', () => {
    assert.equal(normalize('bin/../platform/work/x.mjs'), 'platform/work/x.mjs');
    assert.equal(normalize('a/./b//c'), 'a/b/c');
  });

  it('resolves through a symlink when one is declared', () => {
    // LAYOUT_LINKS is empty now that every module installs at its repo path.
    // The mechanism is still exercised, because an empty table should be a fact
    // about this tree rather than an untested branch.
    assert.equal(followLinks('lib/verdict.mjs', { lib: 'platform/work' }), 'platform/work/verdict.mjs');
  });

  it('does not treat a prefix match as a path segment', () => {
    assert.equal(followLinks('library/x.mjs', { lib: 'platform/work' }), 'library/x.mjs');
  });

  it('leaves every path alone when no link is declared', () => {
    assert.equal(followLinks('lib/verdict.mjs'), 'lib/verdict.mjs');
  });

  it('resolves a sibling and a directory index', () => {
    const dests = new Set(['bin/a.mjs', 'platform/work/b.mjs', 'platform/contracts/index.mjs']);
    assert.equal(resolveFrom('bin/a.mjs', '../platform/work/b.mjs', dests), 'platform/work/b.mjs');
    assert.equal(resolveFrom('bin/a.mjs', '../platform/contracts', dests), 'platform/contracts/index.mjs');
  });

  it('returns null for a specifier that lands on nothing', () => {
    assert.equal(resolveFrom('bin/a.mjs', '../nope/gone.mjs', new Set(['bin/a.mjs'])), null);
  });
});

describe('module resolution — the installed tree', () => {
  for (const role of ['prime', 'fleet']) {
    it(`every import in the ${role} bundle resolves on a VM`, () => {
      const tree = bundleTree(repoRoot, role);
      assert.ok(tree.size > 100, `${role} tree resolved only ${tree.size} files`);
      const broken = brokenImports(repoRoot, tree);
      assert.deepEqual(
        broken.map((b) => `${b.src}:${b.line} -> ${b.spec} (installed at ${b.dest})`),
        [],
        'these imports parse but will not load when the daemon starts',
      );
    });
  }
});

describe('module resolution — the repo tree', () => {
  const tree = new Map([...bundleTree(repoRoot, 'prime'), ...bundleTree(repoRoot, 'fleet')]);
  const srcs = [...new Set(tree.values())].filter((s) => s.endsWith('.mjs')).sort();
  const broken = brokenInRepo(repoRoot, srcs);
  const files = [...new Set(broken.map((b) => b.src))].sort();

  it('no module becomes newly unloadable from a checkout', () => {
    const added = files.filter((f) => !UNLOADABLE_FROM_REPO.includes(f));
    assert.deepEqual(
      added,
      [],
      'these modules resolve on a VM but not in the repo. A test cannot import them, ' +
      'so nothing checks them until a daemon restarts:\n' + added.join('\n'),
    );
  });

  it('the debt list has no entries that are already fixed', () => {
    const stale = UNLOADABLE_FROM_REPO.filter((f) => !files.includes(f));
    assert.deepEqual(stale, [], 'these load fine now — drop them from UNLOADABLE_FROM_REPO');
  });
});
