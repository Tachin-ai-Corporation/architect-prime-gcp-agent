// test/boundaries.test.mjs — the walls, checked rather than asserted
//
// C-30 says Foundation is unwritable from deployed cognition and C-10 forbids
// cross-module reach-ins. Both are structural claims, and a structural claim
// nobody checks decays into a comment: every one of these rules held in prose
// long before anything verified it, and the P0 audit found several that had
// quietly stopped being true.
//
// These are static checks over the repository, so they answer "can this shape
// exist" rather than "did it happen to occur in the run we sampled".
//
// Every rule comes in a pair: the repository satisfies it, AND the detector
// rejects a crafted violation. A guard that has only ever seen clean input has
// not been shown to work — the secret scanner shipped in this same program was
// dead on arrival and passed a "clean" scan over a real token, because nothing
// ever fed it something it was supposed to catch.
//
// One rule — the dashboard's route to Fleet Definition state — currently holds
// vacuously, because Fleet Studio does not exist yet. That is why it is written
// now: the UI gets built against an enforced boundary instead of having one
// retrofitted around whatever it turned out to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Every file under `dir` with one of `exts`, repo-relative. */
function walk(dir, exts, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(rel);
  }
  return out;
}

// ── Detectors (pure, so they can be shown to fire) ─────────────────────

/** Module specifiers a source file imports (static imports and re-exports). */
export function importsIn(src) {
  const out = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;'"]*from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/**
 * True when an import from `fileRel` lands outside `packageRoot`.
 *
 * Resolved against the importing file rather than pattern-matched on the
 * specifier. The first version of this counted `../` segments and so waved
 * through `../lib/firestore.mjs` from `corekit/contracts/` — precisely the
 * escape it exists to catch. Depth is not containment.
 */
export function escapesPackage(fileRel, spec, packageRoot) {
  if (spec.startsWith('node:')) return false;
  if (!spec.startsWith('.')) return true; // a bare specifier is an external dependency
  const resolved = join(fileRel, '..', spec).split(/[\\/]/).join('/');
  return !resolved.startsWith(`${packageRoot}/`);
}

/** True when a specifier reaches into catalog content. */
const reachesCatalog = (spec) => /^(?:\.\.\/)+(brain|specialties|skills)\//.test(spec);

const reachesDashboard = (spec) => /(^|\/)app\/src\//.test(spec);
const reachesRuntime = (spec) => /corekit\//.test(spec);

/** Lines that look like a direct write to a Fleet Definition collection. */
export function directDefinitionWrites(src, collections) {
  const WRITE = /\b(set|update|create|add|delete|patch|writeDoc|setDoc|updateDoc|deleteDoc)\b/i;
  const hits = [];
  for (const line of src.split('\n')) {
    for (const c of collections) if (line.includes(c) && WRITE.test(line)) hits.push({ collection: c, line: line.trim() });
  }
  return hits;
}

/** True when a manifest line installs something that can push to the platform repo. */
const installsRepoWrite = (line) => /(github-pr|git-ops|gh-auth|repo-push|git-push)/i.test(line);

/** Paths a CODEOWNERS file declares an owner for, and rules that name none. */
export function codeownersRules(text) {
  const owned = new Set();
  const ownerless = [];
  for (const [i, line] of text.split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) ownerless.push({ line: i + 1, path: parts[0] });
    else owned.add(parts[0]);
  }
  return { owned, ownerless };
}

const DEFINITION_COLLECTIONS = ['fleet_definitions', 'fleet_changes', 'fleet_releases', 'fleet_assignments'];

const FOUNDATION_PATHS = [
  '/corekit/contracts/', '/corekit/daemon/', '/corekit/brain/', '/corekit/lib/',
  '/corekit/system/', '/corekit/config/', '/infra/manifests/', '/infra/bootstrap/',
  '/infra/install.sh', '/brain/', '/app/src/app/api/', '/app/src/lib/',
  '/test/', '/tests/', '/.github/',
];

// ── Foundation is self-contained ───────────────────────────────────────

test('the contracts package depends on nothing but itself and node', () => {
  // It is the bottom of the stack: schemas, digests, the id grammar. If it can
  // import a library, the library can import it back, and "the shared
  // definition of a contract" becomes a cycle with a runtime in it.
  for (const file of walk('corekit/contracts', ['.mjs'])) {
    for (const spec of importsIn(read(file))) {
      assert.ok(!escapesPackage(file, spec, 'corekit/contracts'),
        `${file} imports '${spec}' — the contracts package must not reach outside itself`);
    }
  }
});

test('…and that check fires on a package that reaches out', () => {
  const P = 'corekit/contracts';
  const inPkg = 'corekit/contracts/index.mjs';
  const inSchemas = 'corekit/contracts/schemas/definition.mjs';

  assert.equal(escapesPackage(inPkg, '../lib/firestore.mjs', P), true, 'one level out is still out');
  assert.equal(escapesPackage(inPkg, '../../app/src/lib/entity.ts', P), true);
  assert.equal(escapesPackage(inPkg, 'some-npm-package', P), true, 'an external dependency is an escape too');

  assert.equal(escapesPackage(inPkg, 'node:crypto', P), false);
  assert.equal(escapesPackage(inPkg, './digest.mjs', P), false);
  assert.equal(escapesPackage(inPkg, './schemas/runtime.mjs', P), false);
  assert.equal(escapesPackage(inSchemas, '../ids.mjs', P), false, 'schemas/ reaching its own parent stays inside');
});

test('Foundation code never imports a concrete definition from the catalog', () => {
  // The catalog (brain/, specialties/, skills/) is seed CONTENT. Foundation
  // that imports it can no longer be reasoned about independently of a
  // particular fleet's souls — the plane confusion C-29 exists to end.
  for (const file of walk('corekit', ['.mjs'])) {
    for (const spec of importsIn(read(file))) {
      assert.ok(!reachesCatalog(spec), `${file} imports catalog content '${spec}'`);
    }
  }
});

test('…and that check fires on a catalog import', () => {
  assert.equal(reachesCatalog('../../brain/prime/cortex/SOUL.md'), true);
  assert.equal(reachesCatalog('../specialties/assistant/config.json'), true);
  assert.equal(reachesCatalog('../lib/firestore.mjs'), false);
  assert.equal(reachesCatalog('node:fs'), false);
});

test('the runtime and the dashboard do not reach into each other (C-10)', () => {
  for (const file of walk('corekit', ['.mjs'])) {
    for (const spec of importsIn(read(file))) {
      assert.ok(!reachesDashboard(spec), `${file} imports dashboard code '${spec}'`);
    }
  }
  for (const file of walk('app/src', ['.ts', '.tsx'])) {
    for (const spec of importsIn(read(file))) {
      assert.ok(!reachesRuntime(spec), `${file} imports runtime code '${spec}' — the dashboard is a client, not a host`);
    }
  }
});

test('…and those checks fire on a reach-in', () => {
  assert.equal(reachesDashboard('../../app/src/lib/entity.ts'), true);
  assert.equal(reachesRuntime('../../corekit/lib/fleet-config/registry.mjs'), true);
  assert.equal(reachesDashboard('./components/Card'), false);
  assert.equal(reachesRuntime('@/lib/entity'), false);
});

// ── Fleet Definition state has one writer ──────────────────────────────

test('the dashboard does not write Fleet Definition state directly', () => {
  // Definitions become live through the registry: sealed, validated, released,
  // assigned. A route that writes `fleet_*` bypasses every one of those steps
  // while looking like an ordinary save button.
  for (const file of walk('app/src', ['.ts', '.tsx'])) {
    const hits = directDefinitionWrites(read(file), DEFINITION_COLLECTIONS);
    assert.deepEqual(hits, [],
      `${file} appears to write Fleet Definition state directly: ${JSON.stringify(hits)}\n` +
      `  Definition changes go through the registry (fleet-config), so a change is sealed, ` +
      `validated and released rather than saved.`);
  }
});

test('…and that check fires on a direct write', () => {
  const bad = `await setDoc(doc(db, 'fleet_releases', id), { status: 'active' });`;
  const hits = directDefinitionWrites(bad, DEFINITION_COLLECTIONS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].collection, 'fleet_releases');

  const fine = `const releases = await fetch('/api/fleet-config/releases').then(r => r.json());`;
  assert.deepEqual(directDefinitionWrites(fine, DEFINITION_COLLECTIONS), [], 'reading is not writing');
});

// ── Prime holds no path to the platform repository ─────────────────────

test('no Prime manifest installs a repository write path', () => {
  // C-30: the Architect cannot push code because it holds no token, not because
  // it promised not to. prime-charter covers the specific tools removed at P4;
  // this catches the general shape, so a NEW credential-bearing tool trips it.
  for (const line of read('infra/manifests/role-prime.txt').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    assert.ok(!installsRepoWrite(t), `role-prime installs a repo write path:\n    ${t}`);
  }
});

test('…and that check fires on a reintroduced credential tool', () => {
  assert.equal(installsRepoWrite('skills/github-pr/pr-create bin/pr-create'), true);
  assert.equal(installsRepoWrite('skills/git-ops/git-commit bin/git-commit'), true);
  assert.equal(installsRepoWrite('skills/workspace-drive/drive-ls bin/drive-ls'), false);
});

// ── The gates are owned ────────────────────────────────────────────────

test('every Foundation directory is covered by CODEOWNERS', () => {
  // An unowned Foundation path can change without review, which makes
  // "Foundation changes only by reviewed platform release" decorative. This
  // list covered three paths before P0.
  const { owned } = codeownersRules(read('.github/CODEOWNERS'));
  for (const path of FOUNDATION_PATHS) {
    assert.ok(owned.has(path), `CODEOWNERS does not cover Foundation path ${path}`);
  }
});

test('CODEOWNERS names an owner for every rule it declares', () => {
  // A path with no owner after it is not a weaker rule — it is no rule, and it
  // reads exactly like one.
  const { ownerless } = codeownersRules(read('.github/CODEOWNERS'));
  assert.deepEqual(ownerless, [], `CODEOWNERS declares paths with no owner: ${JSON.stringify(ownerless)}`);
});

test('…and those checks fire on a gap', () => {
  const { owned, ownerless } = codeownersRules([
    '# comment',
    '/corekit/lib/    someone@example.com',
    '/corekit/daemon/',
  ].join('\n'));
  assert.equal(owned.has('/corekit/lib/'), true);
  assert.equal(owned.has('/corekit/daemon/'), false, 'an ownerless path must not count as covered');
  assert.deepEqual(ownerless, [{ line: 3, path: '/corekit/daemon/' }]);
});

// ── Generated artifacts are not authored ───────────────────────────────

test('the compiled contract is marked as generated', () => {
  // C-7: contracts.json is compiled from platform-defaults + fleet-policy. An
  // unmarked generated file gets hand-edited, and the edit vanishes at the next
  // compile with no trace of why the value moved back.
  const compiled = JSON.parse(read('infra/contracts.json'));
  assert.ok(compiled._generated || compiled._provenance,
    'infra/contracts.json must carry a generated/provenance marker so it is not edited as a source');
});
