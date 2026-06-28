import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDelegationMarker,
  isDelegationResultMarker,
  composeDelegationMarker,
  composeDelegationResultMarker,
  parseDelegationMarker,
  parseDelegationResultMarker,
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
