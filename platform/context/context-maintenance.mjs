// context-maintenance.mjs — the temporal-memory LESSON reflex (RFC PROCESS_AS_NARRATIVE.md §6b, re-scoped).
//
// After a mission works in a project or draws on a process playbook, the temporal-memory organ is
// asked what DURABLE lesson the run taught about that project or playbook. The lesson is MEMORY: the
// daemon appends it to working memory (MEMORY.md), where the nightly consolidation decides whether it
// earns a place in Core Memory — the same gate every other learning passes (BRAIN_CANON B-5).
//
// It is never written into the project record or the playbook. Those are definitions, read-only to
// memory. This reflex used to do exactly that — replace a playbook's narrative and write a note into
// project context — which let one mission's view silently rewrite a Fleet Definition record (C-29) and
// put history into a project's 40,000-ft view (C-28).
//
// This file holds the PURE pieces: the decisions (should we ask?), the prompts, the response parse,
// and the working-memory line. The daemon does the dispatch + the append (C-5: the organ produces the
// text, the daemon moves it).

/**
 * Decide whether a completed mission should be asked for a project lesson, and for which project.
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
 * Build the instruction the temporal-memory organ follows to record what a mission taught about the
 * project it worked in. The project's own context is shown READ-ONLY — so the lesson never restates
 * what the project already declares — and the output is a lesson for memory, not a project edit. Pure.
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
    'You are the temporal-memory organ, recording what a mission taught us about a project it worked in.',
    'What you write is MEMORY — a lesson the agent recalls the next time it works in this project. It is',
    'never written into the project record: the project context below is read-only, shown so you do not',
    'restate what it already declares. Record only something DURABLE this run revealed (a constraint, an',
    'approach that worked, a pitfall worth naming); if the run was routine, say nothing — silence is the',
    'honest default. Never invent, never log task chatter, never include secrets.',
    '',
    `PROJECT: ${project?.name || project?.id || 'unknown'} (${project?.id || ''})`,
    `PROJECT CONTEXT (read-only): ${current || '(none)'}`,
    '',
    `MISSION GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"lesson": "<one durable lesson about working in this project, <= 300 chars, or an EMPTY string if nothing durable was learned>"}',
  ].join('\n');
}

/**
 * Parse the organ's response into a bounded lesson. Pure. Never throws. Reads `lesson`, and the
 * pre-re-scope `update` key so an organ answering the old contract still lands in memory.
 * @param {string} text
 * @param {number} [maxLen=300]
 * @returns {{lesson:string}}  lesson is '' when nothing durable was learned (or on any parse failure).
 */
export function parseMaintenanceResponse(text, maxLen = 300) {
  if (!text) return { lesson: '' };
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return { lesson: '' };
    const obj = JSON.parse(m[0]);
    const raw = typeof obj.lesson === 'string' ? obj.lesson : (typeof obj.update === 'string' ? obj.update : '');
    return { lesson: raw.replace(/\s+/g, ' ').trim().slice(0, maxLen) };
  } catch {
    return { lesson: '' };
  }
}

/**
 * Decide whether a completed mission should be asked for lessons about the PLAYBOOKS it drew on.
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
 * Build the instruction the temporal-memory organ follows to record what a mission taught about a
 * playbook it drew on. The narrative is shown READ-ONLY: memory never rewrites a playbook — changing
 * one is an authoring decision for the definition plane. Pure.
 */
export function buildProcessMaintenancePrompt(process, mission) {
  const goal = String(mission?.title || mission?.instruction || '').replace(/\s+/g, ' ').slice(0, 500);
  const outcome = String(mission?.output || '').replace(/\s+/g, ' ').slice(0, 2000);
  const current = String(process?.narrative || '').replace(/\s+/g, ' ').slice(0, 1200);
  return [
    'You are the temporal-memory organ, recording what a mission taught us about a PROCESS PLAYBOOK it drew on.',
    'What you write is MEMORY — a lesson recalled the next time this kind of work comes up. The playbook is a',
    'definition and is read-only to memory: you never rewrite it. Record a lesson ONLY if this run revealed',
    'something the narrative below does not already carry (a sharper way, a pitfall worth naming, a step that',
    'proved to matter); if the run was routine, say nothing — silence is the honest default. NO tool syntax,',
    'NO commands, NO step lists, never invent.',
    '',
    `PLAYBOOK: ${process?.name || process?.id || 'unknown'} (${process?.id || ''})`,
    `PLAYBOOK NARRATIVE (read-only): ${current || '(none)'}`,
    '',
    `MISSION THAT USED IT — GOAL: ${goal}`,
    `MISSION OUTCOME: ${outcome || '(none)'}`,
    '',
    'Respond with exactly ONE JSON object and nothing else:',
    '  {"lesson": "<one durable lesson about this kind of work, <= 300 chars, or an EMPTY string if nothing durable was learned>"}',
  ].join('\n');
}

/**
 * The working-memory line a lesson becomes. Scoped so consolidation (and recall) know what it is
 * about. Pure; one line, whitespace-normalized.
 *
 * @param {object} p
 * @param {'project'|'playbook'} p.scope
 * @param {string} p.id
 * @param {string} p.lesson
 * @param {string} [p.date] - YYYY-MM-DD (default: today, UTC)
 * @returns {string} the line, newline-terminated; '' when there is no lesson
 */
export function lessonLine({ scope, id, lesson, date } = {}) {
  const text = String(lesson || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const day = date || new Date().toISOString().slice(0, 10);
  return `- [${day}] lesson (${scope === 'playbook' ? 'playbook' : 'project'} ${id || 'unknown'}): ${text}\n`;
}
