// A storage failure is not a mission verdict (Finding H).
//
// The worst defect found in this program, and it was a COMMENT problem as much as
// a code problem. agent-brain.mjs:5089 read:
//
//     // Null child = deleted from Firestore (treat as failed)
//
// A sound inference — if null means absent. The permissive client returned null
// for a 500 and a 403 too, so during a read outage every healthy in-flight
// delegate became a synthetic FAILED result. That verdict was then acted on
// irreversibly: the checkpoint stamped `failed`, the parent re-queued around a
// failure that never happened, the re-delegation counter bumped, and at the cap a
// human told "the delegate could not do it". Firestore recovering undid none of it.
//
// Three sibling sites had the same shape: a delegation dedup guard whose catch
// could never fire (query returned [] instead of throwing, so an outage produced
// two live missions and two acks for one delegation), a durable claim that failed
// OPEN, and a dual-read fallback that doubled read load during an outage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoreUnavailable } from '../platform/persistence/firestore.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repo, 'platform', 'runtime', 'agent-brain.mjs'), 'utf8');

function fnSource(name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`agent-brain.mjs no longer defines ${name}() — this test is stale, not passing`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

/** Stand firestoreReadStrict up over a stub client. */
function strictReader({ primary, fallback }) {
  const calls = [];
  const _db = {
    async read(path, opts) {
      calls.push({ path, strict: !!opts?.strict });
      const answer = calls.length === 1 ? primary : fallback;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const fn = new Function('deps', `
    const { _db, pathFor, DEPLOYMENT_ROOTED, PRIME_ID } = deps;
    ${fnSource('firestoreReadStrict')}
    return firestoreReadStrict;
  `)({
    _db,
    pathFor: (c, id) => `${c}/${id}`,
    DEPLOYMENT_ROOTED: new Set(['work']),
    PRIME_ID: 'chuck',
  });
  return { fn, calls };
}

// ---- the strict reader itself -------------------------------------------

test('a store failure PROPAGATES rather than becoming null', async () => {
  const { fn } = strictReader({ primary: new StoreUnavailable('read', 'work/w-1', 500, 'boom') });
  await assert.rejects(() => fn('work', 'w-1'), (e) => e instanceof StoreUnavailable,
    'the whole point: the caller must be able to tell "could not look" from "not there"');
});

test('a genuine 404 still falls back to the legacy path', async () => {
  // The dual-read must keep working for real absence, which is what it was for.
  const { fn, calls } = strictReader({ primary: null, fallback: { id: 'w-1', found: 'legacy' } });
  const got = await fn('work', 'w-1');
  assert.deepEqual(got, { id: 'w-1', found: 'legacy' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.strict), 'both reads must be strict, or the fallback reopens the hole');
});

test('a store failure does NOT trigger the second read', async () => {
  // The retry amplifier. The fallback fires on `!result`, so with the permissive
  // read an outage produced a SECOND read for every deployment-rooted collection
  // — doubling load at the moment the backend was already degraded.
  const { fn, calls } = strictReader({ primary: new StoreUnavailable('read', 'work/w-1', 503, 'down') });
  await assert.rejects(() => fn('work', 'w-1'));
  assert.equal(calls.length, 1, 'one failed read must not become two');
});

// ---- the sites that acted on the difference ------------------------------

test('the delegate scan defers instead of inventing a FAILED verdict', () => {
  const at = src.indexOf('// UNREADABLE IS NOT FAILED.');
  assert.ok(at > 0, 'the Phase A scan must carry the rule it now follows');

  const body = src.slice(at, at + 4000);
  assert.match(body, /child = await firestoreReadStrict\('work', childId\);/);
  assert.match(body, /unreadable = `\$\{childId\}: \$\{e\.message\}`;/);

  // The deferral must come BEFORE the conclusion, or a partial scan still concludes.
  const defer = src.indexOf('if (unreadable) {');
  const conclude = src.indexOf('if (!allChildrenDone || childResults.length === 0) continue;');
  assert.ok(defer > 0 && conclude > defer,
    'a partial childResults list is MORE dangerous than none: the unread children look absent, '
    + 'so allChildrenDone stays true and the parent concludes on a subset');
});

test('the checkpoint scan defers the same way', () => {
  const defer = src.indexOf('if (cpUnreadable) {');
  const conclude = src.indexOf('if (!allDone || cpResults.length === 0) continue;');
  assert.ok(defer > 0 && conclude > defer);
  assert.match(src, /tc = await firestoreReadStrict\('work', tcId\);/);
});

test('the delegation dedup guard can now actually fire', () => {
  // Its catch said "skipping to avoid a duplicate" while query() returned []
  // instead of throwing — dead code documenting a guard that did not exist.
  assert.match(src, /const existing = await firestoreQueryStrict\('work', \[/);
  const at = src.indexOf("const existing = await firestoreQueryStrict('work', [");
  assert.match(src.slice(at, at + 600), /skipping to avoid a duplicate/);
});

test('the durable claim declines when it cannot tell', () => {
  // This is the one that nearly shipped broken: the read was made strict while
  // the catch below still returned claimId, which would have made the strictness
  // completely inert. A guard one line below can disarm is not a guard.
  const claim = fnSource('claimEnvelope');
  assert.match(claim, /const env = await firestoreReadStrict\('work', envelopeId\);/);
  assert.match(claim, /e\?\.name === 'StoreUnavailable'/);

  const decline = claim.indexOf("e?.name === 'StoreUnavailable'");
  const proceed = claim.indexOf('return claimId; // Proceed anyway');
  assert.ok(decline > 0 && proceed > decline,
    'the StoreUnavailable branch must come FIRST, or the catch-all swallows it');
});

// ---- what deliberately did NOT change ------------------------------------

test('the permissive wrappers survive and are still the common case', () => {
  // ~100 call sites where "nothing there" and "could not look" lead to the same
  // harmless no-op. Flipping them all would relocate the defect into the ~40
  // caller catch sites that convert exceptions back into null/[].
  assert.match(src, /^async function firestoreRead\(collection, docId\) \{$/m);
  assert.match(src, /^async function firestoreQuery\(collection, filters, opts\) \{$/m);

  const permissive = (src.match(/await firestoreRead\(/g) || []).length;
  assert.ok(permissive > 20,
    `expected the permissive read to remain the common case, found ${permissive} uses — `
    + 'if this dropped sharply someone flipped the default, which is a different and much larger change');
});

test('every strict call site is in the strict family', () => {
  // A site that reads a delegate or a claim through the PERMISSIVE wrapper has
  // the original defect back. Checked by name so a new one is noticed.
  for (const marker of [
    "child = await firestoreReadStrict('work', childId)",
    "tc = await firestoreReadStrict('work', tcId)",
    "const env = await firestoreReadStrict('work', envelopeId)",
    "const existing = await firestoreQueryStrict('work', [",
  ]) {
    assert.ok(src.includes(marker), `missing strict site: ${marker}`);
  }
});
