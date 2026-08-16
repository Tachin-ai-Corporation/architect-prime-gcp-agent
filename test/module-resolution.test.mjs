// test/module-resolution.test.mjs — the installed tree has to link, not just parse.
//
// CI checks that every .mjs parses. Parsing does not resolve imports, so a
// specifier pointing at nothing passes the syntax gate and fails when a VM
// restarts the daemon. This resolves the graph the way node will, against the
// tree the manifests actually lay down.
//
// The repo tree is checked separately and held on a ratchet. Five daemons are
// unloadable from a checkout today because they live at `corekit/daemon/` and
// install to `bin/`, so `../corekit/lib/…` resolves on a VM and nowhere else.
// That is why no test can import a daemon. The list may shrink; it may not grow.

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
 * Each is a daemon whose imports are written for its `bin/` dest. Making repo
 * path and VM path agree would empty this list and make the daemons testable
 * for the first time. Until then it is debt, counted rather than forgotten.
 */
const UNLOADABLE_FROM_REPO = Object.freeze([
  'corekit/daemon/agent-brain.mjs',
  'corekit/daemon/agent-content-sync.mjs',
  'corekit/daemon/agent-ears.mjs',
  'corekit/daemon/agent-introspect.mjs',
  'corekit/daemon/agent-mouth.mjs',
]);

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
    assert.equal(normalize('bin/../corekit/lib/x.mjs'), 'corekit/lib/x.mjs');
    assert.equal(normalize('a/./b//c'), 'a/b/c');
  });

  it('follows the lib bridge symlink install.sh creates', () => {
    assert.equal(followLinks('lib/verdict.mjs'), 'corekit/lib/verdict.mjs');
  });

  it('does not treat a prefix match as a path segment', () => {
    assert.equal(followLinks('library/x.mjs'), 'library/x.mjs');
  });

  it('resolves a sibling and a directory index', () => {
    const dests = new Set(['bin/a.mjs', 'corekit/lib/b.mjs', 'corekit/contracts/index.mjs']);
    assert.equal(resolveFrom('bin/a.mjs', '../corekit/lib/b.mjs', dests), 'corekit/lib/b.mjs');
    assert.equal(resolveFrom('bin/a.mjs', '../corekit/contracts', dests), 'corekit/contracts/index.mjs');
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
