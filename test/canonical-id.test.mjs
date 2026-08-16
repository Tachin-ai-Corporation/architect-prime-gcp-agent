// test/canonical-id.test.mjs — C-31: the document ID is the entity ID
//
// Two guards, because this defect class had two halves:
//
//   1. Unit tests for the runtime reconciler — a record whose stored body omits
//      `id` must still load, deriving identity from the document path.
//   2. A cross-surface source scan — every control-plane writer on a canonical
//      collection must route its body through `withCanonicalId`, so the stored
//      body and the document path never disagree in the first place.
//
// The live defect this replaces: `POST /api/projects` and
// `POST /api/primes/[id]/processes` persisted under `doc(body.id)` while
// omitting `id` from the object. `platform/control-plane/projects.mjs` and
// `platform/work/process-registry.mjs` accepted only records with a truthy `id`,
// so the dashboard reported success and no agent ever saw the record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { docIdFromName, reconcileEntityId, withCanonicalId } from '../platform/persistence/entity-id.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOC_BASE = 'projects/tenant/databases/(default)/documents';

// ── docIdFromName ──────────────────────────────────────────────────────

test('docIdFromName extracts the trailing segment of a REST resource name', () => {
  assert.equal(docIdFromName(`${DOC_BASE}/projects/marketing-site`), 'marketing-site');
  assert.equal(docIdFromName(`${DOC_BASE}/processes/p-plan`), 'p-plan');
  assert.equal(docIdFromName(`${DOC_BASE}/primes/chuck/fleet/millie`), 'millie');
});

test('docIdFromName tolerates trailing slashes and bare ids', () => {
  assert.equal(docIdFromName(`${DOC_BASE}/projects/marketing-site/`), 'marketing-site');
  assert.equal(docIdFromName('bare-id'), 'bare-id');
});

test('docIdFromName returns empty string for non-string or empty input', () => {
  assert.equal(docIdFromName(''), '');
  assert.equal(docIdFromName(null), '');
  assert.equal(docIdFromName(undefined), '');
  assert.equal(docIdFromName(42), '');
});

// ── reconcileEntityId ──────────────────────────────────────────────────

test('reconcileEntityId recovers a record whose body omits id (the live defect)', () => {
  // Exactly what POST /api/projects used to store.
  const stored = { name: 'Acme Marketing Site', description: 'Marketing site', status: 'active' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/projects/marketing-site`);

  assert.equal(id, 'marketing-site');
  assert.equal(entity.id, 'marketing-site');
  assert.equal(entity.name, 'Acme Marketing Site');
  assert.equal(mismatch, null);
});

test('reconcileEntityId leaves an agreeing body untouched', () => {
  const stored = { id: 'p-plan', name: 'Plan', narrative: 'When we plan work well…' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/processes/p-plan`);

  assert.equal(id, 'p-plan');
  assert.equal(entity.id, 'p-plan');
  assert.equal(mismatch, null);
});

test('reconcileEntityId reports a body/path disagreement and trusts the path', () => {
  const stored = { id: 'copied-from-elsewhere', name: 'Plan' };
  const { entity, id, mismatch } = reconcileEntityId(stored, `${DOC_BASE}/processes/p-plan`);

  assert.equal(id, 'p-plan', 'the document path is authoritative');
  assert.equal(entity.id, 'p-plan');
  assert.equal(mismatch, 'copied-from-elsewhere', 'the disagreement is surfaced, not swallowed');
});

test('reconcileEntityId falls back to the body id when the path is unusable', () => {
  const { entity, id } = reconcileEntityId({ id: 'from-body' }, '');
  assert.equal(id, 'from-body');
  assert.equal(entity.id, 'from-body');
});

test('reconcileEntityId yields no entity when neither path nor body has an id', () => {
  const { entity, id } = reconcileEntityId({ name: 'orphan' }, '');
  assert.equal(entity, null);
  assert.equal(id, '');
});

test('withCanonicalId stamps the id without mutating the input', () => {
  const body = { name: 'Plan' };
  const stamped = withCanonicalId('p-plan', body);
  assert.equal(stamped.id, 'p-plan');
  assert.equal(stamped.name, 'Plan');
  assert.equal(body.id, undefined, 'input is not mutated');
});

test('withCanonicalId overrides an id a caller tried to smuggle in', () => {
  const stamped = withCanonicalId('p-plan', { id: 'attacker-chosen', name: 'Plan' });
  assert.equal(stamped.id, 'p-plan');
});

// ── Runtime loaders derive identity from the document path ─────────────

test('runtime loaders reconcile identity from the document path', () => {
  for (const rel of ['platform/control-plane/projects.mjs', 'platform/work/process-registry.mjs']) {
    const src = readFileSync(join(REPO, rel), 'utf8');
    assert.match(
      src,
      /reconcileEntityId\(firestoreDecode\(doc\.fields \|\| \{\}\), doc\.name\)/,
      `${rel} must derive entity identity from the Firestore document path`
    );
  }
});

// ── Cross-surface scan: control-plane writers stamp the canonical id ───

/** Collect every .ts/.tsx file under a directory. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// Collections whose documents are loaded by an agent runtime by ID.
const CANONICAL_COLLECTIONS = ['projectsCol', 'processesCol'];

test('every control-plane writer on a canonical collection stamps the id', () => {
  const files = walk(join(REPO, 'app', 'src'));
  const offenders = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!CANONICAL_COLLECTIONS.some((c) => src.includes(`${c}()`))) continue;

    // Any persisting call on this file must have a withCanonicalId in scope.
    const writes = src.match(/\.(set|update)\(/g) || [];
    if (writes.length === 0) continue;

    if (!src.includes('withCanonicalId')) {
      offenders.push(`${file.slice(REPO.length + 1)} — ${writes.length} write(s), no withCanonicalId`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A writer on projects/ or processes/ persisted without stamping its canonical ID.\n' +
      'Route the body through withCanonicalId (app/src/lib/entity.ts) — a record whose\n' +
      'stored body lacks `id` used to be invisible to every agent.\n' +
      offenders.join('\n')
  );
});

test('the canonical-id helper exists on both surfaces', () => {
  const dash = readFileSync(join(REPO, 'app', 'src', 'lib', 'entity.ts'), 'utf8');
  assert.match(dash, /export function withCanonicalId/);

  const runtime = readFileSync(join(REPO, 'platform', 'persistence', 'entity-id.mjs'), 'utf8');
  assert.match(runtime, /export function reconcileEntityId/);
  assert.match(runtime, /export function docIdFromName/);
  assert.match(runtime, /export function withCanonicalId/);
});
