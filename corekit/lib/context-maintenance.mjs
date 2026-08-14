// context-maintenance.mjs — the temporal-memory AUTO-MAINTENANCE reflex (RFC PROCESS_AS_NARRATIVE.md §6b).
//
// After a mission touches a project (or, later, draws on a process playbook), the temporal-memory organ
// refreshes that item's CONTEXT from what just happened — so the project's context (and the global
// playbook library) track reality, not the day they were written. This file holds the PURE pieces:
// the decision (should we maintain?), the craft-context prompt (temporal-memory's procedure + steward
// disposition), and the response parse. The daemon does the dispatch + the write (C-5: the organ
// produces the text, the daemon moves it).
//
// Design guardrails (RFC §6b): bounded (only the item the mission touched), conservative (skip when
// nothing durable was learned — no busywork edits), honest (B-29 — never fabricate), additive (refine,
// don't clobber), and it NEVER touches production or ships anything — it only curates context.

/**
 * Decide whether a completed mission should trigger context maintenance, and for what.
 * Pure. Runs only when the flag is on, the envelope is a completed mission, and it touched a project.
 * @returns {{run:boolean, projectId?:string, reason?:string}}
 */
export function shouldMaintainContext(mission, contracts) {
  if (!contracts?.dispatch?.context_maintenance) return { run: false, reason: 'flag off' };
  if (!mission || mission.type !== 'M') return { run: false, reason: 'not a mission' };
  if (mission.status !== 'complete') return { run: false, reason: 'not complete' };
  const projectId = mission.project_id || null;
  if (!projectId) return { run: false, reason: 'no project touched' };
  return { run: true, projectId };
}

/**
 * Build the instruction the temporal-memory organ follows to craft a refreshed project-context note.
 * Carries the steward disposition inline (the "personality"): keep what we know current, refine not
 * restate, and say nothing if nothing durable was learned. Pure.
 */
export function buildMaintenancePrompt(mission, project) {
  const goal = String(mission?.title || mission?.instruction || '').replace(/\s+/g, ' ').slice(0, 500);
  const outcome = String(mission?.output || '').replace(/\s+/g, ' ').slice(0, 2000);
  let current = '';
  try {
    const c = project?.context;
    if (c && typeof c === 'object' && Object.keys(c).length) current = JSON.stringify(c).slice(0, 2000);
  } catch { current = ''; }
  return [
    'You are the temporal-memory organ, keeping a prime-project\'s CONTEXT current after a mission touched it.',
    'Your stance: you steward what we KNOW about this project. When a mission works it, you refresh that',
    'knowledge from what JUST happened — tightening what proved out, recording what changed or what worked.',
    'You refine rather than restate, you keep it lean, and if nothing DURABLE was learned you say so plainly.',
    'You never invent, never log routine task chatter, and never include secrets.',
    '',
    `PROJECT: ${project?.name || project?.id || 'unknown'} (${project?.id || ''})`,
    `CURRENT CONTEXT: ${current || '(none)'}`,
    '',
    `MISSION GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"update": "<a concise, durable note about the project\'s state/approach worth remembering, or an EMPTY string if nothing durable was learned>"}',
    'The note is prose, <= 400 chars, about the project — not a task log.',
  ].join('\n');
}

/**
 * Parse the organ's response into a bounded context update. Pure. Never throws.
 * @returns {{update:string}}  update is '' when nothing durable was learned (or on any parse failure).
 */
export function parseMaintenanceResponse(text) {
  if (!text) return { update: '' };
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return { update: '' };
    const obj = JSON.parse(m[0]);
    const update = typeof obj.update === 'string' ? obj.update.trim().slice(0, 400) : '';
    return { update };
  } catch {
    return { update: '' };
  }
}
