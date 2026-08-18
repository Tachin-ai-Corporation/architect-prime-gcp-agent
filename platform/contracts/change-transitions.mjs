// platform/contracts/change-transitions.mjs — the Fleet Change state machine
//
// The Change lifecycle was implicit across three writers: createChange stamped
// `draft`, recordValidation flipped between `validated` and `draft`, and
// createRelease stamped `released`. Nothing could answer "may a released change
// go back to draft?" except by reading all three — the same condition
// work-transitions.mjs was written to end for Work envelopes, and this is the
// same answer in the same shape.
//
// Pure by construction — no Firestore, no clock, no logging. It decides; the
// caller writes (B-19).
//
// SCOPE, stated so it is not over-read. This machine covers the CHANGE. The
// Release has its own states (released → canary → active → superseded |
// rolled-back) which already exist and are already enforced by createRelease,
// assign and rollback. Two objects, two lifecycles; the plan's single chain
// spans both, and conflating them into one table would have invented a state
// neither object has.

/** Every state a change may hold. */
export const CHANGE_STATUSES = Object.freeze([
  'draft', 'validated', 'evaluated', 'approved', 'released', 'abandoned',
]);

/**
 * The legal moves, keyed by current status.
 *
 * Read a row as "from here, these are the only places a change can go".
 *
 * Two properties worth stating because they are choices, not accidents:
 *
 * 1. Every pre-release state can fall back to `draft`. Re-authoring a change
 *    after a failed validation or a bad evaluation is the NORMAL path, not an
 *    exception — a lifecycle that only moves forward forces an author to abandon
 *    and re-create, which loses the change's history precisely when it is most
 *    informative.
 * 2. `validated` may go straight to `released`. Evaluation is EVIDENCE, not a
 *    mandatory gate, and pretending otherwise would have been a lie the seed path
 *    immediately exposes: `import` produces a change nobody can evaluate, because
 *    there is no baseline to evaluate it against. What the gate does require is
 *    passing validation, and createRelease has always enforced that.
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  draft: ['validated', 'abandoned'],
  // Validation failing sends a change back to draft, which is why `draft` is a
  // target here and not only a source.
  validated: ['evaluated', 'approved', 'released', 'draft', 'abandoned'],
  evaluated: ['approved', 'released', 'draft', 'abandoned'],
  approved: ['released', 'draft', 'abandoned'],
  // Terminal. A released change is part of an immutable release; editing it
  // would change what a release id means, which is the invariant the whole
  // program rests on.
  released: [],
  abandoned: [],
});

/** A change that can no longer move. */
export const TERMINAL_STATUSES = Object.freeze(['released', 'abandoned']);

/**
 * Preconditions a transition needs beyond being legal on the table.
 *
 * Separated from the table because "is this move allowed" and "is this change
 * ready to make it" are different questions with different answers, and the
 * caller needs to tell a user which one failed.
 */
export const TRANSITION_REQUIREMENTS = Object.freeze({
  // A release carries its evidence (C-31). createRelease has enforced this since
  // it was written; naming it here means the rule is discoverable from the state
  // machine rather than only from the function that happens to apply it.
  released: (change) => (change?.validation?.passed
    ? null
    : 'a release carries its evidence — this change has no passing validation (C-31)'),
  evaluated: (change) => ((change?.evaluation_ids || []).length
    ? null
    : 'a change is only `evaluated` once an evaluation is attached to it'),
});

/**
 * May a change move from `from` to `to`?
 *
 * Idempotence is a PASS, deliberately: re-recording the same verdict must not be
 * an error, or every retry after a partial failure becomes a manual repair. The
 * caller writes the same value twice and nothing moves.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function canTransition(from, to, change = null) {
  if (!CHANGE_STATUSES.includes(to)) {
    return { ok: false, reason: `'${to}' is not a change status (${CHANGE_STATUSES.join(', ')})` };
  }
  // An unknown or absent `from` is treated as draft: a change read from an older
  // record may predate this field, and refusing to move it would strand it.
  const current = CHANGE_STATUSES.includes(from) ? from : 'draft';

  if (current === to) return { ok: true, reason: 'already there — recording the same state is a no-op' };

  const allowed = LEGAL_TRANSITIONS[current] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: TERMINAL_STATUSES.includes(current)
        ? `'${current}' is terminal — a released change is part of an immutable release`
        : `a change cannot go ${current} → ${to} (from '${current}': ${allowed.join(', ') || 'nowhere'})`,
    };
  }

  const requires = TRANSITION_REQUIREMENTS[to];
  const unmet = requires ? requires(change) : null;
  return unmet ? { ok: false, reason: unmet } : { ok: true, reason: `${current} → ${to}` };
}

/** Every state reachable from here in one move. */
export function reachableFrom(from) {
  return [...(LEGAL_TRANSITIONS[from] || [])];
}

/** Can this change still move at all? */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}
