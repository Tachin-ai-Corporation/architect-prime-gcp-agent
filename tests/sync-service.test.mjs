// tests/sync-service.test.mjs — pure-core tests for the public-file sync (Item 3).
//
// The smart-sync delta decision and content-type mapping are extracted into
// services/sync-service/sync-core.js so they can be tested without Drive/GCS; index.js
// wires them into the real I/O. Guards the exact logic that had zero coverage before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contentTypeFor, planDelta } = require('../services/sync-service/sync-core.js');

describe('contentTypeFor', () => {
  it('maps web extensions (Drive mislabels these, which breaks rendering)', () => {
    assert.equal(contentTypeFor('index.html', 'text/plain'), 'text/html');
    assert.equal(contentTypeFor('style.CSS', 'x'), 'text/css');
    assert.equal(contentTypeFor('app.js', 'x'), 'application/javascript');
    assert.equal(contentTypeFor('notes.md', 'x'), 'text/markdown');
    assert.equal(contentTypeFor('data.json', 'x'), 'application/json');
  });
  it('falls back to the Drive mimeType for unknown extensions', () => {
    assert.equal(contentTypeFor('photo.png', 'image/png'), 'image/png');
    assert.equal(contentTypeFor('noext', 'application/octet-stream'), 'application/octet-stream');
  });
});

describe('planDelta', () => {
  const f = (gcsPath, modifiedTime, id = gcsPath) =>
    ({ id, name: gcsPath.split('/').pop(), mimeType: 'text/html', modifiedTime, gcsPath });

  it('uploads new files not in the cache', () => {
    const { upload, delete: del, unchanged } = planDelta([f('public/a.html', 't1')], new Map());
    assert.deepEqual(upload.map((x) => x.gcsPath), ['public/a.html']);
    assert.deepEqual(del, []);
    assert.equal(unchanged, 0);
  });

  it('skips files whose modifiedTime is unchanged', () => {
    const cache = new Map([['public/a.html', { fileId: 'a', modifiedTime: 't1' }]]);
    const { upload, unchanged } = planDelta([f('public/a.html', 't1')], cache);
    assert.deepEqual(upload, []);
    assert.equal(unchanged, 1);
  });

  it('re-uploads files whose modifiedTime changed', () => {
    const cache = new Map([['public/a.html', { fileId: 'a', modifiedTime: 't1' }]]);
    const { upload } = planDelta([f('public/a.html', 't2')], cache);
    assert.deepEqual(upload.map((x) => x.gcsPath), ['public/a.html']);
  });

  it('deletes cached paths that no longer exist in Drive', () => {
    const cache = new Map([
      ['public/a.html', { fileId: 'a', modifiedTime: 't1' }],
      ['public/gone.html', { fileId: 'g', modifiedTime: 't1' }],
    ]);
    const { upload, delete: del } = planDelta([f('public/a.html', 't1')], cache);
    assert.deepEqual(upload, []);
    assert.deepEqual(del, ['public/gone.html']);
  });

  it('does not mutate the input cache — the caller performs the I/O + cache update', () => {
    const cache = new Map([['public/gone.html', { fileId: 'g', modifiedTime: 't1' }]]);
    planDelta([f('public/a.html', 't1')], cache);
    assert.ok(cache.has('public/gone.html'), 'planDelta is pure; cache untouched');
  });
});
