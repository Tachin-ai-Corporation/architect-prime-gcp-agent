// Regression: work recall must scope to the running prime's OWN work.
// Primes share owner "prime" (no email identity), so without a prime_id scope a
// fresh prime recalled another prime's missions as its own — the identity
// cross-population where prime "mm" reported prime "chuck"'s fleet agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWork, recentWorkDigest } from '../platform/work/work-recall.mjs';

const now = new Date().toISOString();
const base = { type: 'M', status: 'complete', owner: 'prime', title: 'shared roster review', created_at: now, completed_at: now, updated_at: now, output: 'done' };
const DOCS = [
  { ...base, id: 'w-mine', prime_id: 'mm' },
  { ...base, id: 'w-chuck', prime_id: 'chuck' },
  { ...base, id: 'w-legacy' }, // no prime_id (pre-stamp doc)
];

// Fake injected firestoreQuery: the shared top-level `work` collection returns
// every prime's docs for owner "prime"; only the status filter is honored (as the
// real indexed query does), so client-side prime scoping is what must isolate.
const fakeFirestore = (docs) => async (_c, filters) => {
  const status = filters.find((f) => f.field === 'status')?.value?.stringValue;
  return docs.filter((d) => d.status === status);
};
const cues = ['shared', 'roster'];

test('recentWorkDigest with primeId keeps own + unstamped, drops other prime', async () => {
  const d = await recentWorkDigest({ firestoreQuery: fakeFirestore(DOCS), owner: 'prime', primeId: 'mm', sinceDays: 30 });
  assert.match(d, /w-mine/);
  assert.doesNotMatch(d, /w-chuck/);   // cross-prime bleed stopped
  assert.match(d, /w-legacy/);          // unstamped legacy doc kept (lenient)
});

test('recentWorkDigest without primeId is unscoped (back-compat for fleet agents w/ unique owner)', async () => {
  const d = await recentWorkDigest({ firestoreQuery: fakeFirestore(DOCS), owner: 'prime', sinceDays: 30 });
  assert.match(d, /w-chuck/);
});

test('searchWork with primeId drops the other prime, keeps own + unstamped', async () => {
  const hits = await searchWork({ firestoreQuery: fakeFirestore(DOCS), owner: 'prime', primeId: 'mm', cues, sinceDays: 30 });
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('w-mine'), 'own work retained');
  assert.ok(ids.includes('w-legacy'), 'unstamped legacy retained');
  assert.ok(!ids.includes('w-chuck'), 'other prime work dropped');
});

test('searchWork without primeId returns the other prime too (no scope)', async () => {
  const hits = await searchWork({ firestoreQuery: fakeFirestore(DOCS), owner: 'prime', cues, sinceDays: 30 });
  assert.ok(hits.map((h) => h.id).includes('w-chuck'));
});
