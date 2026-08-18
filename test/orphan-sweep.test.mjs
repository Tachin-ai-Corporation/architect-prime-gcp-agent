// The orphan sweep, executed end to end against a real tree.
//
// test/content-plane-ownership.test.mjs proves the OWNERSHIP READER works. That
// is not the same as proving the sweep respects it: a guard can be read
// correctly and then consulted in a branch that never fires, and "the sweep
// deleted nothing" looks identical to "the sweep is fixed" from the outside.
// The live upgrade on the canary showed exactly that ambiguity — 27 paths
// protected, 0 files removed — because no release-only skill exists on the fleet
// yet to be protected.
//
// So build the tree the fleet does not have yet: one manifest-owned file, one
// RELEASE-owned file that appears in no manifest, and one genuine orphan owned by
// nobody. Then run the sweep block lifted out of install.sh and check all three
// outcomes. The third is the one that matters most — a guard that protects
// everything has not fixed the sweep, it has switched it off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const installSh = readFileSync(join(repo, 'infra', 'install.sh'), 'utf8');

/**
 * Lift a top-level `if ... fi` block out of install.sh by its opening line.
 *
 * Anchored on `fi` in column 0, which is the file's style for top-level blocks.
 * Throws rather than returning nothing: a harness that extracts an empty block
 * runs no assertions and passes (R-2).
 */
function extractBlock(source, openingLine) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l === openingLine);
  if (start < 0) throw new Error(`install.sh no longer opens a block with:\n  ${openingLine}\nThis test is stale, not passing.`);
  const end = lines.findIndex((l, i) => i > start && l === 'fi');
  if (end < 0) throw new Error('could not find the closing fi');
  const block = lines.slice(start, end + 1).join('\n');
  for (const needle of ['content_managed[$rel]', 'run rm -f "$f"']) {
    if (!block.includes(needle)) throw new Error(`extracted block is missing ${needle} — wrong block`);
  }
  return block;
}

const SWEEP = extractBlock(
  installSh,
  'if [[ ${#file_hashes[@]} -gt 0 && $content_record_unreadable -eq 0 ]]; then',
);
const LOAD_FN = (() => {
  const lines = installSh.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('load_content_managed() {'));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return lines.slice(start, end + 1).join('\n');
})();

const MANIFEST_SKILL = 'skills/workspace-git/SKILL.md';
const RELEASE_SKILL = 'skills/legal-review/SKILL.md';
const NOBODYS_FILE = 'skills/abandoned/SKILL.md';

/**
 * Run the real sweep over a tree holding all three ownership cases.
 * @param {{ withRecord: boolean, tornRecord?: boolean }} opts
 */
function runSweep(opts) {
  const root = mkdtempSync(join(tmpdir(), 'sweep-'));
  try {
    for (const rel of [MANIFEST_SKILL, RELEASE_SKILL, NOBODYS_FILE]) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), `# ${rel}\n`, 'utf8');
    }
    mkdirSync(join(root, 'corekit'), { recursive: true });

    if (opts.withRecord) {
      const record = JSON.stringify({
        agent: 'millie',
        release: 'fr-7',
        spec_digest: 'sha256:' + 'a'.repeat(64),
        tree_digest: 'sha256:' + 'b'.repeat(64),
        files: 1,
        managed: { [RELEASE_SKILL]: 'sha256:' + '1'.repeat(64) },
      }, null, 2) + '\n';
      writeFileSync(
        join(root, 'corekit', 'CONTENT.json'),
        opts.tornRecord ? record.slice(0, Math.floor(record.length / 2)) : record,
        'utf8',
      );
    }

    const harness = [
      'set -uo pipefail',
      'INSTALL_ROOT="$1"',
      'run() { "$@"; }',
      'info() { :; }',
      'warn() { :; }',
      'declare -A file_hashes',
      'declare -A noclobber_dests',
      'declare -A content_managed',
      'content_record_unreadable=0',
      // Only the manifest skill is owned by the platform manifest.
      `file_hashes["${MANIFEST_SKILL}"]=1`,
      LOAD_FN,
      'load_content_managed >/dev/null 2>&1',
      SWEEP,
    ].join('\n');

    const r = spawnSync('bash', ['-c', harness, 'harness', root], { encoding: 'utf8' });
    if (r.error) throw new Error(`bash is required to run this test: ${r.error.message}`);
    assert.equal(r.status, 0, `harness exited ${r.status}: ${r.stderr}`);

    return {
      manifestKept: existsSync(join(root, MANIFEST_SKILL)),
      releaseKept: existsSync(join(root, RELEASE_SKILL)),
      orphanKept: existsSync(join(root, NOBODYS_FILE)),
      stdout: r.stdout,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a release-owned skill survives the sweep, and a true orphan does not', () => {
  const r = runSweep({ withRecord: true });

  assert.equal(r.manifestKept, true, 'a manifest-owned file must survive');
  assert.equal(r.releaseKept, true,
    'a skill owned by a RELEASE and named in no manifest must survive — this is the '
    + 'defect: Prime could add a skill and the next platform upgrade deleted it');
  assert.equal(r.orphanKept, false,
    'a file no plane claims must still be removed — otherwise the guard has not '
    + 'fixed the sweep, it has switched it off (R-10)');
  assert.match(r.stdout, /\[orphan\] skills\/abandoned\/SKILL\.md/,
    'and the removal must still be reported');
});

test('without the fix in place the release-owned skill would be deleted', () => {
  // The counterfactual, run for real: no CONTENT.json means no declared
  // ownership, which is exactly the state every agent was in before this record
  // existed. The release skill is then indistinguishable from an orphan.
  //
  // This is what makes the previous test a proof rather than a demonstration —
  // it shows the survival is caused by the record and not by something else in
  // the tree.
  const r = runSweep({ withRecord: false });
  assert.equal(r.manifestKept, true);
  assert.equal(r.releaseKept, false,
    'with no ownership record the sweep deletes it — the pre-fix behaviour');
  assert.equal(r.orphanKept, false);
});

test('a torn record stands the whole sweep down, deleting nothing', () => {
  // Fail closed. Ownership cannot be established, so every file under the scanned
  // directories is of unknown provenance and none of it is ours to delete —
  // including the genuine orphan. Leaving an orphan is recoverable; deleting a
  // release-owned skill on every upgrade is not.
  const r = runSweep({ withRecord: true, tornRecord: true });
  assert.equal(r.manifestKept, true);
  assert.equal(r.releaseKept, true);
  assert.equal(r.orphanKept, true, 'the sweep must not run at all when ownership is unknown');
});
