// plan-utils.mjs — Checkpoint plan extraction and normalization
// Phase 2.4: Module-level extraction from agent-brain.mjs checkpoint_plan handler

import { toStr } from '../providers/to-str.mjs';

/**
 * Extract checkpoints array from a cortex/prefrontal decision object.
 * Handles multiple JSON shapes: { checkpoints: [...] }, { plan: { checkpoints: [...] } },
 * { checkpoint_plan: { checkpoints: [...] } }, or raw array of tasks.
 * Normalizes field names (steps→tasks, description→instruction).
 *
 * @param {object} d - Decision object from cortex/prefrontal
 * @param {function} [log] - Optional logger; defaults to no-op
 * @returns {Array|null} Normalized checkpoints array, or null if none found
 */
export function extractCheckpoints(d, log = () => {}) {
  // Already normalized by normalizeDecision in enforceSchema, but belt-and-suspenders
  const raw = d.checkpoints
    || d.plan?.checkpoints
    || d.checkpoint_plan?.checkpoints;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  // If raw is a flat array of tasks (no .tasks nesting), wrap in one checkpoint
  if (raw[0] && raw[0].agent && !raw[0].tasks) {
    return [{ instruction: d.instruction || d.goal || 'Execute plan', tasks: raw }];
  }

  // Normalize: ensure each checkpoint has a tasks array with valid entries
  return raw.map((cp, i) => ({
    instruction: cp.instruction || cp.title || cp.description || `Checkpoint ${i + 1}`,
    accept_criteria: cp.accept_criteria || '',
    tasks: (Array.isArray(cp.tasks) ? cp.tasks : (cp.steps || cp.parts || [])).filter(t => {
      // Validate task has agent and instruction (or task)
      // Delegation tasks may lack agent but have target_email — allow them through
      if (t.type === 'delegation' || t._step_type === 'delegation') return true;
      if (!t.agent || typeof t.agent !== 'string') {
        log('WARN', `Checkpoint ${i + 1}: skipping task without agent field`);
        return false;
      }
      return true;
    }).map(t => ({
      ...t,
      task: toStr(t.task || t.instruction || t.description || ''),
    })),
  })).filter(cp => cp.tasks.length > 0); // Drop checkpoints with zero valid tasks
}

/**
 * C-15 invariant: a mission (M) never nests under other work. The ONE legitimate parented
 * mission is a responsibility-spawned one — the R→M→C→T chain, where the routine (R)
 * envelope is the mission's parent (see work/scheduler.mjs, which stamps every such mission
 * with source_meta.responsibility_id and later queries missions by that key). Any OTHER
 * parented M is a nesting bug and is demoted to a checkpoint (C).
 *
 * This guard previously had no exemption, so it silently demoted every routine-spawned
 * mission to a C — which is why a nightly routine's tree rendered as "checkpoints under a
 * checkpoint" instead of R→M→C→T. External delivery is separately gated on parent_id (only
 * parent-less roots egress — see agent-brain completeEnvelope), so an exempted mission still
 * never delivers to the mouth; this is purely about the type label and the tree shape.
 *
 * Pure (B-19): mutates `env` in place; returns true iff it corrected the type.
 *
 * @param {object} env - a work envelope (mutated in place)
 * @returns {boolean} true if the envelope was demoted M→C
 */
export function enforceMissionParentInvariant(env) {
  if (env && env.type === 'M' && env.parent_id && !env.source_meta?.responsibility_id) {
    env.type = 'C';
    env.delivery_status = 'internal';
    return true;
  }
  return false;
}

/**
 * Which agent brain should claim a given intake.
 *
 * Intake is prime-scoped (`primes/{PRIME_ID}/intake`), and a FLEET agent's brain runs
 * with PRIME_ID = its MANAGING prime — so the prime cortex AND every fleet agent under
 * it poll the SAME intake collection. Routing is by `source_meta.agentId` (stamped by
 * agent-ears). This predicate decides ownership so a fleet agent can never answer a
 * message meant for the prime (or another agent):
 *
 *   - the prime cortex (agentId `'prime'`) owns intakes ADDRESSED to the prime AND
 *     UNADDRESSED ones — it is the default owner of its own intake feed;
 *   - a fleet agent owns ONLY intakes explicitly addressed to it.
 *
 * Both pollers previously used `!target || target === AGENT_ID`, so a fleet agent also
 * claimed UNADDRESSED intakes and could hijack a message meant for the prime (observed:
 * a fleet agent answered a no-agentId prime probe as itself).
 *
 * Pure (B-19).
 *
 * @param {string} agentId         - this brain's AGENT_ID ('prime' or a fleet agent name)
 * @param {string} [targetAgentId] - the intake's `source_meta.agentId` (its addressee), if any
 * @returns {boolean} true iff this agent should claim the intake
 */
export function agentClaimsIntake(agentId, targetAgentId) {
  if (agentId === 'prime') return !targetAgentId || targetAgentId === 'prime';
  return targetAgentId === agentId;
}
