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
 * Parse the organ's response into a bounded update. Pure. Never throws.
 * @param {string} text
 * @param {number} [maxLen=400] cap on the update length (project notes 400; playbook narratives longer)
 * @returns {{update:string}}  update is '' when nothing durable was learned (or on any parse failure).
 */
export function parseMaintenanceResponse(text, maxLen = 400) {
  if (!text) return { update: '' };
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return { update: '' };
    const obj = JSON.parse(m[0]);
    const update = typeof obj.update === 'string' ? obj.update.trim().slice(0, maxLen) : '';
    return { update };
  } catch {
    return { update: '' };
  }
}

/**
 * Decide whether a completed mission should refine any PLAYBOOK narratives it drew on.
 * Pure. Runs only when the flag is on, the envelope is a completed mission, and the planner recalled
 * one or more playbooks (mission.recalled_processes, stamped by checkpoint_plan when a playbook's
 * intent_keywords matched the mission goal). Bounded to at most `max` so one mission can never fan out.
 * @returns {{run:boolean, processIds?:string[], reason?:string}}
 */
export function shouldMaintainProcesses(mission, contracts, max = 3) {
  if (!contracts?.dispatch?.context_maintenance) return { run: false, reason: 'flag off' };
  if (!mission || mission.type !== 'M') return { run: false, reason: 'not a mission' };
  if (mission.status !== 'complete') return { run: false, reason: 'not complete' };
  const ids = Array.isArray(mission.recalled_processes)
    ? [...new Set(mission.recalled_processes.filter(x => typeof x === 'string' && x))].slice(0, max)
    : [];
  if (ids.length === 0) return { run: false, reason: 'no playbook recalled' };
  return { run: true, processIds: ids };
}

/**
 * Build the instruction the temporal-memory organ follows to REFINE a playbook's narrative from what
 * a mission that drew on it just did. Same steward disposition, conservative + additive: refine ONLY if
 * the run genuinely revealed something the pattern should carry; else leave it as-is (empty update). A
 * playbook narrative is tool-syntax-free prose about HOW a recurring kind of work is done well. Pure.
 */
export function buildProcessMaintenancePrompt(process, mission) {
  const goal = String(mission?.title || mission?.instruction || '').replace(/\s+/g, ' ').slice(0, 500);
  const outcome = String(mission?.output || '').replace(/\s+/g, ' ').slice(0, 2000);
  const current = String(process?.narrative || '').replace(/\s+/g, ' ').slice(0, 1200);
  return [
    'You are the temporal-memory organ, keeping a shared PROCESS PLAYBOOK current after a mission drew on it.',
    'A playbook is a remembered narrative — HOW a recurring kind of work is done well, in prose, with NO tool',
    'syntax, NO step lists, NO commands. Refine the narrative ONLY if this mission genuinely revealed something',
    'the pattern should carry going forward (a sharper way, a pitfall worth naming, a step that proved to matter).',
    'If the run was routine and the narrative already covers it, say nothing — silence is the honest default.',
    'You refine and tighten; you never bloat, never restate the mission, never invent, never add tool syntax.',
    '',
    `PLAYBOOK: ${process?.name || process?.id || 'unknown'} (${process?.id || ''})`,
    `CURRENT NARRATIVE: ${current || '(none)'}`,
    '',
    `MISSION THAT USED IT — GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"update": "<the FULL refined narrative prose if it should change, or an EMPTY string to leave it as-is>"}',
    'When non-empty, "update" is the complete replacement narrative (<= 700 chars), tool-syntax-free prose.',
  ].join('\n');
}
