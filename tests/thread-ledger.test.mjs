// tests/thread-ledger.test.mjs — pure-core tests for platform/work/thread-ledger.mjs (B-19)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { threadKeyFor, encodeResourceName } from '../platform/work/thread-ledger.mjs';

describe('encodeResourceName', () => {
  it('preserves case (lowercasing could merge distinct GChat threads)', () => {
    const a = encodeResourceName('spaces/AAaa/threads/BBbb');
    const b = encodeResourceName('spaces/aaAA/threads/bbBB');
    assert.notEqual(a, b);
  });
  it('maps / to ~ and is collision-free over the GChat id alphabet', () => {
    assert.equal(encodeResourceName('spaces/AB_c-1/threads/Zz9'), 'spaces~AB_c-1~threads~Zz9');
  });
  it('sanitizes characters outside the safe set', () => {
    assert.ok(!/[^A-Za-z0-9_~.-]/.test(encodeResourceName('weird id!with spaces')));
  });
});

describe('threadKeyFor', () => {
  it('keys gchat threads on the thread resource name', () => {
    const k = threadKeyFor({ channel: 'gchat', space: 'spaces/AAA', thread: 'spaces/AAA/threads/BBB' }, 'candicejr');
    assert.equal(k, 'gchat-spaces~AAA~threads~BBB');
  });
  it('falls back to the space for threadless DM spaces', () => {
    const k = threadKeyFor({ channel: 'gchat', space: 'spaces/AAA', thread: null }, 'candicejr');
    assert.equal(k, 'gchat-spaces~AAA');
  });
  it('keys the dashboard to one thread per prime', () => {
    assert.equal(threadKeyFor({ channel: 'dashboard' }, 'candicejr'), 'dash-candicejr');
  });
  it('returns null when unkeyable', () => {
    assert.equal(threadKeyFor(null, 'p'), null);
    assert.equal(threadKeyFor({ channel: 'gchat' }, 'p'), null);
    assert.equal(threadKeyFor({ channel: 'dashboard' }, ''), null);
  });
  it('two distinct case-variant threads never share a key', () => {
    const k1 = threadKeyFor({ channel: 'gchat', thread: 'spaces/A/threads/xY' }, 'p');
    const k2 = threadKeyFor({ channel: 'gchat', thread: 'spaces/A/threads/Xy' }, 'p');
    assert.notEqual(k1, k2);
  });
});
