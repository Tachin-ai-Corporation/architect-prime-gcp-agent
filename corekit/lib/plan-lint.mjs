// plan-lint.mjs — deterministic smells in a structured checkpoint plan
//
// The defect this exists to measure, from the comp-addendum mission:
//   CP1 Task 1  "Locate the master fixed comp addendum template within the … folder."
//   CP1 Task 2  "Duplicate the master template (identified in the previous task) three
//                times into the 'In Progress' folder (ID: FOLDER_ID). Name them …"
// Task 1 found the template and reported its id as a verified claim. Task 2 was a
// SEPARATE dispatch, so it had to re-resolve the phrase "identified in the previous
// task" from context — and picked the first row of a folder listing
// (…_Comp_Addendum_Application_Internal_Royalty) instead of …_Comp_Addendum_Fixed.
// Three documents were built from the wrong template and every downstream
// find-replace then had nothing to match.
//
// The plan shape is the bug: a task whose required INPUT is an identifier a previous
// task must discover. Those two tasks are one outcome and must not be split. This
// module finds that shape so it can be counted rather than argued about.
//
// Deliberately conservative: a phrase must say "an input I need was produced by an
// earlier task". Ordinary sequencing ("after the drafts exist", "once the folder is
// ready", "for each advisor") carries no identifier dependency and is not a finding.
//
// Pure: no I/O, no clock, no randomness (B-19).

/** Verbs by which a plan says an identifier was already discovered. */
const DISCOVERED = 'identified|found|located|discovered|determined|resolved|retrieved'
  + '|obtained|captured|returned|reported|noted|selected|confirmed|verified|specified'
  + '|referenced|mentioned|listed|surfaced';

/** Words pointing backwards through the plan. */
const BACKWARD = 'previous|prior|preceding|earlier|last|foregoing|aforementioned';

/** The units a planner numbers its work in. */
const UNIT = 'task|tasks|step|steps|checkpoint|checkpoints|sub-?task|action|instruction';

/** Nouns that name a thing an earlier task had to hand back. */
const HANDOFF = 'id|ids|identifier|identifiers|url|urls|link|links|path|name|names'
  + '|value|result|results|output|outputs';

/** Prepositions that make what follows an input rather than a destination. */
const FROM = 'in|from|by|per|of|at|during|using|with|based\\s+on';

// Ordered most-specific first; the first match becomes the reported phrase.
const PATTERNS = [
  // "from the previous task", "in the prior task", "output of the previous step",
  // "based on the preceding checkpoint" — the shape that broke the mission.
  new RegExp(`\\b(?:${FROM})\\s+(?:the\\s+)?(?:${BACKWARD})\\s+(?:${UNIT})(?:'s)?\\b`, 'i'),
  // "from step 1", "identified in task 2", "per checkpoint 3"
  new RegExp(`\\b(?:${FROM})\\s+(?:${UNIT})\\s*#?\\s*\\d+\\b`, 'i'),
  // "in the first task", "from the second step"
  new RegExp(`\\b(?:in|from)\\s+(?:the\\s+)?(?:first|1st|second|2nd|third|3rd)\\s+(?:${UNIT})\\b`, 'i'),
  // "identified above", "found above", "located earlier", "as determined earlier"
  new RegExp(`\\b(?:${DISCOVERED})\\s+(?:above|earlier|previously)\\b`, 'i'),
  // "the previously identified template", "the earlier located folder"
  new RegExp(`\\b(?:previously|earlier)\\s+(?:${DISCOVERED})\\b`, 'i'),
  // "the aforementioned template"
  /\bthe\s+aforementioned\b/i,
  // "the template you located", "the doc you just found"
  new RegExp(`\\byou\\s+(?:just\\s+|already\\s+|previously\\s+)?(?:${DISCOVERED})\\b`, 'i'),
  // "using the id from", "with the file ID returned", "pass the folder id discovered"
  new RegExp(
    `\\b(?:using|use|with|pass(?:ing)?|supply(?:ing)?|reference|referencing)\\s+the\\s+`
    + `(?:[\\w-]+\\s+){0,4}?(?:${HANDOFF})\\s+`
    + `(?:from|returned|discovered|found|identified|located|determined|obtained|reported|captured|noted)\\b`,
    'i',
  ),
];

/** A task may carry its text as `task`, `instruction`, or be a bare string. */
function taskText(task) {
  if (typeof task === 'string') return task.trim();
  if (!task || typeof task !== 'object') return '';
  const t = task.task ?? task.instruction ?? task.description ?? '';
  return typeof t === 'string' ? t.trim() : '';
}

/**
 * The back-reference phrase inside a task's text, or null.
 *
 * Reports the FIRST match only: one phrase is enough to condemn the plan shape, and
 * one phrase is what a log line has room for.
 *
 * @param {string} text
 * @returns {string|null} the matched phrase, whitespace collapsed
 */
export function matchBackReference(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  for (const re of PATTERNS) {
    const m = re.exec(s);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * Find tasks whose required input is an identifier a previous sibling must discover.
 *
 * Only a task that is NOT first in its checkpoint can be flagged — the first task has
 * no previous sibling, so a backward phrase there points outside the checkpoint and
 * means something else.
 *
 * @param {Array<{tasks?: Array}>} checkpoints - structured plan, as the executor sees it
 * @returns {Array<{checkpoint: number, task: number, phrase: string, text: string}>}
 *   findings in plan order; `checkpoint` and `task` are both 1-based
 */
export function findBackReferences(checkpoints) {
  if (!Array.isArray(checkpoints)) return [];
  const findings = [];
  checkpoints.forEach((cp, ci) => {
    const tasks = cp && Array.isArray(cp.tasks) ? cp.tasks : [];
    tasks.forEach((task, ti) => {
      if (ti === 0) return;                      // no previous sibling to refer to
      const text = taskText(task);
      const phrase = matchBackReference(text);
      if (phrase) findings.push({ checkpoint: ci + 1, task: ti + 1, phrase, text });
    });
  });
  return findings;
}

/**
 * One-line shape for logs and telemetry, e.g.
 * `CP1 task 2 back-ref "in the previous task": Duplicate the master template…`.
 *
 * @param {{checkpoint: number, task: number, phrase: string, text: string}} finding
 * @returns {string}
 */
export function formatBackReference(finding) {
  if (!finding) return '';
  const text = String(finding.text || '');
  const shown = text.length > 100 ? `${text.slice(0, 100)}…` : text;
  return `CP${finding.checkpoint} task ${finding.task} back-ref "${finding.phrase}": ${shown}`;
}
