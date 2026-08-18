// The installer must not delete what a content release owns (C-36).
//
// Background, because the defect this covers was latent rather than visible:
// infra/install.sh sweeps skills/ and corekit/specialties/ and removes any file
// the CURRENT platform manifest does not own. Its comment justified that with
// "both scopes are exhaustively manifest-owned by construction", which was true
// until the Fleet Definition plane started writing skills/<id>/SKILL.md from a
// RELEASE. From then on the sweep deleted, on every platform upgrade, exactly the
// files Prime exists to add — while reporting them as orphans.
//
// These tests execute the REAL function out of install.sh rather than a copy of
// it. A test that reimplements the logic it is checking proves only that two
// authors agreed, and this repo has a rule about second authorities (R-11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const installSh = readFileSync(join(repo, 'infra', 'install.sh'), 'utf8');

/**
 * Lift one shell function out of install.sh by name.
 *
 * Anchored on a closing brace in column 0, which is the file's own style for
 * top-level functions. Throws rather than returning something empty: a harness
 * that silently extracts nothing would run zero assertions and pass (R-2).
 */
export function extractFunction(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`install.sh no longer defines ${name}() — this test is stale, not passing`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  const body = lines.slice(start, end + 1).join('\n');
  if (!body.includes('content_managed')) {
    throw new Error(`${name}() no longer touches content_managed — extraction is matching the wrong block`);
  }
  return body;
}

const LOAD_FN = extractFunction(installSh, 'load_content_managed');

/**
 * Run the extracted function against a temp INSTALL_ROOT and report what it
 * decided. `run` and `warn` are stubbed to the minimum the function uses.
 */
function loadOwnership(contentJson) {
  const root = mkdtempSync(join(tmpdir(), 'cpo-'));
  try {
    mkdirSync(join(root, 'corekit'), { recursive: true });
    if (contentJson !== null) writeFileSync(join(root, 'corekit', 'CONTENT.json'), contentJson, 'utf8');

    const harness = [
      'set -uo pipefail',
      'declare -A content_managed',
      'content_record_unreadable=0',
      'INSTALL_ROOT="$1"',
      'run() { "$@"; }',
      'warn() { echo "[WARN] $*" >&2; }',
      LOAD_FN,
      'load_content_managed >/dev/null 2>&1',
      // Report the decision on stdout in a form node can parse.
      'echo "UNREADABLE=${content_record_unreadable}"',
      'for k in "${!content_managed[@]}"; do echo "MANAGED=$k"; done',
    ].join('\n');

    const r = spawnSync('bash', ['-c', harness, 'harness', root], { encoding: 'utf8' });
    if (r.error) throw new Error(`bash is required to run this test: ${r.error.message}`);
    assert.equal(r.status, 0, `harness exited ${r.status}: ${r.stderr}`);

    const out = r.stdout.split(/\r?\n/);
    return {
      unreadable: out.some((l) => l === 'UNREADABLE=1'),
      managed: out.filter((l) => l.startsWith('MANAGED=')).map((l) => l.slice('MANAGED='.length)).sort(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A record in the exact shape the daemon writes (JSON.stringify(v, null, 2)). */
const record = (managed) => JSON.stringify({
  agent: 'millie',
  release: 'fr-7',
  spec_digest: 'sha256:' + 'a'.repeat(64),
  tree_digest: 'sha256:' + 'b'.repeat(64),
  applied_at: '2026-08-18T00:00:00.000Z',
  files: Object.keys(managed).length,
  managed,
}, null, 2) + '\n';

// ---- The protection itself ------------------------------------------------

test('a release-owned skill is declared protected', () => {
  const r = loadOwnership(record({
    'skills/legal-review/SKILL.md': 'sha256:' + '1'.repeat(64),
    'skills/legal-review/skill.json': 'sha256:' + '2'.repeat(64),
  }));
  assert.equal(r.unreadable, false);
  assert.deepEqual(r.managed, ['skills/legal-review/SKILL.md', 'skills/legal-review/skill.json']);
});

test('spec_digest and tree_digest are not mistaken for managed paths', () => {
  // They are sha256 values at the top level of the same record. A reader that
  // grepped for '"key":"sha256:..."' across the whole file would collect them as
  // if they were file paths — harmless for a skip-list, but it would mean the
  // block isolation is not working and a real path could be missed the same way.
  const r = loadOwnership(record({ 'skills/a/SKILL.md': 'sha256:' + '3'.repeat(64) }));
  assert.deepEqual(r.managed, ['skills/a/SKILL.md']);
  assert.ok(!r.managed.includes('spec_digest'));
  assert.ok(!r.managed.includes('tree_digest'));
  assert.ok(!r.managed.includes('applied_at'));
});

test('the cortex soul is protected at its INSTALLED path, not its bundle path', () => {
  // installPath() rewrites this one bundle path. Protecting the bundle path alone
  // would leave the actual live file unprotected — the prune loops compare
  // installed dests.
  const r = loadOwnership(record({ 'workspace-cortex/SOUL.md': 'sha256:' + '4'.repeat(64) }));
  assert.ok(r.managed.includes('workspace/SOUL.md'), 'the live path must be in the protected set');
  assert.ok(r.managed.includes('workspace-cortex/SOUL.md'), 'and the bundle path, harmlessly');
});

// ---- Failing closed, and NOT over-failing --------------------------------

test('no CONTENT.json means nothing to protect, and the sweep still runs', () => {
  // An agent with no content release has all its skills from manifests. Standing
  // the sweep down here would disable orphan removal on most of the fleet.
  const r = loadOwnership(null);
  assert.equal(r.unreadable, false, 'absent is not unreadable');
  assert.deepEqual(r.managed, []);
});

test('a torn CONTENT.json stands the sweep down rather than guessing', () => {
  const full = record({ 'skills/legal-review/SKILL.md': 'sha256:' + '1'.repeat(64) });
  const torn = full.slice(0, Math.floor(full.length / 2));
  const r = loadOwnership(torn);
  assert.equal(r.unreadable, true,
    'a record we cannot read must stop the prune — deleting files that may be '
    + 'release-owned is worse than leaving an orphan');
});

test('a pre-manifest record (count only, no managed map) stands the sweep down', () => {
  const r = loadOwnership(JSON.stringify({ agent: 'millie', files: 27 }, null, 2) + '\n');
  assert.equal(r.unreadable, true);
  assert.deepEqual(r.managed, []);
});

test('an empty managed map stands the sweep down', () => {
  // compileAgentSpec always emits at least the organ souls, so an empty map means
  // something is wrong with the record rather than that the release owns nothing.
  const r = loadOwnership(record({}));
  assert.equal(r.unreadable, true);
});

// ---- The guard must not have simply switched the sweep off ----------------

test('the orphan sweep still deletes files no plane claims', () => {
  // The negative half (R-10). A guard that protects everything is not a guard,
  // and "the sweep stopped deleting" would look identical to "the sweep works"
  // from any test that only checks protected paths survive.
  //
  // Asserted structurally against the real source: the skip is conditional on
  // membership in content_managed, and the unconditional `rm -f` is still there.
  assert.match(installSh, /if \[\[ -n "\$\{content_managed\[\$rel\]\+x\}" \]\]; then continue; fi/,
    'the sweep must skip ONLY paths the content plane declares');
  assert.match(installSh, /run rm -f "\$f" 2>\/dev\/null \|\| true/,
    'and must still remove what neither plane owns');
});

test('both prune loops are guarded, not just the orphan sweep', () => {
  // The STATE.json diff prune has the same defect from the other direction: a
  // path dropped from a manifest but now provided by a release is a handoff
  // between planes, not a decommission. Missing this loop would still delete the
  // skill, just on a different upgrade.
  assert.match(installSh, /if \[\[ -n "\$\{content_managed\[\$old_dest\]\+x\}" \]\]; then continue; fi/,
    'the manifest-diff prune must consult content-plane ownership too');
});

test('ownership is loaded before either loop reads it', () => {
  const call = installSh.indexOf('\nload_content_managed\n');
  const diffPrune = installSh.indexOf('content_managed[$old_dest]');
  const sweep = installSh.indexOf('content_managed[$rel]');
  assert.ok(call > 0, 'load_content_managed must actually be called');
  assert.ok(call < diffPrune && call < sweep,
    'a protected set that is populated after it is read protects nothing');
});
