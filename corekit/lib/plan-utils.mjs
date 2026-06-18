// plan-utils.mjs — Checkpoint plan extraction and normalization
// Phase 2.4: Module-level extraction from agent-brain.mjs checkpoint_plan handler

import { toStr } from './to-str.mjs';

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
