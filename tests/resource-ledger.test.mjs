// tests/resource-ledger.test.mjs — pure-core tests for corekit/lib/resource-ledger.mjs (B-19)
//
// Fixtures are the ACTUAL shapes observed in mission w-1785077032655-6a93efcf,
// including the escaped-JSON-inside-runCommand_response nesting that real motor
// transcripts contain. If extraction works on these, it works in production.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractResources, mergeResources, renderResources, resourceKey, normalizeName,
} from '../corekit/lib/resource-ledger.mjs';

// A drive-search hit for the folder this mission kept failing to find.
const DRIVE_SEARCH = JSON.stringify({
  files: [{
    id: '1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH',
    name: 'master templates',
    type: 'folder',
    owner: 'someone@example.com',
    modified: '2026-07-01T00:00:00Z',
    link: 'https://drive.google.com/x',
  }],
  count: 1,
}, null, 2);

// An empty result — must yield nothing, not a bogus entry.
const DRIVE_SEARCH_EMPTY = '{"files":[],"count":0}';

// drive-to-doc, the new conversion tool.
const DRIVE_TO_DOC = JSON.stringify({
  status: 'converted',
  docId: '1YfqT9IcpVpPm7wOix_-jPbbzFXUu-_8JE-NPLinnexQ',
  name: 'Sara K Agreement [text]',
  sourceMime: 'application/pdf',
  readWith: 'docs-cat 1YfqT9IcpVpPm7wOix_-jPbbzFXUu-_8JE-NPLinnexQ',
});

// The real transport: JSON escaped inside a runCommand_response wrapper.
const NESTED = '{"runCommand_response": {"result": "{\\"status\\":\\"created\\",\\"id\\":\\"1ozAGMRXzIMytkYwkzf5xBELQwBDqCQOp\\",\\"name\\":\\"In Progress\\",\\"link\\":\\"https://x\\"}"}}';

describe('normalizeName / resourceKey', () => {
  it('collapses case and punctuation so one folder is one entry', () => {
    assert.equal(normalizeName('Master Templates'), 'master templates');
    assert.equal(normalizeName('master-templates'), 'master templates');
    assert.equal(normalizeName('  MASTER   TEMPLATES  '), 'master templates');
    assert.equal(resourceKey('folder', 'Master Templates'), resourceKey('folder', 'master-templates'));
  });

  it('drops a file extension so a doc and its filename agree', () => {
    assert.equal(normalizeName('Agreement_Advisory.pdf'), 'agreement advisory');
  });

  it('keeps genuinely different names apart (aliasing is consolidation\'s job)', () => {
    assert.notEqual(
      resourceKey('folder', 'signed artifacts'),
      resourceKey('folder', 'Executed Advisory Agreements'),
    );
  });
});

describe('extractResources — real tool shapes', () => {
  it('pulls a folder out of a drive-search listing', () => {
    const r = extractResources(DRIVE_SEARCH);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], {
      kind: 'folder',
      name: 'master templates',
      id: '1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH',
    });
  });

  it('returns nothing for an empty result set', () => {
    assert.deepEqual(extractResources(DRIVE_SEARCH_EMPTY), []);
  });

  it('reads a docId from drive-to-doc and types it as a doc', () => {
    const r = extractResources(DRIVE_TO_DOC);
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'doc');
    assert.equal(r[0].id, '1YfqT9IcpVpPm7wOix_-jPbbzFXUu-_8JE-NPLinnexQ');
  });

  it('digs JSON out of an escaped runCommand_response wrapper', () => {
    const r = extractResources(NESTED);
    assert.equal(r.length, 1, 'nested escaped payloads are how results actually arrive');
    assert.equal(r[0].name, 'In Progress');
    assert.equal(r[0].id, '1ozAGMRXzIMytkYwkzf5xBELQwBDqCQOp');
  });

  it('survives a full prose transcript with fenced JSON and finds every id', () => {
    const transcript = `## Step 1: Find the folders

### Action Taken
I searched Drive.

\`\`\`json
${DRIVE_SEARCH}
\`\`\`

Then I converted the contract:
${DRIVE_TO_DOC}

### Status
SUCCESS`;
    const r = extractResources(transcript);
    const ids = r.map(x => x.id).sort();
    assert.deepEqual(ids, [
      '1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH',
      '1YfqT9IcpVpPm7wOix_-jPbbzFXUu-_8JE-NPLinnexQ',
    ].sort());
  });

  it('ignores short/garbage ids and unnamed objects', () => {
    assert.deepEqual(extractResources('{"id":"abc","name":"too short"}'), []);
    assert.deepEqual(extractResources('{"id":"1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH"}'), [],
      'an id with no name cannot be recalled by name — worthless to the ledger');
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', null, undefined, '{{{', '{"a":', 'plain prose', '[]']) {
      assert.deepEqual(extractResources(bad), []);
    }
  });

  it('de-duplicates repeated mentions of the same resource', () => {
    assert.equal(extractResources(`${DRIVE_SEARCH}\n${DRIVE_SEARCH}`).length, 1);
  });
});

describe('mergeResources', () => {
  const found = extractResources(DRIVE_SEARCH);

  it('adds a new entry', () => {
    const { ledger, added } = mergeResources({}, found, { now: 'T0' });
    assert.equal(added, 1);
    assert.equal(ledger['folder:master templates'].id, '1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH');
    assert.equal(ledger['folder:master templates'].first_seen, 'T0');
  });

  it('is idempotent — merging the same batch twice changes nothing', () => {
    const one = mergeResources({}, found, { now: 'T0' });
    const two = mergeResources(one.ledger, found, { now: 'T1' });
    assert.equal(two.added, 0);
    assert.equal(two.updated, 0);
    assert.deepEqual(two.ledger, one.ledger);
  });

  it('updates in place when the id changes, remembering the old one', () => {
    const one = mergeResources({}, found, { now: 'T0' });
    const moved = [{ kind: 'folder', name: 'master templates', id: '9NEWID_NEWID_NEWID_NEWID' }];
    const two = mergeResources(one.ledger, moved, { now: 'T2' });
    assert.equal(two.updated, 1);
    const e = two.ledger['folder:master templates'];
    assert.equal(e.id, '9NEWID_NEWID_NEWID_NEWID');
    assert.equal(e.previous_id, '1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH',
      'a dead id must be visible, not silently overwritten');
    assert.equal(e.updated_at, 'T2');
  });

  it('is order-independent', () => {
    const a = [{ kind: 'folder', name: 'A', id: 'AAAAAAAAAAAA' }, { kind: 'doc', name: 'B', id: 'BBBBBBBBBBBB' }];
    const l1 = mergeResources({}, a, { now: 'T' }).ledger;
    const l2 = mergeResources({}, [...a].reverse(), { now: 'T' }).ledger;
    assert.deepEqual(l1, l2);
  });

  it('enforces the cap and reports what it dropped', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'folder', name: `f${i}`, id: `IDIDIDIDIDID${i}` }));
    const { ledger, added, dropped } = mergeResources({}, many, { now: 'T', max: 3 });
    assert.equal(Object.keys(ledger).length, 3);
    assert.equal(added, 3);
    assert.equal(dropped, 2, 'silent truncation would make the ledger quietly wrong');
  });

  it('tolerates junk entries without corrupting the ledger', () => {
    const { ledger } = mergeResources({}, [null, {}, { name: 'x' }, { id: 'y' }], { now: 'T' });
    assert.deepEqual(ledger, {});
  });
});

describe('renderResources', () => {
  it('renders one line per resource with the id intact', () => {
    const { ledger } = mergeResources({}, extractResources(DRIVE_SEARCH), { now: 'T' });
    const out = renderResources(ledger);
    assert.match(out, /Known Resources/);
    assert.match(out, /do NOT search for these again/);
    assert.match(out, /folder: "master templates" = 1OgWUOx-TPxhryVxn0TeJnDQUjUCiMOdH/);
  });

  it('returns empty string for an empty ledger (no dead block in the prompt)', () => {
    assert.equal(renderResources({}), '');
    assert.equal(renderResources(null), '');
  });

  it('sorts cue matches first but keeps everything else', () => {
    const rows = [
      { kind: 'folder', name: 'unrelated stuff', id: 'ZZZZZZZZZZZZ' },
      { kind: 'folder', name: 'signed artifacts', id: 'SSSSSSSSSSSS' },
    ];
    const { ledger } = mergeResources({}, rows, { now: 'T' });
    const out = renderResources(ledger, { cues: ['signed'] });
    const lines = out.split('\n').filter(l => l.startsWith('- '));
    assert.match(lines[0], /signed artifacts/);
    assert.equal(lines.length, 2, 'a near-miss cue must not hide the rest of the ledger');
  });

  it('flags truncation when over the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'doc', name: `d${i}`, id: `IDIDIDIDIDID${i}` }));
    const { ledger } = mergeResources({}, many, { now: 'T' });
    assert.match(renderResources(ledger, { limit: 2 }), /…4 more/);
  });
});
