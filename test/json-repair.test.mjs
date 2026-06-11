// test/json-repair.test.mjs — Unit tests for corekit/lib/json-repair.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsonResponse,
  repairTruncatedJson,
  extractBalancedJson,
} from '../corekit/lib/json-repair.mjs';

// ── parseJsonResponse ───────────────────────────────────────────────

describe('parseJsonResponse', () => {
  it('parses clean JSON', () => {
    const result = parseJsonResponse('{"action":"synthesize","reason":"done"}');
    assert.deepStrictEqual(result, { action: 'synthesize', reason: 'done' });
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"action":"test"}\n```';
    const result = parseJsonResponse(raw);
    assert.deepStrictEqual(result, { action: 'test' });
  });

  it('strips legacy Action: blocks', () => {
    const raw = '{"action":"checkpoint_plan"}\nAction: do stuff';
    const result = parseJsonResponse(raw);
    assert.deepStrictEqual(result, { action: 'checkpoint_plan' });
  });

  it('returns error object for garbage input', () => {
    const result = parseJsonResponse('not json at all');
    assert.equal(result.error, 'parse_failed');
  });

  it('returns error object for empty/whitespace input', () => {
    const result = parseJsonResponse('');
    assert.equal(result.error, 'parse_failed');
  });
});

// ── extractBalancedJson ─────────────────────────────────────────────

describe('extractBalancedJson', () => {
  it('extracts first balanced JSON from surrounding text', () => {
    const result = extractBalancedJson('prefix {"a":1} suffix');
    assert.equal(result, '{"a":1}');
  });

  it('handles nested objects', () => {
    const result = extractBalancedJson('{"a":{"b":2}}');
    assert.equal(result, '{"a":{"b":2}}');
  });

  it('handles strings containing braces', () => {
    const result = extractBalancedJson('{"a":"hello {world}"}');
    assert.equal(result, '{"a":"hello {world}"}');
  });

  it('returns null when no JSON is present', () => {
    const result = extractBalancedJson('no braces here');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = extractBalancedJson('');
    assert.equal(result, null);
  });
});

// ── repairTruncatedJson ─────────────────────────────────────────────

describe('repairTruncatedJson', () => {
  it('returns null for short input (< 10 chars)', () => {
    const result = repairTruncatedJson('{}');
    assert.equal(result, null);
  });

  it('returns null for already-balanced JSON', () => {
    const result = repairTruncatedJson('{"action":"test"}');
    assert.equal(result, null);
  });

  it('repairs truncated JSON with unclosed brace and action field', () => {
    const result = repairTruncatedJson(
      '{"action":"synthesize","data":{"key":"val'
    );
    assert.notEqual(result, null, 'repair should return an object, not null');
    assert.equal(typeof result, 'object');
    assert.ok(result.action, 'repaired object should have an action property');
  });

  it('returns null when there is no opening brace', () => {
    const result = repairTruncatedJson('just text');
    assert.equal(result, null);
  });
});
