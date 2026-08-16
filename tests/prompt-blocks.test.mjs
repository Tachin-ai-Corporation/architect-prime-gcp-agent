// tests/prompt-blocks.test.mjs — pure-core tests for platform/context/prompt-blocks.mjs (B-19)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlocks, toContentParts, computeBreakpointLayout, estimateTokens } from '../platform/context/prompt-blocks.mjs';

const blocks = [
  { label: 'BOOT-STABLE CONTEXT', text: '{"skill_index":[]}', tier: 'boot' },
  { label: 'MISSION CONTEXT', text: '{"envelope":"m-1"}', tier: 'mission' },
  { label: 'WORKING STATE', text: '{"iteration":3}', tier: 'volatile' },
];

describe('renderBlocks / toContentParts byte-consistency', () => {
  it('parts joined with \\n\\n equal the rendered string (cache-key invariant)', () => {
    const parts = toContentParts(blocks);
    assert.equal(parts.map(p => p.text).join('\n\n'), renderBlocks(blocks));
  });

  it('drops empty blocks and tiers', () => {
    const parts = toContentParts([
      { label: 'A', text: '', tier: 'boot' },
      { label: 'B', text: 'body', tier: 'volatile' },
    ]);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].tier, 'volatile');
  });

  it('merges same-tier blocks into one part, ordered boot->mission->volatile', () => {
    const parts = toContentParts([
      { label: 'W', text: 'w', tier: 'volatile' },
      { label: 'B1', text: 'b1', tier: 'boot' },
      { label: 'B2', text: 'b2', tier: 'boot' },
      { label: 'M', text: 'm', tier: 'mission' },
    ]);
    assert.deepEqual(parts.map(p => p.tier), ['boot', 'mission', 'volatile']);
    assert.ok(parts[0].text.includes('b1') && parts[0].text.includes('b2'));
  });

  it('is byte-deterministic: same input, same output', () => {
    assert.equal(renderBlocks(blocks), renderBlocks(blocks.map(b => ({ ...b }))));
  });
});

describe('computeBreakpointLayout', () => {
  it('places breakpoints on boot and mission parts, never the last part', () => {
    const parts = toContentParts(blocks); // boot, mission, volatile
    const bps = computeBreakpointLayout(parts, { systemBreakpointsUsed: 1 });
    assert.deepEqual(bps.map(b => b.index), [0, 1]);
  });

  it('assigns TTL by tier', () => {
    const parts = toContentParts(blocks);
    const bps = computeBreakpointLayout(parts, { ttlStable: '1h', ttlMission: '5m' });
    assert.equal(bps[0].ttl, '1h');
    assert.equal(bps[1].ttl, '5m');
  });

  it('respects the 4-breakpoint provider cap minus system usage', () => {
    const parts = toContentParts(blocks);
    const bps = computeBreakpointLayout(parts, { maxBreakpoints: 4, systemBreakpointsUsed: 3 });
    assert.equal(bps.length, 1); // budget of 1
  });

  it('never emits a breakpoint with zero budget', () => {
    const parts = toContentParts(blocks);
    assert.deepEqual(computeBreakpointLayout(parts, { maxBreakpoints: 1, systemBreakpointsUsed: 1 }), []);
  });

  it('never caches a volatile part even when budget remains', () => {
    const parts = toContentParts([
      { label: 'B', text: 'b', tier: 'boot' },
      { label: 'V1', text: 'v1', tier: 'volatile' },
      { label: 'V2', text: 'v2', tier: 'volatile' },
    ]);
    const bps = computeBreakpointLayout(parts, { systemBreakpointsUsed: 0 });
    assert.deepEqual(bps.map(b => b.index), [0]);
  });

  it('single-part messages get no breakpoints', () => {
    const parts = toContentParts([{ label: 'V', text: 'v', tier: 'volatile' }]);
    assert.deepEqual(computeBreakpointLayout(parts), []);
  });
});

describe('estimateTokens', () => {
  it('chars/4 heuristic', () => {
    assert.equal(estimateTokens('x'.repeat(4096 * 4)), 4096);
    assert.equal(estimateTokens(''), 0);
  });
});
