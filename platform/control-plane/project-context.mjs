// platform/control-plane/project-context.mjs — the single validator for what a Project may hold.
//
// C-28 (layer purity): a Project is the 40,000-foot view of a working area — durable
// resource references and pointers to related processes, never mission particulars,
// history, transient state, or process/task steps (those belong to the Mission record,
// an Artifact, or a Process). See docs/MODULE_CHARTER.md.
//
// This module is the ONE place the rule lives, applied by every corekit writer that
// touches project.context: the mission-synthesis extractor (synthesize.mjs), the
// mission→project promotion (projects.mjs suggestContextPromotions), and the manual
// add-context tool (project-manage). The dashboard (app/, a separate module — C-10)
// re-states the same rule in TypeScript rather than importing this.

// A context key is a stable, human-meaningful slug for a durable resource.
const SEMANTIC_KEY = /^[a-z][a-z0-9_-]{2,63}$/i;

// Keys whose very name marks them as the wrong layer: a moment-in-time snapshot, a
// remembered failure, a specific mission instance, or an embedded plan/task. These are
// history/particulars/process-steps — not 40k-ft working-area facts.
const OFF_LAYER_KEY = /(^|[_-])(state|history|failure|failures|failure[_-]?mode|repo[_-]?state|log|logs|snapshot|attempt|attempts|debug|todo|task|tasks|step|steps|plan[_-]?file|workflow|procedure|process)([_-]|$)/i;

// A durable resource reference: an object carrying a kind and at least one pointer or
// human summary. Convention/summary-only packets are allowed (a durable working
// convention is a legitimate 40k-ft fact); bare non-object values are not.
const RESOURCE_KINDS = new Set([
  'drive_folder', 'doc', 'sheet', 'slides', 'url', 'repo', 'git', 'resource', 'convention',
]);

// Hard cap on curated keys — a Project's context is a curated map, not a mission ledger.
// A project pushing past this is accumulating particulars; the write is rejected so the
// operator/prime curates instead of the map growing without bound.
export const MAX_CONTEXT_KEYS = 24;

function isEmptyEntry(v) {
  return v == null
    || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
    || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validate a single project-context entry against the layer-purity rule.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateContextEntry(key, value) {
  if (!SEMANTIC_KEY.test(key)) return { ok: false, reason: 'key is not a semantic slug' };
  if (OFF_LAYER_KEY.test(key)) return { ok: false, reason: 'key names history/state/particulars/process — belongs in the Mission record or a Process, not project context' };
  if (isEmptyEntry(value)) return { ok: false, reason: 'empty entry' };
  // Value must be a durable resource-reference packet.
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'value must be a resource packet {kind, ref|url|summary}, not a bare scalar/array' };
  }
  const kind = value.kind;
  const hasPointer = value.ref || value.url || value.summary;
  if (!kind || !RESOURCE_KINDS.has(kind)) {
    return { ok: false, reason: `kind must be one of ${[...RESOURCE_KINDS].join('|')}` };
  }
  if (!hasPointer) return { ok: false, reason: 'packet needs a ref, url, or summary' };
  return { ok: true };
}

/**
 * Filter a context map to only conforming entries, and enforce the key cap.
 * Returns the cleaned map plus a list of dropped keys with reasons (for logging).
 * @returns {{ context: object, dropped: Array<{key: string, reason: string}> }}
 */
export function filterProjectContext(contextMap) {
  const context = {};
  const dropped = [];
  for (const [k, v] of Object.entries(contextMap || {})) {
    const { ok, reason } = validateContextEntry(k, v);
    if (ok) context[k] = v; else dropped.push({ key: k, reason });
  }
  // Enforce the cap deterministically (drop the lexically-last extras so the result is
  // stable across runs — the operator curates which to keep).
  const keys = Object.keys(context);
  if (keys.length > MAX_CONTEXT_KEYS) {
    for (const k of keys.sort().slice(MAX_CONTEXT_KEYS)) {
      dropped.push({ key: k, reason: `exceeds MAX_CONTEXT_KEYS(${MAX_CONTEXT_KEYS})` });
      delete context[k];
    }
  }
  return { context, dropped };
}

