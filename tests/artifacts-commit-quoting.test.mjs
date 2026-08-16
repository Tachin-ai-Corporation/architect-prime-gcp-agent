// tests/artifacts-commit-quoting.test.mjs — regression for the commit-message shell-injection
// bug in artifacts.mjs commitAndSync (observed live on stan, 2026-08-11):
//
//   commitAndSync failed: Command failed: git commit -m "…mission branch of the `acme-we"
//   /bin/sh: 1: Syntax error: EOF in backquote substitution
//
// The daemon derives the mission-record commit message from the mission goal, so it legitimately
// carries backticks (e.g. "the `acme-www` repo"), $, ", and newlines. The old code built a
// shell command string — execSync(`git commit -m ${JSON.stringify(message)}`) — and /bin/sh then
// re-interpreted the backticks (unterminated → throw; balanced → the backticked span is run as a
// command and silently dropped). The fix commits shell-free via execFileSync('git', ['commit','-m',
// message]) so the argv is passed literally and never re-scanned. These tests prove the mechanism:
// the argv form is verbatim; the old shell form is NOT (throws or corrupts) — for both the real
// balanced-backtick message and the truncated unbalanced one from the incident.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ap-commitq-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@agent'], { cwd: dir });
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// Stage a fresh change and return what the given committer actually recorded as the commit body,
// or {threw:true} if the committer failed. Each call makes a new commit.
let n = 0;
function commitWith(committer, message) {
  writeFileSync(join(dir, `f${++n}.txt`), String(n));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  try {
    committer(message);
  } catch {
    return { threw: true };
  }
  const body = execSync('git log -1 --format=%B', { cwd: dir, encoding: 'utf8' })
    .replace(/\r\n/g, '\n').replace(/\n+$/, ''); // CRLF-tolerant (Windows git) + strip trailing newlines
  return { body };
}

// The old shell-string form is only *unsafe* under a POSIX shell (/bin/sh does backquote
// substitution). On Windows execSync uses cmd.exe, which treats ` and $ literally, so that
// characterization does not apply there — the verbatim-argv guarantees below still do.
const POSIX = process.platform !== 'win32';

// The FIXED path — exactly what artifacts.mjs commitAndSync now does.
const fixedCommit = (message) => execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, timeout: 10000 });
// The OLD, buggy path — a shell command string with the message interpolated.
const buggyCommit = (message) => execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: dir, timeout: 10000 });

describe('commitAndSync message quoting (execFileSync, shell-free)', () => {
  const REAL = 'v2026.08.11.8.1: Delegation: Deploy the latest changes from the mission branch of the `acme-www` repo';
  const TRUNCATED = 'v2026.08.11.8.1: Delegation: Deploy the mission branch of the `acme-we'; // unbalanced ` — the incident
  const RICH = 'v1: ship `code` for $HOME, say "hi"\n\nsecond paragraph with 100% coverage';

  it('commits a balanced-backtick message VERBATIM (was silently corrupted)', () => {
    const r = commitWith(fixedCommit, REAL);
    assert.equal(r.body, REAL);
  });

  it('commits the truncated unbalanced-backtick message VERBATIM (was the throw)', () => {
    const r = commitWith(fixedCommit, TRUNCATED);
    assert.equal(r.body, TRUNCATED);
  });

  it('commits $, quotes, and a blank-line body VERBATIM', () => {
    const r = commitWith(fixedCommit, RICH);
    assert.equal(r.body, RICH);
  });

  it('the old shell-string form does NOT preserve these messages (throws or corrupts)', { skip: POSIX ? false : 'POSIX /bin/sh only — cmd.exe does not do backquote substitution' }, () => {
    // Unbalanced backtick → /bin/sh reports "EOF in backquote substitution" → throw.
    const t = commitWith(buggyCommit, TRUNCATED);
    assert.ok(t.threw, 'old form should have thrown on the unbalanced backtick');
    // Balanced backtick → sh runs `acme-www` as a command and drops the span → corrupted body.
    const b = commitWith(buggyCommit, REAL);
    assert.ok(b.threw || b.body !== REAL, 'old form should throw or corrupt the balanced-backtick message');
  });
});
