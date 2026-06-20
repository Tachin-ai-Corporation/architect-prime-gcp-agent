// tests/work-recall.test.mjs — Unit tests for episodic retrieval module
//
// Run: node --test tests/work-recall.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractCues, scoreRelevance, searchWork, recentWorkDigest } from '../corekit/lib/work-recall.mjs';

// ── helpers ─────────────────────────────────────────────────────────

function makeEnvelope(overrides = {}) {
  return {
    id: 'env-001',
    type: 'M',
    status: 'complete',
    owner: 'bot@test.com',
    title: 'Deploy the analytics service',
    instruction: 'Run the deploy script for analytics',
    output: 'Deployment succeeded on us-central1',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

function mockFirestoreQuery(docs) {
  return async (_collection, _filters) => docs;
}

// ── extractCues ─────────────────────────────────────────────────────

describe('extractCues', () => {
  it('removes stopwords', () => {
    const cues = extractCues('the quick brown fox and the lazy dog');
    assert.ok(!cues.includes('the'), 'should drop "the"');
    assert.ok(!cues.includes('and'), 'should drop "and"');
  });

  it('removes tokens shorter than 3 chars', () => {
    const cues = extractCues('go to my big car');
    assert.ok(!cues.includes('go'), 'should drop "go" (2 chars)');
    assert.ok(!cues.includes('to'), 'should drop "to" (2 chars)');
    assert.ok(!cues.includes('my'), 'should drop "my" (2 chars)');
  });

  it('includes bigrams from adjacent tokens', () => {
    const cues = extractCues('deploy analytics service');
    assert.ok(cues.includes('deploy'), 'should include unigram');
    assert.ok(cues.includes('analytics'), 'should include unigram');
    assert.ok(cues.includes('deploy analytics'), 'should include bigram');
  });

  it('caps at MAX_CUES (8)', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike';
    const cues = extractCues(text);
    assert.ok(cues.length <= 8, `expected <= 8 cues, got ${cues.length}`);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(extractCues(''), []);
    assert.deepStrictEqual(extractCues(null), []);
    assert.deepStrictEqual(extractCues(undefined), []);
  });
});

// ── scoreRelevance ──────────────────────────────────────────────────

describe('scoreRelevance', () => {
  it('scores higher with more term overlap', () => {
    const cues = ['deploy', 'analytics', 'service'];
    const high = scoreRelevance(makeEnvelope({ title: 'Deploy the analytics service' }), cues);
    const low = scoreRelevance(makeEnvelope({ title: 'Unrelated task about nothing' }), cues);
    assert.ok(high > low, `high (${high}) should exceed low (${low})`);
  });

  it('recency modulates score', () => {
    const cues = ['deploy', 'analytics'];
    const recent = scoreRelevance(makeEnvelope({ created_at: new Date().toISOString() }), cues);
    const old = scoreRelevance(makeEnvelope({ created_at: new Date(Date.now() - 90 * 86400000).toISOString() }), cues);
    assert.ok(recent > old, `recent (${recent}) should exceed old (${old})`);
  });

  it('returns 0 for empty cues', () => {
    assert.strictEqual(scoreRelevance(makeEnvelope(), []), 0);
  });

  it('applies status weights', () => {
    const cues = ['deploy', 'analytics'];
    const complete = scoreRelevance(makeEnvelope({ status: 'complete' }), cues);
    const blocked = scoreRelevance(makeEnvelope({ status: 'blocked' }), cues);
    const other = scoreRelevance(makeEnvelope({ status: 'pending' }), cues);
    assert.ok(complete > blocked, 'complete > blocked');
    assert.ok(blocked > other, 'blocked > other');
  });

  it('applies type weights', () => {
    const cues = ['deploy', 'analytics'];
    const mission = scoreRelevance(makeEnvelope({ type: 'M' }), cues);
    const responsibility = scoreRelevance(makeEnvelope({ type: 'R' }), cues);
    const checkpoint = scoreRelevance(makeEnvelope({ type: 'C' }), cues);
    const other = scoreRelevance(makeEnvelope({ type: 'X' }), cues);
    assert.ok(mission > responsibility, 'M > R');
    assert.ok(responsibility > checkpoint, 'R > C');
    assert.ok(checkpoint > other, 'C > other');
  });
});

// ── searchWork ──────────────────────────────────────────────────────

describe('searchWork', () => {
  const docs = [
    makeEnvelope({ id: 'e1', title: 'Deploy analytics service', output: 'Deployed successfully' }),
    makeEnvelope({ id: 'e2', title: 'Update billing dashboard', output: 'Dashboard updated' }),
    makeEnvelope({ id: 'e3', title: 'Fix login bug', output: 'Bug fixed in auth module' }),
    makeEnvelope({
      id: 'e4', title: 'Deploy old service',
      created_at: new Date(Date.now() - 60 * 86400000).toISOString(),
    }),
  ];

  it('returns scored and ranked results', async () => {
    const hits = await searchWork({
      firestoreQuery: mockFirestoreQuery(docs),
      owner: 'bot@test.com',
      cues: ['deploy', 'analytics', 'service'],
      sinceDays: 30,
    });
    assert.ok(hits.length > 0, 'should return hits');
    assert.ok(hits[0].score >= hits[hits.length - 1].score, 'should be sorted descending by score');
  });

  it('filters out envelopes outside the time window', async () => {
    const hits = await searchWork({
      firestoreQuery: mockFirestoreQuery(docs),
      owner: 'bot@test.com',
      cues: ['deploy', 'service'],
      sinceDays: 30,
    });
    const ids = hits.map(h => h.id);
    assert.ok(!ids.includes('e4'), 'should exclude envelope older than sinceDays');
  });

  it('drops results below RELEVANCE_FLOOR', async () => {
    const hits = await searchWork({
      firestoreQuery: mockFirestoreQuery(docs),
      owner: 'bot@test.com',
      cues: ['xylophone', 'platypus', 'quasar'],
      sinceDays: 30,
    });
    assert.strictEqual(hits.length, 0, 'no hits should match irrelevant cues');
  });

  it('output format includes expected fields', async () => {
    const hits = await searchWork({
      firestoreQuery: mockFirestoreQuery(docs),
      owner: 'bot@test.com',
      cues: ['deploy', 'analytics'],
      sinceDays: 30,
    });
    if (hits.length > 0) {
      const h = hits[0];
      assert.ok('id' in h, 'has id');
      assert.ok('type' in h, 'has type');
      assert.ok('title' in h, 'has title');
      assert.ok('instruction_blurb' in h, 'has instruction_blurb');
      assert.ok('output_blurb' in h, 'has output_blurb');
      assert.ok('score' in h, 'has score');
      assert.ok('matched_cues' in h, 'has matched_cues');
      assert.ok(h.instruction_blurb.length <= 200, 'instruction_blurb <= 200 chars');
      assert.ok(h.output_blurb.length <= 200, 'output_blurb <= 200 chars');
    }
  });
});

// ── recentWorkDigest ────────────────────────────────────────────────

describe('recentWorkDigest', () => {
  it('groups completed work by day', async () => {
    const now = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const docs = [
      makeEnvelope({ id: 'd1', title: 'Task A', completed_at: now.toISOString() }),
      makeEnvelope({ id: 'd2', title: 'Task B', completed_at: now.toISOString() }),
      makeEnvelope({ id: 'd3', title: 'Task C', completed_at: yesterday.toISOString() }),
    ];
    const digest = await recentWorkDigest({
      firestoreQuery: mockFirestoreQuery(docs),
      owner: 'bot@test.com',
      sinceDays: 7,
    });
    assert.ok(digest.includes('## Work Completed'), 'should have header');
    assert.ok(digest.includes('###'), 'should have day headers');
    assert.ok(digest.includes('Task A'), 'should include Task A');
    assert.ok(digest.includes('Task C'), 'should include Task C');
  });

  it('handles empty results gracefully', async () => {
    const digest = await recentWorkDigest({
      firestoreQuery: mockFirestoreQuery([]),
      owner: 'bot@test.com',
      sinceDays: 7,
    });
    assert.ok(digest.includes('No completed work found'), 'should say no work found');
  });
});
