// tests/prompt-blocks.test.mjs — pure-core tests for platform/context/prompt-blocks.mjs (B-19)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderBlocks, toContentParts, computeBreakpointLayout, estimateTokens, apiContentBlock, isTextOnly } from '../platform/context/prompt-blocks.mjs';

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

// The step after any Claude tool call: the assistant turn carries [text, tool_use] and the
// next user turn [tool_result]. Rebuilding those as text parts sent
// `messages.1.content.1 = {type:'text'}` with no text, and the provider 400'd every
// strong-tier tool turn into a whole-turn Flash fallback (live, 2026-10-17).
describe('apiContentBlock — what reaches the Anthropic API', () => {
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'readFile', input: { path: '/x' } };
  const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' };

  it('passes tool_use and tool_result blocks through unchanged', () => {
    assert.equal(apiContentBlock(toolUse), toolUse);
    assert.equal(apiContentBlock(toolResult), toolResult);
  });

  it('strips the tier hint from a text part and keeps its text', () => {
    assert.deepEqual(apiContentBlock({ type: 'text', text: 'hi', tier: 'boot' }), { type: 'text', text: 'hi' });
    assert.deepEqual(apiContentBlock({ text: 'hi', tier: 'mission' }), { type: 'text', text: 'hi' });
  });

  it('an assistant tool turn keeps every block its own payload', () => {
    const out = [{ type: 'text', text: 'Reading both files.' }, toolUse].map(apiContentBlock);
    assert.deepEqual(out, [{ type: 'text', text: 'Reading both files.' }, toolUse]);
    for (const b of out) if (b.type === 'text') assert.equal(typeof b.text, 'string');
  });

  it('isTextOnly tells the daemon payload from a tool_result turn', () => {
    assert.equal(isTextOnly([{ type: 'text', text: 'a', tier: 'boot' }, { type: 'text', text: 'b' }]), true);
    assert.equal(isTextOnly([toolResult]), false);
    assert.equal(isTextOnly([{ type: 'text', text: 'a' }, toolUse]), false);
    assert.equal(isTextOnly('a string turn'), false);
  });

  it('the gateway shapes every array-content block through it', () => {
    const loop = readFileSync(new URL('../corekit/brain/loop.mjs', import.meta.url), 'utf8');
    const body = name => loop.slice(loop.indexOf(`function ${name}(`), loop.indexOf('\n}\n', loop.indexOf(`function ${name}(`)));
    for (const fn of ['applyMessageBreakpoints', 'applySessionBoundaryBreakpoint']) {
      assert.match(body(fn), /\.map\(apiContentBlock\)/, `${fn} must keep tool blocks intact`);
      assert.doesNotMatch(body(fn), /map\(p => \(\{ type: 'text', text: p\.text \}\)\)/, `${fn} rebuilds every block as text`);
    }
    assert.match(body('applyMessageBreakpoints'), /isTextOnly\(m\.content\)/, 'the tier layout targets the daemon payload, not a tool_result turn');
  });
});
