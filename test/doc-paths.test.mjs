// test/doc-paths.test.mjs — a document that names a path it cannot produce.
//
// After the platform/ move, roughly sixty references across the docs pointed at
// files that no longer exist. Most were in docs/plans/ and the README changelog,
// which are dated records of work already done — one changelog line documents
// CREATING the lib symlink, and rewriting that would falsify history rather than
// fix anything. Those are deliberately out of scope.
//
// The rest are living documents: canon, the module charter, the guides, the
// bootstrap reference, the READMEs. They describe the system as it is now, so a
// path in one of them is a claim, and a claim that resolves to nothing is worse
// than no claim — it sends a reader to a directory that used to exist and
// silently teaches them the wrong shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Documents that describe the CURRENT system and must therefore be correct.
 *
 * docs/plans/** and the README changelog are excluded on purpose: they record
 * what was true when written, and a dated record that has been quietly updated
 * is no longer a record.
 */
function livingDocs() {
  const out = [];
  const add = (rel) => { if (existsSync(join(repoRoot, rel))) out.push(rel); };

  for (const f of ['docs/PRODUCT_CANON.md', 'docs/BRAIN_CANON.md', 'docs/MODULE_CHARTER.md',
                   'docs/CULTURE_OF_WORK.md', 'docs/BOOTSTRAP.md', 'CLAUDE.md',
                   'corekit/README.md']) add(f);

  const guides = join(repoRoot, 'docs', 'guides');
  if (existsSync(guides)) {
    for (const f of readdirSync(guides)) {
      if (f.endsWith('.md')) out.push(`docs/guides/${f}`);
    }
  }
  return out;
}

/**
 * Repo-path-looking tokens in a document: `backticked/paths/like.this`.
 *
 * Only backticked spans are considered. Prose mentions a directory in passing
 * all the time ("the work package"), and treating those as claims would make
 * the check unusable, which is how a check gets deleted.
 */
export function citedPaths(markdown) {
  const out = [];
  for (const m of String(markdown).matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim().replace(/[.,;:]$/, '');
    if (!raw.includes('/')) continue;
    if (/[\s*{}()<>|$]/.test(raw)) continue;         // globs, shell, templates
    if (/^(https?:|\/\/)/.test(raw)) continue;        // URLs
    if (raw.startsWith('/')) continue;                // VM absolute paths
    if (!/^[A-Za-z0-9_.@-]+\//.test(raw)) continue;   // must look repo-rooted
    out.push(raw);
  }
  return out;
}

/** Prefixes that are real repo trees — a cited path under one should resolve. */
const REPO_TREES = ['platform/', 'corekit/', 'infra/', 'skills/', 'specialties/',
                    'brain/', 'docs/', 'app/', 'test/', 'tests/', 'operator/'];

describe('doc paths — living documents cite files that exist', () => {
  const docs = livingDocs();

  it('finds the living document set', () => {
    assert.ok(docs.length >= 8, `only ${docs.length} living docs found — the scan is broken`);
  });

  it('extracts backticked repo paths and ignores prose, globs and URLs', () => {
    const found = citedPaths([
      'see `platform/work/verdict.mjs` for detail',
      'the `work` package (not a path)',
      'run `find corekit -name "*.mjs"` first',
      'at `https://example.com/x/y`',
      'installed to `/opt/corekit/bin`',
      'matching `infra/manifests/*.txt`',
    ].join('\n'));
    assert.deepEqual(found, ['platform/work/verdict.mjs']);
  });

  it('no living document cites a path that does not exist', () => {
    const dead = [];
    for (const doc of docs) {
      const text = readFileSync(join(repoRoot, doc), 'utf8');
      for (const p of citedPaths(text)) {
        if (!REPO_TREES.some((t) => p.startsWith(t))) continue;
        const full = join(repoRoot, p);
        if (existsSync(full)) continue;
        // A trailing-slash directory reference is satisfied by the directory.
        const asDir = p.replace(/\/$/, '');
        if (existsSync(join(repoRoot, asDir)) && statSync(join(repoRoot, asDir)).isDirectory()) continue;
        dead.push(`${doc}  ->  ${p}`);
      }
    }
    assert.deepEqual(
      dead, [],
      'these documents describe the system as it is now and name files that are not there:\n' +
      dead.join('\n'),
    );
  });

  it('the canon does not describe the runtime as one flat library directory', () => {
    // B-18 said "everything reusable lives in corekit/lib/". That was true, then
    // silently was not. The wording is checked because the sentence is the claim.
    const canon = readFileSync(join(repoRoot, 'docs', 'BRAIN_CANON.md'), 'utf8');
    assert.ok(!/corekit\/lib\//.test(canon), 'BRAIN_CANON still points at corekit/lib/');
    assert.match(canon, /platform\//, 'B-18 should name the package layout it now describes');
  });
});
