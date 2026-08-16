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
import { execFileSync } from 'node:child_process';
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
                   'docs/CULTURE_OF_WORK.md', 'docs/BOOTSTRAP.md', 'docs/IMPROVEMENT_POLICY.md', 'CLAUDE.md',
                   'corekit/README.md', 'MISSION_PLAN.md', 'README.md']) add(f);

  for (const sub of ['guides', 'primitives', 'services']) {
    const dir = join(repoRoot, 'docs', sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.md')) out.push(`docs/${sub}/${f}`);
    }
  }

  // Everything that INSTALLS onto a VM as instructions: skill packages, the
  // per-specialty bundles, and the organ firmware. These outrank the canon in
  // stakes and were the one class with no coverage at all.
  //
  // A skill is read by the motor organ at the moment it needs command syntax. A
  // dead path in a canon document misleads a human, who will notice; a dead path
  // in a SKILL.md is an instruction to an agent to open a file that is not
  // there, and what it does next is anyone's guess. Prose can be wrong for a
  // month before someone reads it — a skill is wrong the first time it runs.
  out.push(...trackedMarkdown('skills', 'specialties', 'platform/organ-firmware'));

  // The repo-maintainer tooling. Not product, but it is loaded into context on
  // every session, so a stale path here sends the maintainer to a directory that
  // moved and costs a search before anyone notices the document is wrong. It had
  // sixty-odd dead paths after the platform/ move.
  //
  // `.agents/rules/project-context.md` is excluded: it is a dated changelog with
  // an explicit line in it saying references below are historical. Rewriting
  // those would falsify the record, which is the same reason docs/plans/ is out.
  out.push(...trackedMarkdown('.agents').filter((p) => p !== '.agents/rules/project-context.md'));
  return out;
}

/**
 * The part of a document that is a claim about now.
 *
 * README.md is two documents in one file: a description of the current system,
 * and a `## Version History` table that is a dated record. The table names
 * `corekit/lib/conversation-context.mjs` because that is where the file was when
 * the entry was written; rewriting it would falsify the record rather than fix
 * it — the same reason docs/plans/ is out of scope entirely.
 *
 * Split at the heading instead of excluding the file, because the half above the
 * heading is exactly the half that goes stale: it carried a pre-`platform/`
 * layout tree and a module count that had been wrong since the move.
 */
export function livingPortion(markdown) {
  return String(markdown).split(/^##\s+Version History\s*$/m)[0];
}

/** Tracked `.md` under the given trees, via git so untracked scratch is ignored. */
function trackedMarkdown(...trees) {
  const args = ['ls-files', '-z', ...trees.map((t) => `${t}/**/*.md`)];
  const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').map((s) => s.trim()).filter(Boolean);
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

/**
 * Prefixes that are real repo trees — a cited path under one should resolve.
 *
 * `brain/` stays on the list after the organ-firmware move precisely BECAUSE it
 * no longer exists: a document that still cites it is making a claim about a
 * tree that was renamed, which is the failure this check is for. Drop the prefix
 * and every stale `brain/...` reference becomes invisible instead of wrong.
 *
 * A skill often cites a file in the PROJECT's shared workspace rather than in
 * this repo ("read `content/BRIEF.md` from the shared workspace"). Those are not
 * repo claims and must not be checked, which is why this is a prefix list and
 * not "anything with a slash".
 */
const REPO_TREES = ['platform/', 'corekit/', 'infra/', 'skills/', 'specialties/',
                    'brain/', 'docs/', 'app/', 'test/', 'tests/', 'operator/'];

describe('doc paths — living documents cite files that exist', () => {
  const docs = livingDocs();

  it('finds the living document set', () => {
    assert.ok(docs.length >= 8, `only ${docs.length} living docs found — the scan is broken`);
  });

  it('covers the content that ships to VMs, not just the canon a human reads', () => {
    const has = (pred, what) => assert.ok(docs.some(pred), `no ${what} in the living set`);
    has((d) => d.startsWith('skills/'), 'skill package');
    has((d) => d.startsWith('specialties/'), 'specialty bundle doc');
    has((d) => d.startsWith('platform/organ-firmware/'), 'organ firmware file');
    has((d) => d.startsWith('docs/primitives/'), 'primitive definition');
    // Sized so that losing a whole tree fails here rather than passing quietly.
    assert.ok(docs.length >= 100, `only ${docs.length} documents in scope — a tree dropped out`);
  });

  it('splits a document at its version history and keeps only the living half', () => {
    const doc = 'Layout is `platform/work/`.\n\n## Version History\n\n| v1 | moved `corekit/lib/x.mjs` |\n';
    assert.match(livingPortion(doc), /platform\/work\//);
    assert.doesNotMatch(livingPortion(doc), /corekit\/lib/, 'the dated record must not be checked');
    // A document with no such heading is living all the way down.
    assert.equal(livingPortion('all current `platform/x`'), 'all current `platform/x`');
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
      const text = livingPortion(readFileSync(join(repoRoot, doc), 'utf8'));
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
