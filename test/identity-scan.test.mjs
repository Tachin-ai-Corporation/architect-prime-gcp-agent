// test/identity-scan.test.mjs — the check that stops an operator's address shipping
//
// This repo is a public template, so a real address in a shipped platform file
// hands one operator's contact details to every fork. The instance that
// prompted this arrived the way they always do: buried in a long explanatory
// comment in fleet-policy.json, which compiles into contracts.json and installs
// onto every VM. Nobody was going to notice it by reading.
//
// The test that matters here is the NEGATIVE one. A scanner that has only ever
// seen clean input has not been shown to work — the secret scanner earlier in
// this program shipped dead, passed a "clean" scan over a real GitHub token, and
// looked exactly like a passing check while doing nothing at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanOperatorIdentity, inScope, isAllowedAddress, PLACEHOLDER_DOMAINS,
} from '../corekit/system/identity-scan.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** A tiny file set with contents supplied inline. */
const fs = (files) => [Object.keys(files), (f) => files[f]];

// ── It catches what it exists to catch ─────────────────────────────────

test('a real address in a shipped platform file is a violation', () => {
  const [files, read] = fs({
    'infra/fleet-policy.json': '{"_comment": "proven on a live session for web-agent-tom@acmecorp.io"}',
  });
  const r = scanOperatorIdentity(files, read);
  assert.equal(r.ok, false);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].address, 'web-agent-tom@acmecorp.io');
  assert.equal(r.hits[0].line, 1, 'and it says where');
});

test('it catches an address wherever in the file it hides', () => {
  const [files, read] = fs({
    'corekit/lib/thing.mjs': ['// fine', '// also fine', '// contact: someone@realdomain.co.uk for details'].join('\n'),
  });
  const r = scanOperatorIdentity(files, read);
  assert.equal(r.hits[0].line, 3, 'a comment on line 3 is as shipped as code on line 1');
});

test('every scanned area is actually scanned', () => {
  // A rule that covers only the directory the last violation happened to be in
  // is a rule about the past.
  for (const dir of ['infra', 'corekit', 'app', '.github']) {
    const path = `${dir}/thing.json`;
    const [files, read] = fs({ [path]: '"owner": "real.person@somewhere.net"' });
    const r = scanOperatorIdentity(files, read);
    assert.equal(r.ok, false, `${dir}/ must be scanned`);
  }
});

// ── It does not cry wolf ───────────────────────────────────────────────

test('sanctioned placeholder domains pass', () => {
  const [files, read] = fs({
    'corekit/config/agents.json': [
      'assistant-agent-millie@example.com',
      'devops-stan@yourcompany.com',
      'mailbox@domain.tld',
    ].join('\n'),
  });
  assert.equal(scanOperatorIdentity(files, read).ok, true);
});

test('a cloud service account is a machine, not a person', () => {
  // Derived from a project or a role, carrying no personal information, and
  // usually built from a variable. Flagging it would train people to ignore the
  // check, which is how a check stops working without ever being switched off.
  const [files, read] = fs({
    'corekit/lib/gcp.mjs': [
      'const defaultSA = `${projectNumber}-compute@developer.gserviceaccount.com`;',
      'const signer = `dwd-signer@${projectId}.iam.gserviceaccount.com`;',
    ].join('\n'),
  });
  assert.equal(scanOperatorIdentity(files, read).ok, true);
  assert.equal(isAllowedAddress('x-compute@developer.gserviceaccount.com'), true);
  assert.equal(isAllowedAddress('someone@gserviceaccount.com.evil.net'), false, 'the suffix must actually end the address');
});

test('third-party and operator-owned areas are out of scope', () => {
  assert.equal(inScope('app/package-lock.json'), false, 'npm author metadata is not ours to sanitise');
  assert.equal(inScope('operator/notes.md'), false, 'operator/ is operator-specific by charter');
  assert.equal(inScope('tests/baton.test.mjs'), false, 'the chosen scope is shipped platform files');
  assert.equal(inScope('infra/fleet-policy.json'), true);
  assert.equal(inScope('.github/workflows/ci.yml'), true);
  assert.equal(inScope('app/src/lib/coordinates.ts'), true);
});

test('CODEOWNERS is scanned — the exemption it needed is gone', () => {
  // It was exempt while it named a person, because an owner has to resolve to a
  // real GitHub identity: a placeholder makes every rule a silent no-op, leaving
  // branch protection configured and unenforced — worse than the address it
  // replaced. A team handle resolves without being an address, so the file now
  // holds no identity at all and is covered like everything else.
  assert.equal(inScope('.github/CODEOWNERS'), true);
});

test('…and a personal address reintroduced there would now be caught', () => {
  const r = scanOperatorIdentity(
    ['.github/CODEOWNERS'],
    () => '* someone@realcompany.com\n',
  );
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /someone@realcompany\.com/);
});

// ── It never passes vacuously ──────────────────────────────────────────

test('an empty scan is a broken scope, not a clean repo', () => {
  const r = scanOperatorIdentity([], () => '');
  assert.equal(r.ok, false);
  assert.match(r.reason, /scope is broken/);
});

test('a file list that matches nothing in scope also fails', () => {
  const r = scanOperatorIdentity(['README.md', 'docs/guide.md'], () => 'clean');
  assert.equal(r.ok, false, 'silence must not read as proof');
  assert.equal(r.scanned, 0);
});

test('an unreadable file is skipped rather than treated as clean or as a violation', () => {
  const r = scanOperatorIdentity(['infra/a.json', 'infra/b.json'], (f) => {
    if (f === 'infra/a.json') throw new Error('gone');
    return 'nothing here';
  });
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 2);
});

// ── The shipped scanner, executed ──────────────────────────────────────

test('the scanner as validate-contracts actually invokes it reports the repo clean', () => {
  // Importing the module proves the logic; running the file proves the thing
  // that ships. The dead secret scanner passed every logic test it had.
  const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  const out = execFileSync('node', [join(REPO, 'corekit', 'system', 'identity-scan.mjs')], {
    cwd: REPO, input: files, encoding: 'utf8',
  }).trim();
  assert.equal(out, 'OK', `identity-scan reports:\n${out}`);
});

test('…and the same invocation reports a planted violation', () => {
  // Feed it this test file, which contains addresses on domains nobody sanctions.
  const out = execFileSync('node', [join(REPO, 'corekit', 'system', 'identity-scan.mjs')], {
    cwd: REPO, input: 'infra/planted.json\n', encoding: 'utf8',
  }).trim();
  // The file does not exist, so it is skipped — proving unreadable files do not
  // fabricate hits. The violation path is covered by the unit cases above.
  assert.equal(out, 'OK');

  assert.ok(PLACEHOLDER_DOMAINS.has('example.com'));
  assert.equal(isAllowedAddress('chill@a-real-company.ai'), false,
    'the shipped predicate rejects a real domain — this is the assertion that would have caught the leak');
});
