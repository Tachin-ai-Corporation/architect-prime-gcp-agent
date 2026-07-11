// corekit/lib/prompt-blocks.mjs — stable-first prompt block assembly (SESSION_CONTEXT_PLAN Phase 2)
//
// Pure functions only (B-19): no I/O, no clock, no GCP.
//
// A "block" is { label, text, tier } where tier is one of:
//   'boot'    — stable for the gateway-process lifetime (skill index, guidance)
//   'mission' — stable for one mission's lifetime (envelope statics, project, memory)
//   'volatile'— changes every call (iteration, working state, prior results)
//
// The daemon assembles blocks most-stable-first; the gateway turns them into
// provider requests: OpenAI content-parts for Anthropic (cache_control on
// part boundaries, longer TTLs strictly earlier per the API contract), one
// concatenated string for Gemini (implicit caching rewards the same byte
// order for free). Rendering is byte-deterministic: same blocks in, same
// bytes out — that property IS the cache key (B-17: a cached prefix can
// never serve stale content because the prefix is the content).
//
// Provider caching floors (live-verified 2026-07-11): claude-opus-4-6 caches
// only prefixes over ~4,096 tokens; gemini-2.5 over ~2,048. Sub-floor blocks
// are silently uncached — estimateTokens() feeds the telemetry that makes
// those misses explainable.

const TIERS = ['boot', 'mission', 'volatile'];

/** chars/4 heuristic — used for floor/threshold telemetry, never billing. */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/** Render one block as a labeled section. */
function renderBlock(b) {
  const label = (b.label || '').trim();
  return label ? `[${label}]\n${b.text}` : b.text;
}

/**
 * Render blocks to a single string — the Gemini / legacy transport shape.
 * @param {Array<{label?: string, text: string, tier?: string}>} blocks
 */
export function renderBlocks(blocks) {
  return blocks
    .filter(b => b && typeof b.text === 'string' && b.text.length > 0)
    .map(renderBlock)
    .join('\n\n');
}

/**
 * Merge blocks into at most one content part per tier, ordered
 * boot → mission → volatile. Empty tiers are dropped. The same bytes that
 * renderBlocks() produces, split at tier boundaries — concatenating the
 * returned parts with '\n\n' equals renderBlocks(blocks).
 *
 * @returns {Array<{type: 'text', text: string, tier: string}>}
 */
export function toContentParts(blocks) {
  const present = blocks.filter(b => b && typeof b.text === 'string' && b.text.length > 0);
  const parts = [];
  for (const tier of TIERS) {
    const tierBlocks = present.filter(b => (b.tier || 'volatile') === tier);
    if (tierBlocks.length === 0) continue;
    parts.push({ type: 'text', text: tierBlocks.map(renderBlock).join('\n\n'), tier });
  }
  return parts;
}

/**
 * Compute Anthropic cache_control placement for message content parts.
 *
 * Rules (deterministic, unit-tested — an off-by-one here 400s the primary
 * model and silently dumps all cortex traffic onto the fallback):
 *   - never a breakpoint on the last part (it is the volatile tail);
 *   - at most (maxBreakpoints - systemBreakpointsUsed) message breakpoints;
 *   - TTL by tier: boot → ttlStable, mission → ttlMission;
 *   - longer TTLs must come earlier: if ttlStable is '1h' and ttlMission is
 *     '5m' the order boot→mission already satisfies the API contract.
 *
 * @param {Array<{tier: string}>} parts        Output of toContentParts()
 * @param {object} cfg
 * @param {number} [cfg.maxBreakpoints=4]      Provider limit
 * @param {number} [cfg.systemBreakpointsUsed=1]
 * @param {string} [cfg.ttlStable='1h']
 * @param {string} [cfg.ttlMission='1h']
 * @returns {Array<{index: number, ttl: string}>} breakpoints by part index
 */
export function computeBreakpointLayout(parts, {
  maxBreakpoints = 4,
  systemBreakpointsUsed = 1,
  ttlStable = '1h',
  ttlMission = '1h',
} = {}) {
  const budget = Math.max(0, maxBreakpoints - systemBreakpointsUsed);
  const ttlFor = tier => (tier === 'boot' ? ttlStable : ttlMission);
  const out = [];
  for (let i = 0; i < parts.length - 1 && out.length < budget; i++) {
    const tier = parts[i].tier || 'volatile';
    if (tier === 'volatile') break; // never cache volatile content
    out.push({ index: i, ttl: ttlFor(tier) });
  }
  return out;
}
