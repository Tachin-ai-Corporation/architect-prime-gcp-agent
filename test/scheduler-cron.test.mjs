// test/scheduler-cron.test.mjs — Unit tests for cron helpers in corekit/lib/scheduler.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatch, fieldMatches, cronNextFire } from '../corekit/lib/scheduler.mjs';

// ── fieldMatches ────────────────────────────────────────────────────

describe('fieldMatches', () => {
  // Wildcard
  it('wildcard matches any value', () => {
    assert.equal(fieldMatches('*', 5, 0, 59), true);
  });

  it('wildcard matches zero', () => {
    assert.equal(fieldMatches('*', 0, 0, 59), true);
  });

  // Step (*/N)
  it('step */5 matches 0', () => {
    assert.equal(fieldMatches('*/5', 0, 0, 59), true);
  });

  it('step */5 matches 5', () => {
    assert.equal(fieldMatches('*/5', 5, 0, 59), true);
  });

  it('step */5 does not match 3', () => {
    assert.equal(fieldMatches('*/5', 3, 0, 59), false);
  });

  it('step */15 matches 30', () => {
    assert.equal(fieldMatches('*/15', 30, 0, 59), true);
  });

  it('step */15 does not match 7', () => {
    assert.equal(fieldMatches('*/15', 7, 0, 59), false);
  });

  // Exact value
  it('exact value matches', () => {
    assert.equal(fieldMatches('5', 5, 0, 59), true);
  });

  it('exact value does not match different number', () => {
    assert.equal(fieldMatches('5', 6, 0, 59), false);
  });

  // Comma-separated
  it('comma list matches a listed value', () => {
    assert.equal(fieldMatches('1,5,10', 5, 0, 59), true);
  });

  it('comma list does not match an unlisted value', () => {
    assert.equal(fieldMatches('1,5,10', 3, 0, 59), false);
  });

  // Range
  it('range matches value within bounds', () => {
    assert.equal(fieldMatches('1-5', 3, 0, 59), true);
  });

  it('range does not match value outside bounds', () => {
    assert.equal(fieldMatches('1-5', 6, 0, 59), false);
  });

  it('range is inclusive of lower bound', () => {
    assert.equal(fieldMatches('1-5', 1, 0, 59), true);
  });

  it('range is inclusive of upper bound', () => {
    assert.equal(fieldMatches('1-5', 5, 0, 59), true);
  });
});

// ── cronMatch ───────────────────────────────────────────────────────

describe('cronMatch', () => {
  it('every-minute expression matches any date', () => {
    assert.equal(cronMatch('* * * * *', new Date('2026-01-15T08:30:00Z')), true);
  });

  it('specific minute+hour matches correct time', () => {
    assert.equal(cronMatch('30 8 * * *', new Date('2026-01-15T08:30:00Z')), true);
  });

  it('wrong minute does not match', () => {
    assert.equal(cronMatch('0 8 * * *', new Date('2026-01-15T08:30:00Z')), false);
  });

  it('midnight daily matches 00:00 UTC', () => {
    assert.equal(cronMatch('0 0 * * *', new Date('2026-06-11T00:00:00Z')), true);
  });

  it('Feb 31 never matches any February date', () => {
    assert.equal(cronMatch('0 0 31 2 *', new Date('2026-02-15T00:00:00Z')), false);
  });

  it('every 5 minutes matches a multiple-of-5 minute', () => {
    assert.equal(cronMatch('*/5 * * * *', new Date('2026-01-15T08:15:00Z')), true);
  });

  it('every 5 minutes does not match a non-multiple', () => {
    assert.equal(cronMatch('*/5 * * * *', new Date('2026-01-15T08:13:00Z')), false);
  });
});

// ── cronNextFire ────────────────────────────────────────────────────

describe('cronNextFire', () => {
  it('returns a Date for a valid every-minute expression', () => {
    const result = cronNextFire('* * * * *');
    assert.ok(result instanceof Date, 'expected a Date instance');
  });

  it('returns null for an impossible expression (Feb 31)', () => {
    const result = cronNextFire('0 0 31 2 *');
    assert.equal(result, null);
  });
});
