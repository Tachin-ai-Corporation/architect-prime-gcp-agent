// corekit/lib/compaction.mjs — deterministic context compaction (SESSION_CONTEXT_PLAN)
//
// Pure functions only (B-19): no I/O, no clock, no GCP. The daemon and the
// checkpoint executor consume these to keep dispatch context bounded:
//
//   Checkpoint rung (Phase 1): completed checkpoints forward a structured
//   digest — verdicts, short excerpts, pointers — instead of full transcripts.
//   The current checkpoint's results stay verbatim. Full step outputs remain
//   recoverable from the mission's work tree and step data (B-25: references,
//   not payloads).
//
// Budgets are characters (the platform's native unit); accept_criteria are
// copied verbatim and never rewritten (B-25).

import { toStr } from './to-str.mjs';
import { smartTruncate } from './vertex-text.mjs';

const DEFAULTS = {
  digest_excerpt_chars: 300,
  checkpoint_digest_chars: 4000,
};

/**
 * Extract the checkpoint number from a step id like "2.3" -> 2.
 * Returns null when the step id doesn't carry a checkpoint prefix.
 */
export function stepCheckpointNum(step) {
  const m = String(step ?? '').match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * Render a deterministic digest for one completed checkpoint.
 *
 * @param {object} p
 * @param {number} p.cpNum               1-based checkpoint number
 * @param {string} [p.instruction]       Checkpoint instruction (trimmed into header)
 * @param {string} [p.acceptCriteria]    Accept criteria — included VERBATIM (B-25)
 * @param {Array}  p.results             Step results: { step, agent, success, result }
 * @param {string} [p.missionId]         Mission envelope id for the recovery pointer
 * @param {number} [p.excerptChars=300]  Per-step excerpt budget
 * @param {number} [p.capChars=4000]     Whole-digest budget
 * @returns {string} Rendered digest block
 */
export function renderCheckpointDigest({
  cpNum,
  instruction = '',
  acceptCriteria = '',
  results = [],
  missionId = '',
  excerptChars = DEFAULTS.digest_excerpt_chars,
  capChars = DEFAULTS.checkpoint_digest_chars,
}) {
  const lines = [];
  const title = toStr(instruction).trim().replace(/\s+/g, ' ').substring(0, 120);
  lines.push(`[CHECKPOINT ${cpNum} DIGEST${title ? ` — ${title}` : ''}]`);
  if (acceptCriteria) {
    lines.push(`Accept criteria (verbatim): ${toStr(acceptCriteria)}`);
  }
  for (const r of results) {
    const excerpt = toStr(r.result || '').trim().replace(/\s+/g, ' ').substring(0, excerptChars);
    lines.push(`Step ${r.step} (${r.agent || 'unknown'}): ${r.success ? 'SUCCESS' : 'FAILED'} — ${excerpt}`);
  }
  if (missionId) {
    lines.push(`[Full step outputs: mission ${missionId} work tree / step data]`);
  }
  const rendered = lines.join('\n');
  return rendered.length <= capChars ? rendered : smartTruncate(rendered, capChars);
}

/**
 * Build the prior-work context for a task dispatch: digests of every
 * COMPLETED checkpoint plus the CURRENT checkpoint's results verbatim.
 *
 * Pure function of existing state — safe across crash-resume because step
 * ids embed their checkpoint number ("2.3"), so grouping needs no new
 * persisted state.
 *
 * @param {object} p
 * @param {Array}  p.checkpoints       Checkpoint entries (layout or stamped)
 * @param {Array}  p.allResults        Results from completed checkpoints
 * @param {Array}  p.cpResults         Results from the checkpoint in flight
 * @param {number} p.currentCpNum      1-based number of the checkpoint in flight
 * @param {string} [p.missionId]       Mission id for recovery pointers
 * @param {number} p.stepChars         Verbatim per-step budget (CTX_AGENT_STEP)
 * @param {number} [p.digestChars]     Per-digest budget
 * @param {number} [p.excerptChars]    Per-step excerpt budget inside digests
 * @returns {string|undefined} Prior-work block, or undefined when there is none
 */
export function buildPriorWorkContext({
  checkpoints = [],
  allResults = [],
  cpResults = [],
  currentCpNum,
  missionId = '',
  stepChars = 8000,
  digestChars = DEFAULTS.checkpoint_digest_chars,
  excerptChars = DEFAULTS.digest_excerpt_chars,
}) {
  if (allResults.length === 0 && cpResults.length === 0) return undefined;

  // Group completed-checkpoint results by their step prefix.
  const byCp = new Map();
  for (const r of allResults) {
    const cp = stepCheckpointNum(r.step);
    // Results in the current checkpoint (or without a prefix) stay verbatim.
    if (cp === null || cp === currentCpNum) continue;
    if (!byCp.has(cp)) byCp.set(cp, []);
    byCp.get(cp).push(r);
  }
  const unprefixed = allResults.filter(r => {
    const cp = stepCheckpointNum(r.step);
    return cp === null || cp === currentCpNum;
  });

  const sections = [];
  for (const cp of [...byCp.keys()].sort((a, b) => a - b)) {
    const entry = checkpoints[cp - 1] || {};
    const env = entry.cEnvelope || entry;
    sections.push(renderCheckpointDigest({
      cpNum: cp,
      instruction: env.instruction || entry.instruction || '',
      acceptCriteria: env.accept_criteria || entry.accept_criteria || '',
      results: byCp.get(cp),
      missionId,
      excerptChars,
      capChars: digestChars,
    }));
  }

  // Current checkpoint (and any unprefixed prior results): verbatim, once.
  const verbatim = [...unprefixed, ...cpResults].map(r =>
    `Step ${r.step} (${r.agent || 'unknown'}): ${r.success ? 'SUCCESS' : 'FAILED'}\n${smartTruncate(toStr(r.result || ''), stepChars)}`
  );
  if (verbatim.length > 0) {
    sections.push(verbatim.join('\n\n'));
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

// ---------------------------------------------------------------------------
// Mission rung (Phase 3): token-triggered rolling compaction of the decide
// loop's accumulated context. All decisions here are deterministic; only the
// digest PROSE comes from the stateless utility LLM, and its shape is
// hard-validated below (the utility path's wrap-as-synthesize last resort
// must never be spliced into a mission's context).
// ---------------------------------------------------------------------------

const ITERATION_SPLIT = /\n\n(?=--- Iteration )/;

/**
 * Deterministic compaction trigger (C-4). Fires only when the measured prompt
 * (real tokens preferred, chars/4 proxy otherwise) crosses the working-budget
 * threshold AND there is enough middle context to be worth folding.
 */
export function shouldCompact({
  lastRealPromptTokens = 0,
  accumulatedChars = 0,
  compactionsSoFar = 0,
  cfg = {},
}) {
  if (cfg.enabled === false) return { compact: false, reason: 'disabled' };
  const budget = cfg.working_budget_tokens || 80000;
  const triggerPct = cfg.trigger_pct || 0.7;
  const minTokens = cfg.min_compactable_tokens || 8000;
  const maxCompactions = cfg.max_compactions_per_mission || 3;
  if (compactionsSoFar >= maxCompactions) return { compact: false, reason: 'max_compactions' };
  const effective = Math.max(lastRealPromptTokens, Math.ceil(accumulatedChars / 4));
  if (Math.ceil(accumulatedChars / 4) < minTokens) return { compact: false, reason: 'below_min' };
  if (effective < budget * triggerPct) return { compact: false, reason: 'below_threshold' };
  return { compact: true, reason: `effective=${effective} >= ${Math.floor(budget * triggerPct)}` };
}

/**
 * Split accumulated context into { head, blocks } on iteration markers.
 * head carries the mission framing plus any prior [CONTEXT COMPACTED] digest
 * blocks — which therefore stay pinned through every later fold and through
 * the fallback prune (both split on the same iteration-marker regex).
 */
export function splitIterationBlocks(accumulated) {
  const parts = (accumulated || '').split(ITERATION_SPLIT);
  if (parts.length === 0) return { head: '', blocks: [] };
  return { head: parts[0], blocks: parts.slice(1) };
}

/**
 * Deterministic secret scrub for anything durably persisted (C-8 names
 * transcripts a leak surface). Best-effort by nature — the pattern list errs
 * broad and the git session log stays contracts-disabled by default.
 */
export function redactSecrets(text) {
  return (text || '')
    .replace(/ya29\.[A-Za-z0-9_-]+/g, '[REDACTED-GCP-TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED-API-KEY]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED-GITHUB-TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]');
}

/**
 * Hard-validate the LLM digest shape (B-29 bins mandatory). Rejecting here is
 * what keeps enforceSchema-style repair fallbacks out of mission context.
 */
export function validateMissionDigest(d) {
  if (!d || typeof d !== 'object') return { valid: false, reason: 'not an object' };
  if (!Array.isArray(d.decisions)) return { valid: false, reason: 'decisions missing' };
  if (!Array.isArray(d.claims)) return { valid: false, reason: 'claims missing' };
  for (const c of d.claims) {
    if (!c || typeof c.text !== 'string' || !['verified', 'inferred', 'assumed'].includes(c.bin)) {
      return { valid: false, reason: 'claims entries require text and bin in {verified,inferred,assumed}' };
    }
  }
  if (!Array.isArray(d.open_questions)) return { valid: false, reason: 'open_questions missing' };
  return { valid: true };
}

/** Instruction handed to the stateless utility LLM (C-6). */
export function missionDigestInstruction() {
  return [
    'Summarize this mission work log into STRICT JSON with exactly these keys:',
    '{"covered_iterations":"i..j","decisions":[{"iteration":1,"action":"...","target":"...","outcome":"..."}],',
    '"claims":[{"text":"...","bin":"verified|inferred|assumed","source":"..."}],',
    '"open_questions":["..."],"artifacts":[{"ref":"...","desc":"..."}],"durable_learnings":["..."]}',
    'Every claim MUST carry its epistemic bin: verified (the check can be shown), inferred (follows by stated reasoning), assumed (not checked).',
    'Never upgrade a bin. Preserve exact identifiers, file paths, and envelope ids. Respond with ONLY the JSON object.',
  ].join('\n');
}

/**
 * Render the compacted accumulated-context string. Mission instruction and
 * accept criteria are daemon-copied VERBATIM (B-25) — the LLM never rewrites
 * them. The digest block does not start with '--- Iteration ', so every
 * later split folds it into the head: pinned by construction.
 */
export function spliceCompacted({
  head,
  keptBlocks = [],
  digest,
  seq,
  instruction = '',
  acceptCriteria = '',
  coveredLabel = '',
  sessionLogPath = '',
  capChars = 6000,
}) {
  const lines = [
    `[CONTEXT COMPACTED — seq ${seq}${coveredLabel ? ` — iterations ${coveredLabel}` : ''}]`,
    instruction ? `Mission instruction (verbatim): ${toStr(instruction)}` : '',
    acceptCriteria ? `Accept criteria (verbatim): ${toStr(acceptCriteria)}` : '',
    `Decisions: ${JSON.stringify(digest.decisions || [])}`,
    `Claims (each carries its epistemic bin — treat 'assumed' as unverified): ${JSON.stringify(digest.claims || [])}`,
    `Open questions: ${JSON.stringify(digest.open_questions || [])}`,
    (digest.artifacts && digest.artifacts.length) ? `Artifacts: ${JSON.stringify(digest.artifacts)}` : '',
    (digest.durable_learnings && digest.durable_learnings.length) ? `Durable learnings: ${JSON.stringify(digest.durable_learnings)}` : '',
    sessionLogPath ? `Full pre-compaction log: ${sessionLogPath}` : '',
  ].filter(Boolean);
  let block = lines.join('\n');
  if (block.length > capChars) block = smartTruncate(block, capChars);
  return [head, block, ...keptBlocks].filter(Boolean).join('\n\n');
}
