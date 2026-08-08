import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDelegationMarker,
  isDelegationResultMarker,
  composeDelegationMarker,
  composeDelegationResultMarker,
  parseDelegationMarker,
  parseDelegationResultMarker,
  bumpRedelegation,
  redelegationKey,
  composeRedelegationEscalation,
} from '../corekit/lib/delegation.mjs';

// ---- isDelegationMarker ----

describe('isDelegationMarker', () => {
  it('detects valid marker', () => {
    assert.equal(
      isDelegationMarker('@agent [DELEGATION ref:w-123 from:arch@domain proj:proj-1]\nDo stuff'),
      true,
    );
  });

  it('rejects no marker', () => {
    assert.equal(isDelegationMarker('just a normal message'), false);
  });

  it('rejects null', () => {
    assert.equal(isDelegationMarker(null), false);
  });

  it('rejects empty', () => {
    assert.equal(isDelegationMarker(''), false);
  });

  it('rejects partial (missing fields)', () => {
    assert.equal(isDelegationMarker('[DELEGATION ref:w-123]'), false);
  });

  it('rejects result marker', () => {
    assert.equal(
      isDelegationMarker('[DELEGATION-RESULT ref:w-123 status:complete mission:w-456]'),
      false,
    );
  });
});

// ---- isDelegationResultMarker ----

describe('isDelegationResultMarker', () => {
  it('detects valid result', () => {
    assert.equal(
      isDelegationResultMarker(
        '@arch [DELEGATION-RESULT ref:w-123 status:complete mission:w-456]\nDone',
      ),
      true,
    );
  });

  it('rejects no marker', () => {
    assert.equal(isDelegationResultMarker('normal message'), false);
  });

  it('rejects null', () => {
    assert.equal(isDelegationResultMarker(null), false);
  });

  it('rejects delegation marker (not result)', () => {
    assert.equal(
      isDelegationResultMarker('[DELEGATION ref:w-123 from:a@b proj:p]'),
      false,
    );
  });
});

// ---- composeDelegationMarker ----

describe('composeDelegationMarker', () => {
  it('composes with all fields', () => {
    const msg = composeDelegationMarker({
      targetEmail: 'eng@domain',
      ref: 'w-123-abc',
      from: 'arch@domain',
      project: 'proj-1',
      body: 'Implement the thing',
    });
    assert.ok(msg.startsWith('@eng@domain'));
    assert.ok(msg.includes('[DELEGATION ref:w-123-abc from:arch@domain proj:proj-1]'));
    assert.ok(msg.includes('Implement the thing'));
  });

  it('composes without targetEmail', () => {
    const msg = composeDelegationMarker({
      ref: 'w-123',
      from: 'a@b',
      project: 'p',
      body: 'Do it',
    });
    assert.ok(msg.startsWith('[DELEGATION'));
  });

  it('composes without body', () => {
    const msg = composeDelegationMarker({
      targetEmail: 'e@d',
      ref: 'w-1',
      from: 'a@d',
      project: 'p',
    });
    assert.ok(!msg.endsWith('\n'), 'should not end with newline');
  });
});

// ---- composeDelegationResultMarker ----

describe('composeDelegationResultMarker', () => {
  it('composes result', () => {
    const msg = composeDelegationResultMarker({
      targetEmail: 'arch@domain',
      ref: 'w-123',
      status: 'complete',
      missionId: 'w-456-def',
      body: 'PR #41 merged',
    });
    assert.ok(msg.includes('[DELEGATION-RESULT ref:w-123 status:complete mission:w-456-def]'));
    assert.ok(msg.includes('PR #41 merged'));
  });

  it('composes failed', () => {
    const msg = composeDelegationResultMarker({
      ref: 'w-123',
      status: 'failed',
      missionId: 'w-789',
      body: 'Build failed',
    });
    assert.ok(msg.includes('status:failed'));
  });
});

// ---- parseDelegationMarker ----

describe('parseDelegationMarker', () => {
  it('parses valid marker', () => {
    const result = parseDelegationMarker(
      '@eng [DELEGATION ref:w-123-abc from:arch@domain.com proj:proj-self-improvement]\nImplement manifest-dedup refactor.',
    );
    assert.deepEqual(result, {
      ref: 'w-123-abc',
      from: 'arch@domain.com',
      project: 'proj-self-improvement',
      drive: null,
      criteria: null,
      body: 'Implement manifest-dedup refactor.',
    });
  });

  it('parses multi-line body', () => {
    const result = parseDelegationMarker(
      '@eng [DELEGATION ref:w-1 from:a@b proj:p]\nLine one\nLine two\nLine three',
    );
    assert.ok(result);
    assert.ok(result.body.includes('Line one'));
    assert.ok(result.body.includes('Line two'));
    assert.ok(result.body.includes('Line three'));
  });

  it('returns null for garbage', () => {
    assert.equal(parseDelegationMarker('hello world'), null);
  });

  it('returns null for null', () => {
    assert.equal(parseDelegationMarker(null), null);
  });

  it('returns null for empty', () => {
    assert.equal(parseDelegationMarker(''), null);
  });
});

// ---- parseDelegationResultMarker ----

describe('parseDelegationResultMarker', () => {
  it('parses valid result', () => {
    const result = parseDelegationResultMarker(
      '@arch [DELEGATION-RESULT ref:w-123 status:complete mission:w-456-abc]\nPR #41 open',
    );
    assert.deepEqual(result, {
      ref: 'w-123',
      status: 'complete',
      missionId: 'w-456-abc',
      body: 'PR #41 open',
    });
  });

  it('parses failed status', () => {
    const result = parseDelegationResultMarker(
      '@arch [DELEGATION-RESULT ref:w-10 status:failed mission:w-99]\nTimeout',
    );
    assert.ok(result);
    assert.equal(result.status, 'failed');
  });

  it('returns null for garbage', () => {
    assert.equal(parseDelegationResultMarker('not a marker'), null);
  });

  it('returns null for null', () => {
    assert.equal(parseDelegationResultMarker(null), null);
  });
});

// ---- Round-trip ----

describe('round-trip compose → parse', () => {
  it('delegation round-trip', () => {
    const opts = {
      targetEmail: 'eng@domain.com',
      ref: 'w-trip-001',
      from: 'arch@domain.com',
      project: 'proj-roundtrip',
      body: 'Build the widget',
    };
    const composed = composeDelegationMarker(opts);
    const parsed = parseDelegationMarker(composed);
    assert.ok(parsed);
    assert.equal(parsed.ref, opts.ref);
    assert.equal(parsed.from, opts.from);
    assert.equal(parsed.project, opts.project);
    assert.equal(parsed.body, opts.body);
  });

  it('result round-trip', () => {
    const opts = {
      targetEmail: 'arch@domain.com',
      ref: 'w-trip-002',
      status: 'complete',
      missionId: 'w-mission-99',
      body: 'Widget built successfully',
    };
    const composed = composeDelegationResultMarker(opts);
    const parsed = parseDelegationResultMarker(composed);
    assert.ok(parsed);
    assert.equal(parsed.ref, opts.ref);
    assert.equal(parsed.status, opts.status);
    assert.equal(parsed.missionId, opts.missionId);
    assert.equal(parsed.body, opts.body);
  });
});

// ---- Re-delegation cap (FC-B) ----

describe('redelegationKey', () => {
  it('keys on the checkpoint OUTCOME so re-plans bump the same counter', () => {
    // Each re-plan mints a fresh checkpoint id but keeps the pinned outcome/title.
    const a = redelegationKey({ id: 'w-c-1', title: 'Delegate to the designer (Dot) for review of the HTML draft.' });
    const b = redelegationKey({ id: 'w-c-2-different-id', title: 'Delegate to the designer (Dot) for review of the HTML draft.' });
    assert.equal(a, b, 'same outcome → same key across re-delegations');
    assert.ok(a.startsWith('cp:'));
  });
  it('normalizes whitespace/case and falls back to id only when there is no outcome text', () => {
    assert.equal(redelegationKey({ title: '  Review   THE Draft ' }), redelegationKey({ instruction: 'review the draft' }));
    assert.equal(redelegationKey({ id: 'w-x' }), 'cp:w-x', 'id used as outcome text when title/instruction absent');
    assert.equal(redelegationKey({}), 'id:unknown', 'truly-empty → id: fallback');
  });
});

describe('bumpRedelegation', () => {
  it('does not exceed within the cap, exceeds past it (cap=2 → 3rd round escalates)', () => {
    let counters;
    const k = 'cp:review';
    let r = bumpRedelegation(counters, k, 2); assert.deepEqual([r.attempts, r.exceeded], [1, false]);
    r = bumpRedelegation(r.counters, k, 2);   assert.deepEqual([r.attempts, r.exceeded], [2, false]);
    r = bumpRedelegation(r.counters, k, 2);   assert.deepEqual([r.attempts, r.exceeded], [3, true]);
  });
  it('counts each checkpoint independently and never mutates the input', () => {
    const c0 = { 'cp:a': 2 };
    const r = bumpRedelegation(c0, 'cp:b', 2);
    assert.equal(r.counters['cp:a'], 2, 'other checkpoint untouched');
    assert.equal(r.counters['cp:b'], 1);
    assert.equal(c0['cp:b'], undefined, 'input not mutated');
  });
});

describe('composeRedelegationEscalation', () => {
  it('names the stuck checkpoint, the delegate, and the reason — an honest ask, not a false green', () => {
    const msg = composeRedelegationEscalation({
      goal: 'Deploy the 1health site to staging and report the URL',
      checkpointOutcome: 'Delegate to the designer (Dot) for review of the HTML draft',
      agentLabel: 'designer-agent-dot@example.com',
      reason: '[FAILED] the input branch was empty',
      attempts: 3,
    });
    assert.match(msg, /Stuck on:.*review of the HTML draft/);
    assert.match(msg, /designer-agent-dot@example\.com/);
    assert.match(msg, /input branch was empty/);
    assert.match(msg, /1health site to staging/);
    assert.match(msg, /loop/i, 'explains why it stopped rather than retrying');
  });
});
