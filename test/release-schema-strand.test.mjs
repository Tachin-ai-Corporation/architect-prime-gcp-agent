// A schema migration can strand a sealed release, and a stranded release is not
// a tampered one.
//
// RESPONSIBILITY_SCHEMA went v1→v2 (994b9f0): the nested `trigger` object became a
// top-level `schedule`. A release sealed with a v1 responsibility is immutable, so
// once the code moved to v2 that release could no longer be read — and the reader
// reported it as "tampered". An operator who upgrades an agent onto v2 then sees an
// integrity alarm for content that is perfectly authentic, and goes hunting a
// security incident instead of re-authoring one responsibility.
//
// Two things are asserted here, and they are the whole point of the fix:
//   1. verifyRevision distinguishes a SCHEMA failure (authentic content, evolved
//      schema — recoverable) from an INTEGRITY failure (content changed outside the
//      lifecycle — a real incident). Same `ok:false`, different `code`.
//   2. The distinction survives even though the schema check runs FIRST: an
//      authentic-but-stale record is code 'schema', and a genuinely tampered record
//      is code 'integrity'.
//
// This is the R-2 gate the migration lacked: a check that fails on the real current
// state (millie's live release fr-6a524ab97fd1 contains exactly this v1 shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sealRevision, verifyRevision, contentDigest } from '../platform/contracts/index.mjs';
import { revisionFromDigest as revFromDigest } from '../platform/contracts/ids.mjs';

// A valid v2 responsibility, sealed the ordinary way.
const validV2 = () => sealRevision('responsibility', {
  id: 'r-sync-health-nightly',
  name: 'Nightly sync health',
  schedule: '0 9 * * 1',
  instruction: 'Check that every agent converged on its assigned release overnight.',
  success_criteria: 'A report naming any agent still in drift, or an all-clear.',
  enabled: true,
}, { actor: 'seed' });

// The v1 shape that predates the migration: a nested `trigger`, no top-level
// `schedule`. Digest and revision are computed over THIS content, so the record is
// authentic — it is what a v1 seal actually produced, reconstructed here because the
// v1 schema no longer exists to seal against.
const authenticV1 = () => {
  const body = {
    kind: 'responsibility',
    schema_version: 1,
    id: 'r-sync-health-nightly',
    name: 'Nightly sync health',
    trigger: { schedule: '0 9 * * 1', timezone: 'UTC' },
    instruction: 'Check that every agent converged on its assigned release overnight.',
    success_criteria: 'A report naming any agent still in drift, or an all-clear.',
    created_at: '2026-08-01T00:00:00.000Z',
    created_by: 'seed',
    parent_revision: null,
  };
  const digest = contentDigest(body);
  // revision derives from the digest the same way sealRevision does.
  return { ...body, digest, revision: revFromDigest(digest) };
};

// ---- the failure this whole change exists to make legible -----------------

test('a v1 responsibility read under v2 is a SCHEMA strand, not tampering', () => {
  const v1 = authenticV1();
  const verdict = verifyRevision('responsibility', v1);

  assert.equal(verdict.ok, false, 'v2 code cannot read a v1 record');
  assert.equal(verdict.code, 'schema',
    'the content is authentic — flagging it as an integrity failure sends the operator hunting a phantom incident');
  assert.notEqual(verdict.code, 'integrity');
  // The reason names the offending shape, so "re-author this responsibility" is the
  // obvious next step rather than "audit the store".
  assert.match(verdict.reason, /schema:/);
});

test('the stranded v1 record is genuinely authentic — its digest still verifies', () => {
  // This is what makes "schema, not tamper" true rather than merely asserted: the
  // record hashes to its own recorded digest (contentDigest excludes digest and
  // revision itself, so passing the whole record is correct). Only the schema moved.
  const v1 = authenticV1();
  assert.equal(contentDigest(v1), v1.digest, 'the v1 body hashes to its recorded digest');
});

// ---- and real tampering is still caught, with the OTHER code --------------

test('a record altered after sealing is an INTEGRITY failure', () => {
  const sealed = validV2();
  // Change a field to a value that is still schema-valid, but do NOT re-seal. The
  // content no longer hashes to its recorded digest.
  const tampered = { ...sealed, instruction: 'Quietly do something else entirely, at least ten chars.' };

  const verdict = verifyRevision('responsibility', tampered);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'integrity',
    'a post-seal edit that stays schema-valid must trip the digest check, not pass');
  assert.match(verdict.reason, /digest mismatch|outside the lifecycle/);
});

test('an untouched v2 record verifies clean', () => {
  const verdict = verifyRevision('responsibility', validV2());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 'ok');
});

// The digest is computed over the body WITHOUT its own digest/revision fields —
// mirror that here so the authenticity assertion checks the real thing.
function stripSeal(record) {
  const { digest, revision, ...body } = record;
  return body;
}
