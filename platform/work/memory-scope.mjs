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
// It also writes the mission's plan (memoryMissionPlan): a memory mission is one pass by the memory
// authority, never a planner's decomposition.
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

/**
 * The plan of a memory-scoped mission: ONE checkpoint whose ONE task is the whole cycle, run by
 * temporal-memory in a single pass.
 *
 * Why the daemon writes this plan (C-4) instead of a planner: every task of a memory mission runs
 * on temporal-memory, a fresh session each time, which can write only MEMORY.md and the
 * consolidation report. A plan split into checkpoints therefore has no way to hand its triage
 * forward — and the planner kept inventing one: four nightly consolidations in a row routed the
 * work through a plan FILE (`consolidation_plan.json`, `reconciliation_plan.md`) that memory may
 * not write, so every later checkpoint found nothing and the mission blocked. A task does not see
 * the mission's context, so this one carries the full process itself.
 *
 * @param {object} envelope - the mission: instruction, accept_criteria, context_summary
 * @param {object} [opts]
 * @param {string} [opts.unmet] - what the verifier found unmet last time, for a retry to address
 * @returns {Array<{instruction:string, accept_criteria:string, tasks:Array<{agent:string, task:string}>}>}
 */
export function memoryMissionPlan(envelope, { unmet = '' } = {}) {
  const instruction = String(envelope?.instruction || '').trim() || 'Consolidate memory.';
  const context = String(envelope?.context_summary || '').trim();
  const missed = String(unmet || '').trim();
  const task = [
    `Run the whole cycle in ONE pass, yourself, with your memory tools: ${instruction}`,
    'Do every step of the PROCESS below, in order — gather, triage, retire and promote, rewrite working memory, review Deep Truths — then write the report.',
    'There is no other task to hand anything to, and memory writes only MEMORY.md and consolidation_report.md: keep your triage in your own working context, never in a file of your own.',
    'Write consolidation_report.md LAST, from what you actually did: every retirement, promotion and Deep-Truth change with its id and reason, and the final MEMORY.md character count. The report is the outcome the verifier checks.',
    'Changing nothing is a valid outcome: when nothing in working memory needs to change, leave MEMORY.md as it is and say so in the report.',
    missed ? `\nThe last attempt did not satisfy all of the criteria. Address every one of these this time:\n${missed}` : '',
    context ? `\n${context}` : '',
  ].filter(Boolean).join('\n');
  return [{
    instruction,
    accept_criteria: String(envelope?.accept_criteria || ''),
    tasks: [{ agent: 'temporal-memory', task }],
  }];
}
