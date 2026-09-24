// platform/work/memory-scope.mjs — the mission-level half of the memory boundary.
//
// Memory is a CLOSED set of three layers — working memory (MEMORY.md), Core Memory and the Deep
// Truths region (BRAIN_CANON B-5) — and a mission whose job is memory writes nothing else. A
// responsibility declares that with `effect_scope: "memory"` (the nightly consolidation does); the
// scheduler stamps it onto the mission's source_meta, and the checkpoint executor consults this
// module for every task. The gateway half (corekit/brain/config.mjs MEMORY_TOOLSET) gives
// Temporal-Memory only memory tools; this half makes sure nothing ELSE acts in a memory mission.
//
// Why a mission fence and not just the organ's toolset: a consolidation plan can assign a task to
// Motor, which holds a full shell. One did — it reconciled "project context" through
// project-manage. Routing Motor's task to Temporal-Memory keeps the work and drops the reach.
//
// Pure — no I/O. Every decision is a function of (envelope, stepType, taskAgent).

export const MEMORY_SCOPE = 'memory';

// Organs that may act in a memory mission. Temporal-Memory is the memory authority (its toolset is
// memory-only); Temporal-Research is read-only by canon and changes nothing.
const MEMORY_SAFE_AGENTS = new Set(['temporal-memory', 'temporal-research']);

/** True when the mission was fired by a memory-scoped responsibility. */
export function isMemoryScoped(envelope) {
  return envelope?.source_meta?.effect_scope === MEMORY_SCOPE;
}

/**
 * Decide what the checkpoint executor does with one task of a memory-scoped mission.
 *
 * @param {object} p
 * @param {string} p.stepType  - 'standard' | 'delegation' | 'approval_gate' | …
 * @param {string} p.taskAgent - the organ the plan assigned
 * @returns {{action:'allow'} | {action:'reroute', agent:string, reason:string} | {action:'refuse', reason:string}}
 */
export function fenceMemoryTask({ stepType = 'standard', taskAgent } = {}) {
  if (stepType === 'delegation') {
    return { action: 'refuse', reason: 'a memory-scoped mission may not delegate — memory is this agent\'s own and is written only by its memory authority' };
  }
  if (stepType === 'approval_gate') {
    return { action: 'refuse', reason: 'a memory-scoped mission may not open an approval gate — nothing it does leaves the memory layers, so there is nothing to approve' };
  }
  if (stepType !== 'standard') {
    return { action: 'refuse', reason: `a memory-scoped mission runs only standard memory tasks, not '${stepType}'` };
  }
  if (MEMORY_SAFE_AGENTS.has(taskAgent)) return { action: 'allow' };
  return {
    action: 'reroute',
    agent: 'temporal-memory',
    reason: `'${taskAgent || 'unassigned'}' holds effects beyond memory — the task runs on temporal-memory, whose toolset writes only the memory layers`,
  };
}
