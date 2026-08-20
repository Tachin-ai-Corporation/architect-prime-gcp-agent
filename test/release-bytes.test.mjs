// test/release-bytes.test.mjs — a release id must mean one set of bytes.
//
// The defect (audit P0-1, verified before fixing): the reconciliation daemon
// called `registry.readDefinitions()` — which reads the MUTABLE branch tip — and
// then stamped the compiled result with `assignment.desired_release`. So:
//
//   1. Prime authors a skill improvement; release A is cut and approved.
//   2. The branch advances to B.
//   3. An agent still assigned to A compiles B and reports it as A.
//
// Every coordinate reads correct while the fleet runs something nobody approved.
// Canary attribution, holdback, evaluation and rollback all rest on this, so it
// is the first thing fixed and the first thing pinned by a test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkoutCommit } from '../platform/persistence/git-store.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

describe('the daemon reads the assigned release, not the branch tip', () => {
  const daemon = read('platform/runtime/agent-content-sync.mjs');

  it('compiles from readReleaseDefinitions(assignment.desired_release)', () => {
    assert.match(
      daemon,
      /readReleaseDefinitions\(assignment\.desired_release\)/,
      'the compile must be pinned to the assigned release'
    );
  });

  it('no longer reads the mutable branch tip when compiling', () => {
    // The call that produced the defect. Its absence is the fix.
    assert.doesNotMatch(
      daemon,
      /registry\.readDefinitions\(\)/,
      'a mutable-tip read in the daemon reintroduces release drift'
    );
  });
});

describe('readReleaseDefinitions fails closed', () => {
  const registry = read('platform/deployment/registry.mjs');
  const fn = registry.slice(registry.indexOf('async function readReleaseDefinitions'));
  const body = fn.slice(0, fn.indexOf('\n  /** Enumerate the files'));

  it('refuses a release it cannot find', () => {
    assert.match(body, /unknown release/, 'a missing release must throw, not return empty');
  });

  it('refuses a release with no content commit', () => {
    assert.match(body, /records no content commit/,
      'a release whose bytes cannot be reproduced must not be applied');
  });

  it('pins the commit rather than trusting the branch', () => {
    assert.match(body, /checkoutCommit\(dir, commit\)/);
  });

  it('THROWS on an unreadable revision instead of collecting it', () => {
    // readDefinitions collects `corrupt` and continues — correct while authoring.
    // A release is a unit; a partially-readable one has no partial success.
    assert.match(body, /throw new Error\(`readRelease: \$\{releaseId\} \$\{kind\}\/\$\{id\}/,
      'an unreadable revision must throw, per-definition');
    assert.match(body, /has unparseable/, 'an unparseable revision must throw');
    assert.doesNotMatch(body, /corrupt\.push/, 'a release read must not degrade to a corrupt list');
  });

  it('distinguishes a schema strand from an integrity failure at the throw', () => {
    // A v1 record read by v2 code is authentic-but-stale, not tampered. Wording it
    // as tampering sent the operator hunting a phantom incident. The throw must
    // branch on verdict.code so the message names the real remedy.
    assert.match(body, /verdict\.code === 'schema'/, 'the throw must read the verdict code');
    assert.match(body, /re-author and cut a new release/, 'a schema strand is recoverable — say so');
    assert.match(body, /failed integrity verification/, 'a real tamper keeps the integrity wording');
  });

  it('recomputes the release digest and compares it', () => {
    // The commit pointer alone only proves *a* tree. Recomputing the digest with
    // createRelease's own formula proves it is *the* tree.
    assert.match(body, /recomputed !== release\.digest/, 'the digest must be re-derived, not trusted');
    assert.match(body, /digest mismatch/);
  });

  it('does not swallow a clone failure as an empty registry', () => {
    // "the store is unreachable" and "this release has no content" are different
    // facts, and this repo has already been bitten by treating one as the other.
    assert.doesNotMatch(body, /registry is empty/);
  });
});

describe('checkoutCommit — the pin itself', () => {
  it('rejects anything that is not a full 40-hex commit', () => {
    for (const bad of ['', 'main', 'abc123', 'z'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), null, undefined]) {
      assert.throws(() => checkoutCommit('/tmp/nope', bad), /not a full 40-hex commit/,
        `'${bad}' must be refused: an abbreviation can become ambiguous as a repo grows`);
    }
  });

  it('rejects a directory that is not a working tree, before touching git', () => {
    assert.throws(
      () => checkoutCommit(join(repoRoot, 'docs'), 'a'.repeat(40)),
      /not a git working tree/
    );
  });
});
