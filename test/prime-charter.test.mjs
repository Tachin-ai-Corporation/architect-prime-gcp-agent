// test/prime-charter.test.mjs — Prime is a Fleet Architect, structurally
//
// The boundary this locks down is the one the whole program rests on: a deployed
// Prime authors what its agents *are*, and cannot author how the product works.
// Doctrine alone does not hold that line — a prompt is not a boundary — so what
// is tested here is the *structure*: which credentials install, which skills
// exist, and whether the escalation path is real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/**
 * Prose for substring assertions: comment markers, markdown emphasis and line
 * wrapping collapsed away. A claim should not fail a test because a sentence
 * happened to wrap, and a test that forces prose onto one line makes the source
 * worse to read.
 */
const prose = (text) => text
  .replace(/^[ 	]*#[ 	]?/gm, '')
  .replace(/\*\*/g, '')
  .replace(/`/g, '')
  .replace(/\s+/g, ' ');

const ROLE_PRIME = read('infra/manifests/role-prime.txt');
const PRIME_SOUL = read('platform/organ-firmware/prime/cortex/SOUL.md');

/** Manifest lines that actually install something, ignoring commentary. */
function installedPaths(manifest) {
  return manifest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]);
}

// ── The credential boundary (C-34) ─────────────────────────────────────

test('no Prime installs a repository authorship skill', () => {
  const installed = installedPaths(ROLE_PRIME);
  const offenders = installed.filter((p) => /skills\/(github-pr|git-ops)\//.test(p));
  assert.deepEqual(
    offenders,
    [],
    'a deployed Prime holding repository push capability makes the Foundation boundary a matter of\n' +
      'prompt discipline rather than structure (C-34). Repo authorship is the Repo Maintainer\'s.'
  );
});

test('the github-pr binaries do not reach any agent', () => {
  const installed = installedPaths(ROLE_PRIME);
  for (const bin of ['github-clone', 'github-pr-open']) {
    assert.ok(
      !installed.some((p) => p.endsWith(`/${bin}`)),
      `${bin} must not install — it is a push path`
    );
  }
});

test('the removal is explained where someone would look to undo it', () => {
  assert.match(ROLE_PRIME, /DELIBERATELY ABSENT \(C-34\)/,
    'a deleted capability with no explanation gets restored by the next person who misses it');
  assert.ok(prose(ROLE_PRIME).includes('Platform Finding'),
    'and it must name where the need goes instead');
});

// ── The escalation path exists before the credential is gone ───────────

test('Prime installs the fleet-architecture skill and its tool', () => {
  const installed = installedPaths(ROLE_PRIME);
  assert.ok(installed.includes('skills/fleet-architecture/SKILL.md'), 'the handbook must install');
  assert.ok(installed.includes('skills/fleet-architecture/skill.json'));
  assert.ok(installed.includes('corekit/system/fleet-config-launcher'), 'and the tool it drives');
});

test('the fleet-architecture skill declares the tool it actually drives (B-17)', () => {
  const meta = JSON.parse(read('skills/fleet-architecture/skill.json'));
  assert.deepEqual(meta.scripts, ['fleet-config']);
  assert.ok(meta.when_to_use.length > 50, 'a selection cue an organ can act on');
  assert.deepEqual(meta.agent_part, ['cortex', 'prefrontal'], 'authoring is a planning job, not a motor one');
});

test('the handbook teaches the plane test, the lifecycle, and the escalation', () => {
  const doc = prose(read('skills/fleet-architecture/SKILL.md'));
  for (const required of [
    'which plane',           // classification comes first
    'fleet-config validate', // never skip validation
    '--pin',                 // what makes a canary a canary
    'rollback',
    'Platform Finding',
    'Do not overfit',        // the failure mode most likely to hurt
    'idle mission boundary',
  ]) {
    assert.ok(doc.includes(required), `the handbook must cover: ${required}`);
  }
});

test('the handbook states what it never does', () => {
  const doc = read('skills/fleet-architecture/SKILL.md');
  assert.match(doc, /## What this skill never does/);
  assert.match(doc, /pull request against the product repository/);
});

// ── The Platform Finding is a real command, not a doc promise ──────────

test('fleet-config implements finding create, list and status', () => {
  const cli = read('corekit/system/fleet-config');
  assert.match(cli, /finding: cmdFinding/, 'the command must be wired, not only documented');
  for (const sub of ["sub === 'list'", "sub === 'status'", "sub !== 'create'"]) {
    assert.ok(cli.includes(sub), `finding ${sub} must be handled`);
  }
});

test('a finding cannot be filed without the fields a maintainer needs', () => {
  const cli = read('corekit/system/fleet-config');
  for (const flag of ['--title', '--class', '--invariant', '--why-not', '--missions']) {
    assert.ok(cli.includes(`missing.push('${flag}')`), `${flag} must be required`);
  }
  assert.match(cli, /a complaint, not a report/);
});

test('a finding is scanned before it leaves the deployment (C-8)', () => {
  const cli = read('corekit/system/fleet-config');
  assert.match(cli, /function scanForSecrets/);
  assert.match(cli, /refusing to file/);
});

test('the secret scanner actually matches — it once could not', () => {
  // Shipped dead: a patch wrote a literal backspace byte (0x08) where each regex
  // word boundary belonged, so every pattern was `/<BACKSPACE>ghp_…/` and matched
  // nothing. The guard reported a clean scan over a real token and filed it. A
  // security check that cannot fail is worse than none, because it is trusted.
  const cli = read('corekit/system/fleet-config');
  assert.ok(!cli.includes(String.fromCharCode(8)), 'no stray control characters in the source');

  const at = cli.indexOf('function scanForSecrets');
  assert.notEqual(at, -1, 'the scanner must exist');
  const close = cli.indexOf(`${String.fromCharCode(10)}}`, at);
  const src = cli.slice(at, close + 2);

  // eslint-disable-next-line no-eval
  const scan = eval(`(${src.replace('function scanForSecrets', 'function')})`);

  assert.equal(scan('token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').secrets_found, 1, 'GitHub token');
  assert.equal(scan('AKIAIOSFODNN7EXAMPLE').secrets_found, 1, 'AWS key id');
  assert.equal(scan('-----BEGIN RSA PRIVATE KEY-----').secrets_found, 1, 'private key');
  assert.equal(scan('ssn 123-45-6789').pii_found, 1, 'SSN');

  const clean = scan('No approved provider exposes the ticket API, so a skill cannot bind it.');
  assert.equal(clean.secrets_found, 0, 'ordinary prose must not trip it');
  assert.equal(clean.pii_found, 0, 'a validator that cries wolf gets disabled');
});

// ── The charter is a charter, not a manual ─────────────────────────────

test('the Prime SOUL names the Fleet Architect mandate and its boundary', () => {
  assert.match(PRIME_SOUL, /Fleet Architect and Operator/);
  assert.match(PRIME_SOUL, /Platform Finding/);
  assert.match(PRIME_SOUL, /rollback target by name/, 'reversibility is part of the mandate, not a tip');
});

test('the SOUL no longer promises repository contribution', () => {
  assert.doesNotMatch(PRIME_SOUL, /pull request to the generic repo/);
  assert.doesNotMatch(PRIME_SOUL, /self-improvement pipeline is being reimplemented/,
    'the pipeline exists now — an organ must not describe the system as unfinished when it is not');
  assert.match(PRIME_SOUL, /hold no credential that could push to the\s*\n?product repository/);
});

test('the charter delegates method to the skill rather than inlining it (B-16)', () => {
  assert.match(PRIME_SOUL, /`fleet-architecture` skill holds the method/);
  // Tool syntax in an organ is the single most common layer leak.
  assert.doesNotMatch(PRIME_SOUL, /fleet-config (validate|release|assign|rollback)/,
    'command syntax belongs in the skill, never in a soul (C-28)');
});

// ── Prime has a cadence (the D9 gap) ───────────────────────────────────

test('Prime has responsibilities, and they only draft', () => {
  const resp = JSON.parse(read('corekit/config/responsibilities-prime.json'));
  assert.ok(resp.responsibilities.length >= 1, 'an empty array meant fleet learning waited for someone to ask');

  const ids = resp.responsibilities.map((r) => r.id);
  assert.ok(ids.includes('r-fleet-improvement-review'));
  assert.ok(ids.includes('r-fleet-drift-check'));

  for (const r of resp.responsibilities) {
    assert.ok(r.schedule, `${r.id} needs a schedule`);
    assert.equal(r.timezone, 'UTC', `${r.id} must state its timezone — one omitted silently shifts`);
    assert.ok(r.success_criteria?.length > 20, `${r.id} needs criteria it can judge itself against`);
  }

  const review = resp.responsibilities.find((r) => r.id === 'r-fleet-improvement-review');
  assert.match(review.instruction, /do NOT release, assign or promote/i,
    'an autonomous cadence that can promote is not low-risk');
  assert.match(review.success_criteria, /Nothing was promoted/);
});

test('the improvement review requires a pattern, not an anecdote', () => {
  const resp = JSON.parse(read('corekit/config/responsibilities-prime.json'));
  const review = resp.responsibilities.find((r) => r.id === 'r-fleet-improvement-review');
  assert.match(review.instruction, /at least twice/,
    'one failure is an anecdote — overfitting it is how a fix makes the next run worse');
});
