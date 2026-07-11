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
