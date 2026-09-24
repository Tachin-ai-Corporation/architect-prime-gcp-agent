// test/scheduler-cron.test.mjs — Unit tests for cron helpers in platform/work/scheduler.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatch, fieldMatches, cronNextFire } from '../platform/work/scheduler.mjs';

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

  // The horizon was 48h, shorter than a week: right after a weekly slot the next
  // one was "not found", and the tick loop treated that as never. r-weekly-exec-update
  // fired on 2026-09-17 and was dormant on 2026-09-24.
  it('finds the next WEEKLY slot from right after the previous one', () => {
    const next = cronNextFire('30 15 * * 4', 'UTC', new Date('2026-09-17T15:30:00Z'));
    assert.equal(next?.toISOString(), '2026-09-24T15:30:00.000Z');
  });

  it('scans from the given instant, starting at the next minute', () => {
    const next = cronNextFire('* * * * *', 'UTC', new Date('2026-09-24T10:00:30Z'));
    assert.equal(next?.toISOString(), '2026-09-24T10:01:00.000Z');
  });

  it('still returns null past the horizon (a monthly slot 30 days out)', () => {
    assert.equal(cronNextFire('0 9 1 * *', 'UTC', new Date('2026-09-01T09:00:00Z')), null);
  });

  it('a zoned weekly slot lands on the right UTC instant on both sides of DST', () => {
    // 10:15 Central: CDT (UTC-5) until 2026-11-01, CST (UTC-6) after.
    assert.equal(
      cronNextFire('15 10 * * 4', 'America/Chicago', new Date('2026-09-24T16:00:00Z'))?.toISOString(),
      '2026-10-01T15:15:00.000Z');
    assert.equal(
      cronNextFire('15 10 * * 4', 'America/Chicago', new Date('2026-10-29T16:00:00Z'))?.toISOString(),
      '2026-11-05T16:15:00.000Z');
  });
});

// ── timezone ────────────────────────────────────────────────────────

describe('cronMatch — timezone', () => {
  it('matches the declared local time in CDT (UTC-5)', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T15:15:00Z'), 'America/Chicago'), true);
  });

  it('keeps the local time across the DST change (CST, UTC-6)', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-11-05T16:15:00Z'), 'America/Chicago'), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-11-05T15:15:00Z'), 'America/Chicago'), false,
      'a UTC-baked schedule would have fired here — an hour early — once DST ended');
  });

  it('reads the day of week in the zone, not in UTC', () => {
    // 02:00Z on the 25th is Friday in UTC, still Thursday 21:00 in Chicago.
    assert.equal(cronMatch('0 21 * * 4', new Date('2026-09-25T02:00:00Z'), 'America/Chicago'), true);
    assert.equal(cronMatch('0 21 * * 4', new Date('2026-09-25T02:00:00Z')), false);
  });

  it('with no zone (or UTC) the expression is UTC, exactly as before', () => {
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T10:15:00Z')), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T10:15:00Z'), 'UTC'), true);
    assert.equal(cronMatch('15 10 * * 4', new Date('2026-09-24T15:15:00Z')), false);
  });

  it('an unknown zone throws rather than guessing', () => {
    assert.throws(() => cronMatch('* * * * *', new Date(), 'Mars/Olympus_Mons'), RangeError);
  });
});
