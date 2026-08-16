// test/line-endings.test.mjs — what a VM executes is the stored blob.
//
// install.sh curls each manifested file from GitHub raw, so the bytes an agent
// runs are the bytes git stores, not whatever a working copy holds. A shell
// script stored with CRLF has a shebang ending in \r, and Linux answers with
// "bad interpreter: No such file or directory" — naming an interpreter that
// plainly exists.
//
// .gitattributes is supposed to prevent that, but a .gitattributes rule is a
// claim about files it may not actually match. Its rules were depth-shaped
// (`corekit/*/*`, exactly two levels), and the platform/ move put the daemon
// launchers at platform/runtime/ where nothing matched them. The blobs survived
// only because `git mv` carries a blob unchanged; the next Windows edit would
// have stored CRLF and broken every agent's start script.
//
// So this asks git what is actually in the index, for exactly the files the
// manifests ship, rather than trusting the rule that is meant to govern them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseManifest, fragmentsFor, platformJobs } from '../corekit/system/install-surface.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hasFile = (rel) => existsSync(join(repoRoot, rel));

/** Every repo path any bundle installs, across roles and jobs. */
function shippedPaths() {
  const out = new Set();
  const bundles = [['prime', []], ['fleet', []], ...platformJobs(repoRoot).map((j) => ['fleet', [j]])];
  for (const [role, jobs] of bundles) {
    for (const frag of fragmentsFor(role, jobs, { hasFile })) {
      const full = join(repoRoot, frag);
      if (!existsSync(full)) continue;
      out.add(frag);
      for (const { src } of parseManifest(readFileSync(full, 'utf8'))) out.add(src);
    }
  }
  return [...out].sort();
}

/** `git ls-files --eol` for the given paths → path -> index eol marker. */
function indexEol(paths) {
  const map = new Map();
  const CHUNK = 200; // argv limits on Windows are real
  for (let i = 0; i < paths.length; i += CHUNK) {
    let out;
    try {
      out = execFileSync('git', ['ls-files', '--eol', '--', ...paths.slice(i, i + CHUNK)],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1e8 });
    } catch { continue; }
    for (const line of out.split('\n')) {
      const m = line.match(/^i\/(\S+)\s+w\/\S+\s+attr\/(\S*)\s+\t(.+)$/);
      if (m) map.set(m[3].trim(), { index: m[1], attr: m[2] });
    }
  }
  return map;
}

describe('line endings — the bytes a VM receives', () => {
  const paths = shippedPaths();

  it('the manifests resolve to a substantial file set', () => {
    assert.ok(paths.length > 200, `only ${paths.length} shipped paths found — the scan is broken`);
  });

  it('no shipped file is stored with CRLF', () => {
    const eol = indexEol(paths);
    const crlf = [...eol].filter(([, v]) => v.index === 'crlf').map(([p]) => p);
    assert.deepEqual(
      crlf, [],
      'these ship to a Linux VM with CRLF in the stored blob. A shell script among ' +
      'them fails with "bad interpreter"; a JSON config may parse and may not:\n' + crlf.join('\n'),
    );
  });

  it('every shipped text file is governed by an eol attribute, not left to chance', () => {
    const eol = indexEol(paths);
    const ungoverned = [];
    for (const [path, v] of eol) {
      if (v.index === 'none') continue;                       // binary or empty — no lines to end
      if (/\.(png|ico|jpg|gif|woff2?)$/.test(path)) continue;
      if (!/eol=lf/.test(v.attr)) ungoverned.push(`${path}  (attr: ${v.attr || 'none'})`);
    }
    assert.deepEqual(
      ungoverned, [],
      'these are LF today by luck rather than by rule — `git mv` preserves a blob, so a ' +
      'file can leave its .gitattributes match and look fine until the next edit:\n' +
      ungoverned.join('\n'),
    );
  });

  it('every executable that ships to bin/ starts with a clean shebang', () => {
    const bad = [];
    for (const [role, jobs] of [['prime', []], ['fleet', []]]) {
      for (const frag of fragmentsFor(role, jobs, { hasFile })) {
        const full = join(repoRoot, frag);
        if (!existsSync(full)) continue;
        for (const { src, dest } of parseManifest(readFileSync(full, 'utf8'))) {
          if (!dest.startsWith('bin/')) continue;
          const p = join(repoRoot, src);
          if (!existsSync(p)) continue;
          const head = readFileSync(p).subarray(0, 200).toString('utf8');
          if (!head.startsWith('#!')) continue;               // not a script entry point
          const firstLine = head.split('\n')[0];
          if (firstLine.endsWith('\r')) bad.push(`${src} — shebang ends with CR`);
        }
      }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
});
