// blackboard.mjs — the shared mission blackboard (ORGAN_CONTEXT_SHARING_PLAN, Phase 4)
//
// A single, deterministic, git-versioned view of a mission's evolving state — goal,
// decisions + result packets (summary + ref), and open questions — rendered from envelope
// state and written to shared/<missionId>/MISSION.md each iteration (C-24 substrate, C-5
// daemon-maintained). It is the complete, addressable, human- and organ-readable mission
// trail: any organ can read the full picture from one place instead of reconstructing it
// from lossy call-to-call threading.
//
// Pure module — no I/O, no Date (the daemon passes `iteration`), no side effects (B-18/B-19).

function clip(text, budget) {
  const t = String(text || '').replace(/\s+$/g, '');
  if (t.length <= budget) return t;
  return t.slice(0, budget) + ` …[+${t.length - budget} chars]`;
}

function stepLabel(r) {
  return r.checkpoint_step || r.step || '—';
}

// One compact blackboard row per result: step · agent · (summary|result) · ref · status.
function renderRow(r, perRow) {
  const agent = r.agent || 'unknown';
  const body = clip(r.summary || r.result || '', perRow);
  const ref = r.ref ? ` _(ref: ${r.ref})_` : '';
  const status = r.success === false ? ' ❌ FAILED' : '';
  return `- **[${stepLabel(r)}] ${agent}**${status}: ${body}${ref}`;
}

/**
 * Render the mission blackboard as markdown. Pure and deterministic.
 * @param {Object} envelope - the mission envelope (id, instruction/goal, accept_criteria)
 * @param {Array}  priorResults - accumulated result packets/decisions this mission
 * @param {Object} opts - { maxChars = 12000, iteration = 0, perRow = 400 }
 */
export function renderBlackboard(envelope, priorResults = [], opts = {}) {
  const { maxChars = 12000, iteration = 0, perRow = 400 } = opts;
  const id = envelope?.id || 'unknown';
  const goal = clip(envelope?.instruction || envelope?.goal || '(no goal recorded)', 800);
  const criteria = envelope?.accept_criteria ? clip(envelope.accept_criteria, 600) : '';

  const rows = (priorResults || []).map(r => renderRow(r, perRow));
  const failures = (priorResults || [])
    .filter(r => r.success === false)
    .map(r => `- [${stepLabel(r)}] ${r.agent || 'unknown'}: ${clip(r.summary || r.result || '', 300)}`);

  const parts = [
    `# Mission Blackboard — ${id}`,
    ``,
    `## Goal`,
    goal,
    ...(criteria ? [``, `## Acceptance Criteria`, criteria] : []),
    ``,
    `## Results & Decisions (chronological)`,
    rows.length ? rows.join('\n') : '_(none yet)_',
    ``,
    `## Open / Failures`,
    failures.length ? failures.join('\n') : '_(none)_',
    ``,
    `_maintained by the daemon · iteration ${iteration}_`,
  ];
  const doc = parts.join('\n');
  // Bound the whole document; keep the head (goal + earliest results) which anchors context.
  return doc.length > maxChars
    ? doc.slice(0, maxChars) + `\n\n…[blackboard truncated to ${maxChars} chars]`
    : doc;
}
