// test/tool-hygiene.test.mjs — properties every shipped shell tool must hold.
//
// Found by running a real mission and then trying to check its work: an operator
// invocation of `sheets-get` exited 23 and printed NOTHING. The cause was
// `curl -s -o /tmp/sheets-response.json`. A previous run as root owned that file,
// curl could not write it (exit 23 = CURLE_WRITE_ERROR), and `set -euo pipefail`
// killed the script before die() could say a word.
//
// The damage is not the inspection annoyance. It is that a fixed temp filename
// makes a tool break PERMANENTLY for every user but the first, with no message,
// and makes two concurrent runs read each other's response. The docs/, github-pr/
// and secrets/ tools already used `mktemp -d`; calendar, drive, gmail, sheets and
// slides had been left behind — a half-finished migration that nothing checked,
// so it stayed half-finished.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every tracked bash tool, by shebang rather than by suffix.
 *
 * This walked `skills specialties corekit` — an allow-list, and therefore R-1 for
 * the seventh time in this repo. scripts/, infra/ and platform/ sat outside it,
 * and scripts/rollout-gate.sh promptly grew the exact defect this file exists to
 * catch: `sudo cmd >/tmp/vc.log` fails with EACCES for the second user to run it,
 * because the SHELL opens the redirect target, not sudo. It cost a false FAIL in
 * the middle of a fleet roll, on a check whose own subject printed a clean pass.
 *
 * A test whose scope excludes the place a defect appears does not report reduced
 * coverage; it reports success.
 */
function bashTools() {
  const listed = execFileSync('git', ['ls-files'],
    { cwd: repoRoot, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const rel of listed) {
    let src;
    try { src = readFileSync(join(repoRoot, rel), 'utf8'); } catch { continue; }
    if (/^#!.*\bbash\b/.test(src)) out.push([rel, src]);
  }
  return out;
}

/**
 * Drop heredoc bodies.
 *
 * `fleet-deploy` emits a VM startup script inside a heredoc. That script runs
 * once, as root, on a machine that has just been created and has no other users
 * — none of the hazards here apply to it, and the text is not this tool's temp
 * usage at all, it is a different program that happens to be quoted inside one.
 * Excluded structurally rather than by filename: a name on an exemption list is
 * a rule someone has to remember, and the next generated script would not be
 * on it.
 */
export function withoutHeredocs(source) {
  const lines = String(source).split('\n');
  const out = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    const m = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/);
    if (m) { terminator = m[1]; out.push(line); continue; }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A literal path under /tmp with a fixed filename.
 *
 * `${__DT}/x.json` and `$(mktemp)` are per-run and therefore fine; this matches
 * only the constant form, which is the one that collides.
 */
/** Shell comment lines, which are prose and cannot open a file. */
function withoutComments(source) {
  return String(source)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * A fix that EXPLAINS the fixed path it replaced would otherwise trip this — the
 * check fired on scripts/rollout-gate.sh after that file was already corrected,
 * because the comment names the old /tmp/vc.log. A check a comment can fool is
 * weak; one a comment can FALSELY fail is worse, because the cheapest way to
 * silence it is to delete the explanation.
 */
export function fixedTempPaths(source) {
  const code = withoutHeredocs(withoutComments(source));
  return [...code.matchAll(/(?<![}$\w])\/tmp\/([a-z][a-z0-9._-]*\.[a-z]+)/g)].map((m) => m[0]);
}

describe('shipped shell tools — temp files are per-run', () => {
  const tools = bashTools();

  it('finds the tool set', () => {
    // A scan that matched nothing would pass every assertion below. The count is
    // the guard: this repo ships well over a hundred bash tools.
    assert.ok(tools.length >= 100, `only ${tools.length} bash tools found — the scan is broken`);
  });

  it('recognises a fixed temp path and ignores a per-run one', () => {
    assert.deepEqual(fixedTempPaths('curl -o /tmp/sheets-response.json'), ['/tmp/sheets-response.json']);
    assert.deepEqual(fixedTempPaths('curl -o "${__DT}/sheets-response.json"'), []);
    assert.deepEqual(fixedTempPaths('f=$(mktemp); echo x > "$f"'), []);
  });

  it('a generated script quoted inside a heredoc is not this tool\'s temp usage', () => {
    const src = [
      'curl -o /tmp/mine.json x',
      "cat > startup <<'STARTUP_EOF'",
      'curl -o /tmp/theirs.sh y',
      'STARTUP_EOF',
      'echo done',
    ].join('\n');
    assert.deepEqual(fixedTempPaths(src), ['/tmp/mine.json'], 'only the outer script counts');
  });

  it('no tool writes to a fixed /tmp filename', () => {
    const offenders = [];
    for (const [rel, src] of tools) {
      const hits = fixedTempPaths(src);
      if (hits.length) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
    }
    assert.deepEqual(
      offenders, [],
      'a fixed temp filename is owned by whoever runs the tool first; every later run by\n'
      + 'another user fails curl with exit 23 and set -e swallows the message. Use:\n'
      + '  __DT="$(mktemp -d)"; trap \'rm -rf "$__DT"\' EXIT\n'
      + offenders.join('\n'),
    );
  });

  it('every tool that makes a scratch dir also removes it', () => {
    const leaking = [];
    for (const [rel, src] of tools) {
      if (!/mktemp -d/.test(src)) continue;
      if (!/trap\s+.*rm -rf/.test(src)) leaking.push(rel);
    }
    assert.deepEqual(leaking, [], `these create a temp dir and never clean it up:\n${leaking.join('\n')}`);
  });
});
