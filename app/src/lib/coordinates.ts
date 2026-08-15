/**
 * The three version coordinates, and whether an agent is actually running them.
 *
 * C-32 gives every agent three independent coordinates — the Foundation commit
 * it installed, the Fleet release it was assigned, and the digest of the content
 * that compiled to. An operator asking "what is this agent running" needs all
 * three, because a difference in any one explains a different class of problem:
 * a stale platform is an upgrade that did not land, a stale release is a
 * rollout that did not reach here, a digest mismatch is content that is not what
 * was approved.
 *
 * Desired and actual are reported separately and never collapsed. The registry
 * records what an apply *reported*, which is a claim about the past; showing it
 * as current state is how an agent runs Foundation defaults for a week while the
 * dashboard says "converged".
 */

export type DriftState = 'converged' | 'pending' | 'failed' | 'unmanaged' | 'unknown';

export interface AgentCoordinates {
  agent: string;
  /** The Foundation commit installed on the VM (STATE.json coreRef). */
  platformVersion: string | null;
  fleetRelease: { desired: string | null; actual: string | null };
  agentSpecDigest: { desired: string | null; actual: string | null };
  roleId: string | null;
  appliedAt: string | null;
  lastError: string | null;
  drift: DriftState;
  /** Why this agent is in that state, in one sentence an operator can act on. */
  explanation: string;
}

/** The shape the registry writes to `fleet_assignments/<agent>`. */
export interface AssignmentRecord {
  id?: string;
  role_id?: string | null;
  desired_release?: string | null;
  actual_release?: string | null;
  desired_spec_digest?: string | null;
  actual_spec_digest?: string | null;
  applied_at?: string | null;
  drift?: string | null;
  last_error?: string | null;
  pinned?: boolean;
}

const short = (d: string | null | undefined) => (d ? `${d.slice(0, 19)}…` : 'none');

/**
 * Derive an agent's coordinates and a readable verdict.
 *
 * Deliberately total: every combination produces a state and a sentence, because
 * a blank cell in an operator view is indistinguishable from a healthy one.
 */
export function deriveCoordinates(
  agent: string,
  assignment: AssignmentRecord | null,
  platformVersion: string | null,
): AgentCoordinates {
  const base = {
    agent,
    platformVersion: platformVersion ?? null,
    roleId: assignment?.role_id ?? null,
    fleetRelease: { desired: assignment?.desired_release ?? null, actual: assignment?.actual_release ?? null },
    agentSpecDigest: { desired: assignment?.desired_spec_digest ?? null, actual: assignment?.actual_spec_digest ?? null },
    appliedAt: assignment?.applied_at ?? null,
    lastError: assignment?.last_error ?? null,
  };

  if (!assignment) {
    return {
      ...base, drift: 'unmanaged',
      explanation: 'No fleet assignment — this agent’s definitions are not managed by a release yet.',
    };
  }

  if (assignment.last_error) {
    return {
      ...base, drift: 'failed',
      explanation: `The last apply failed: ${assignment.last_error}`,
    };
  }

  if (!assignment.desired_release) {
    return {
      ...base, drift: 'unmanaged',
      explanation: 'The assignment names no desired release, so there is nothing to converge on.',
    };
  }

  if (assignment.actual_release !== assignment.desired_release) {
    return {
      ...base, drift: 'pending',
      explanation:
        `Assigned ${assignment.desired_release} but running ${assignment.actual_release ?? 'nothing'} — ` +
        `the content sync has not applied it yet.`,
    };
  }

  // A pinned digest that does not match means the VM compiled something other
  // than what was validated and approved. That is not "pending", it is a refusal.
  if (assignment.desired_spec_digest && assignment.desired_spec_digest !== assignment.actual_spec_digest) {
    return {
      ...base, drift: 'failed',
      explanation:
        `Running ${short(assignment.actual_spec_digest)} but ${short(assignment.desired_spec_digest)} was approved — ` +
        `the agent is refusing content that is not what was released.`,
    };
  }

  if (!assignment.actual_spec_digest) {
    return {
      ...base, drift: 'unknown',
      explanation: 'The release is assigned but no applied digest has been reported, so what is live cannot be confirmed.',
    };
  }

  return {
    ...base, drift: 'converged',
    explanation: `Running ${assignment.desired_release} (${short(assignment.actual_spec_digest)}) as assigned.`,
  };
}

/** Fleet-level summary — how many agents are actually on what they were given. */
export function summarize(all: AgentCoordinates[]) {
  const counts: Record<DriftState, number> = { converged: 0, pending: 0, failed: 0, unmanaged: 0, unknown: 0 };
  for (const c of all) counts[c.drift]++;
  const managed = all.length - counts.unmanaged;
  return {
    total: all.length,
    managed,
    counts,
    // "All converged" is only true of agents a release actually governs; counting
    // unmanaged agents as healthy would make an empty rollout look complete.
    allConverged: managed > 0 && counts.converged === managed,
  };
}
