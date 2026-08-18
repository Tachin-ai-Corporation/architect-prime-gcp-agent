// The Fleet Definition lifecycle must not act on a storage failure (P0-7).
//
// platform/persistence/firestore.mjs returned `null` from read() for a 404, a 500
// and a 403 alike, and `[]` from query() on any error. An outage was therefore
// indistinguishable from an empty world, and the lifecycle acted on the
// difference without knowing there was one.
//
// The fix is opt-in: `{ strict: true }` throws StoreUnavailable on any non-404,
// and registry.mjs plus the fleet-config CLI pass it everywhere. Opt-in rather
// than default because ~40 caller catch sites already convert exceptions back
// into null/[] — a default throw would relocate the defect into the callers
// rather than remove it, and would make agent-brain's intake path (which marks an
// intake permanently `failed` after three ticks) strictly worse.
//
// These tests drive the REAL registry against a db double that fails the way
// Firestore fails, and assert the lifecycle leaves state untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from '../platform/deployment/registry.mjs';
import { StoreUnavailable } from '../platform/persistence/firestore.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── The double ────────────────────────────────────────────────────────────
//
// It reproduces the SEMANTICS of the fixed client, not of the broken one: 404 is
// absence and returns null; anything else throws when the caller asked for
// strict. If the caller did NOT ask, it returns the old permissive value — which
// is what makes the "did registry actually pass strict?" assertions meaningful.

function failingDb({ status = 500 } = {}) {
  const docs = new Map();
  const calls = { strict: 0, permissive: 0 };
  const guard = (op, path, opts) => {
    if (opts && opts.strict) { calls.strict += 1; throw new StoreUnavailable(op, path, status, 'injected'); }
    calls.permissive += 1;
    return undefined;
  };
  return {
    docs,
    calls,
    async read(path, opts = {}) { const r = guard('read', path, opts); return r === undefined ? null : r; },
    async write(path, data, opts = {}) { guard('write', path, opts); docs.set(path, data); return data; },
    async patch(path, _f, data, opts = {}) { guard('patch', path, opts); docs.set(path, data); },
    async del(path, opts = {}) { guard('del', path, opts); docs.delete(path); },
    async query(_p, collectionId, _f, opts = {}) { const r = guard('query', collectionId, opts); return r === undefined ? [] : r; },
  };
}

const registryOn = (db) => createRegistry({ projectId: 'p', actor: 'test', logger: () => {}, db });

// ── The lifecycle refuses to act ─────────────────────────────────────────

test('assign() refuses on an unreadable store and writes nothing', () => {
  // The destructive one. assign() reads the existing assignment and rebuilds the
  // record from it, so a null-on-outage silently DESTROYS actual_release and
  // actual_spec_digest — the fleet's own record of what it is running.
  const db = failingDb();
  const r = registryOn(db);
  return assert.rejects(
    () => r.assign({ releaseId: 'fr-1', agents: ['millie'] }),
    (e) => e instanceof StoreUnavailable,
    'an unreadable store must stop the assignment, not produce a blank one',
  ).then(() => {
    assert.equal(db.docs.size, 0, 'nothing may be persisted from a failed read');
    assert.ok(db.calls.strict > 0, 'and it must have ASKED for strict — otherwise this passes for the wrong reason');
    assert.equal(db.calls.permissive, 0, 'no lifecycle call may be permissive');
  });
});

test('rollback() writes nothing when the fleet cannot be enumerated', async () => {
  // rollback repoints every assignment and then flips the release to
  // 'rolled-back'. With query() returning [] on failure it would repoint NOTHING
  // and still declare the rollback done — the most dangerous possible outcome,
  // because the operator is told the fleet moved when it did not.
  const db = failingDb();
  const r = registryOn(db);
  await assert.rejects(() => r.rollback({ releaseId: 'fr-2', reason: 'regression' }),
    (e) => e instanceof StoreUnavailable);
  assert.equal(db.docs.size, 0, 'a rollback that could not read the fleet must not record itself as done');
});

test('a 404 is still absence, not an outage', async () => {
  // The half that must NOT change. Genuine absence is a real answer and the
  // lifecycle depends on it — "no such release" is how validation reports a bad
  // id. If strict turned 404 into an error, every not-found path would become a
  // crash.
  const absent = {
    docs: new Map(),
    async read() { return null; },          // what the real client returns for 404
    async write(p, d) { this.docs.set(p, d); return d; },
    async patch() {}, async del() {},
    async query() { return []; },
  };
  const r = registryOn(absent);
  await assert.rejects(() => r.assign({ releaseId: 'nope', agents: ['millie'] }),
    (e) => e instanceof StoreUnavailable === false && /not found|does not exist|unknown|no such/i.test(e.message),
    'a missing release must fail as a missing release, not as a storage outage');
});

// ── The wiring, so a future edit cannot quietly drop strict ───────────────

test('every lifecycle storage call passes strict', () => {
  // The transform that added these was written twice: the first version used a
  // lazy regex that stopped at the first ')', so for
  // `db.read(pathFor('fleetRelease', id))` it inserted the options object INSIDE
  // pathFor(...) as a junk third argument. It parsed, it looked right in a grep,
  // and strict was silently never applied. This is the check that would have
  // caught it.
  const src = readFileSync(join(repo, 'platform', 'deployment', 'registry.mjs'), 'utf8');
  const calls = [...src.matchAll(/db\.(read|write|query|patch|del)\(/g)];
  assert.ok(calls.length >= 20, `expected the lifecycle to have many storage calls, found ${calls.length}`);

  const bad = [];
  for (const m of calls) {
    // Walk to the closing paren of this call and check the argument list.
    let depth = 0; let i = m.index + m[0].length - 1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) break; }
      else if (c === "'" || c === '"' || c === '`') { const q = c; i += 1; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; } }
    }
    const args = src.slice(m.index + m[0].length, i);
    // strict must be an argument of THIS call, not nested inside another call.
    const topLevel = (() => {
      let d = 0;
      for (let j = 0; j < args.length; j += 1) {
        const c = args[j];
        if (c === '(') d += 1;
        else if (c === ')') d -= 1;
        else if (d === 0 && args.startsWith('strict', j)) return true;
      }
      return false;
    })();
    if (!topLevel) bad.push(src.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(bad, [], `registry.mjs lines with a storage call that does not pass strict at the top level: ${bad.join(', ')}`);
});

test('the CLI does not reach around the registry with a permissive client', () => {
  // registry._db is exported and the CLI drives the lifecycle through it
  // directly. Making registry.mjs strict fixes only half the lifecycle if these
  // are missed.
  const src = readFileSync(join(repo, 'corekit', 'system', 'fleet-config'), 'utf8');
  const lines = src.split('\n');
  const offenders = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /registry\._db\.\w+\(/.test(l))
    .filter(({ l }) => !l.includes('strict'))
    // One deliberate exception, and it must still be the documented one.
    .filter(({ l }) => !l.includes('catch(() => null)'));
  assert.deepEqual(offenders.map((o) => o.n), [],
    `fleet-config drives the lifecycle through registry._db without strict at: ${offenders.map((o) => o.n).join(', ')}`);

  const bestEffort = lines.findIndex((l) => l.includes('catch(() => null)') && l.includes('registry._db'));
  assert.ok(bestEffort > 0, 'the one permissive call must still exist to be explained');
  assert.match(lines.slice(Math.max(0, bestEffort - 6), bestEffort).join('\n'), /deliberately NOT strict/,
    'the exception must carry its reason, or the next reader will "fix" it or copy it');
});

test('every Firestore call has a timeout', () => {
  // There was none. The token fetch had AbortSignal.timeout(5_000); the five
  // calls it authorises had nothing, so a hung connection blocked a poll tick
  // forever — a worse failure than an error, because an error terminates.
  const src = readFileSync(join(repo, 'platform', 'persistence', 'firestore.mjs'), 'utf8');
  const fetches = (src.match(/await fetch\(/g) || []).length;
  const signals = (src.match(/signal: abort\(\)/g) || []).length;
  assert.equal(signals, fetches, `${fetches} fetches but ${signals} timeouts — a hung call blocks the caller indefinitely`);
});
