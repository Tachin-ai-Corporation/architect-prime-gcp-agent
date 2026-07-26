// resource-ledger.mjs — durable name→id memory for external resources (RESOURCE_LEDGER_PLAN)
//
// An external identifier — a Drive folder id, a doc id, a chat space — is a fact
// about the world that does not change. Re-deriving one by API search is pure
// waste, and the waste is not small: a mission once spent its entire 300s
// dispatch budget re-running the same `drive-search` six times for a folder it
// had already located two iterations earlier, because the plan called it "signed
// artifacts" while Drive calls it "Executed Advisory Agreements".
//
// Capture is DETERMINISTIC (C-4/C-5): identifiers come from the structured JSON
// the Drive/Docs skills already emit, never from prose and never from an LLM.
// This module is pure — no I/O, no clock, no randomness (B-19) — so the caller
// supplies `now`. Surfacing is memory's job: temporal-memory consumes the ledger
// as a recall candidate and decides what the brain sees.

/** Drive/Docs ids are long opaque strings; anything shorter is not an id. */
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Google Chat spaces are addressed by resource name, not a bare id. */
const SPACE_RE = /^spaces\/[A-Za-z0-9_-]{4,}$/;

/** Keys a tool may use for the identifier, in preference order. */
const ID_KEYS = ['docId', 'fileId', 'folderId', 'id', 'spaceId'];

/** mimeType / short-type → ledger kind. Short types come from drive-ls/search. */
const KIND_BY_TYPE = {
  folder: 'folder',
  'application/vnd.google-apps.folder': 'folder',
  doc: 'doc',
  document: 'doc',
  'application/vnd.google-apps.document': 'doc',
  sheet: 'sheet',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  slides: 'slides',
  'application/vnd.google-apps.presentation': 'slides',
  pdf: 'pdf',
  'application/pdf': 'pdf',
  form: 'form',
  drawing: 'drawing',
};

/**
 * Normalize a resource name into a stable ledger key. Case- and
 * punctuation-insensitive so "Master Templates", "master templates" and
 * "master-templates" collapse to one entry. Deliberately does NOT resolve
 * aliases (a different name IS a different key) — alias merging is a judgment
 * call that belongs to consolidation, not to capture.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')      // drop a file extension
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Ledger key for an entry. */
export function resourceKey(kind, name) {
  return `${kind}:${normalizeName(name)}`;
}

function kindFor(node) {
  const t = node.type || node.mimeType || '';
  if (KIND_BY_TYPE[t]) return KIND_BY_TYPE[t];
  if (typeof t === 'string' && t.startsWith('image/')) return 'image';
  if (node.docId) return 'doc';
  if (node.spaceId || SPACE_RE.test(String(node.name || ''))) return 'space';
  return 'file';
}

/**
 * Pull every {id, name} pair out of one parsed JSON value, recursively.
 * Handles the three shapes the skills emit: a `files[]` listing, a single
 * created/copied/converted object, and — importantly — a nested string that is
 * itself JSON, which is how tool results actually arrive
 * (`{"runCommand_response":{"result":"{\"status\":\"downloaded\",...}"}}`).
 *
 * @param {*} node
 * @param {Array} out
 * @param {number} depth
 */
function walk(node, out, depth = 0) {
  if (depth > 8 || node == null) return;

  if (typeof node === 'string') {
    // A nested JSON payload smuggled through as a string.
    const s = node.trim();
    if ((s.startsWith('{') || s.startsWith('[')) && s.length < 200_000) {
      try { walk(JSON.parse(s), out, depth + 1); } catch { /* not JSON — ignore */ }
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const el of node) walk(el, out, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  // Does this object itself name a resource?
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (name) {
    for (const k of ID_KEYS) {
      const raw = node[k];
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (!id) continue;
      if (!ID_RE.test(id) && !SPACE_RE.test(id)) continue;
      out.push({ kind: kindFor(node), name, id });
      break;                                   // one id per object
    }
  }

  for (const v of Object.values(node)) walk(v, out, depth + 1);
}

/**
 * Extract resource identifiers from arbitrary tool output text.
 *
 * Tolerant by design: the text is a motor transcript containing JSON in fences,
 * JSON nested inside escaped strings, and prose in between. Anything that does
 * not parse is skipped silently — a miss costs one redundant search, whereas a
 * throw would break the task that produced real work.
 *
 * @param {string} text - raw tool/task output
 * @returns {Array<{kind: string, name: string, id: string}>} de-duplicated by key+id
 */
export function extractResources(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];

  const found = [];
  for (const candidate of scanJsonCandidates(s)) {
    try { walk(JSON.parse(candidate), found, 0); } catch { /* not JSON */ }
  }

  // Escaped-JSON fallback: some transports deliver \"-escaped payloads whose
  // outer wrapper never parses. Unescape once and re-scan rather than lose them.
  if (found.length === 0 && s.includes('\\"')) {
    const unescaped = s.replace(/\\"/g, '"');
    for (const candidate of scanJsonCandidates(unescaped)) {
      try { walk(JSON.parse(candidate), found, 0); } catch { /* ignore */ }
    }
  }

  const seen = new Set();
  const out = [];
  for (const r of found) {
    const dedup = `${resourceKey(r.kind, r.name)}|${r.id}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(r);
  }
  return out;
}

/**
 * Find balanced {...} / [...] substrings. A brace counter beats a regex here
 * because the payloads nest and a greedy/lazy pattern gets either too much or
 * too little.
 *
 * @param {string} s
 * @returns {string[]}
 */
function scanJsonCandidates(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;                                // resume after this block
          break;
        }
      }
      if (j - i > 400_000) break;               // pathological input guard
    }
  }
  return out;
}

/**
 * Merge freshly-extracted resources into the existing ledger.
 *
 * First-write-wins on the key, but a CHANGED id updates in place and records
 * the previous value — a renamed or replaced folder must not silently keep
 * resolving to a dead id. Order-independent and idempotent: merging the same
 * batch twice yields the same ledger.
 *
 * @param {Object} existing - current ledger, keyed by resourceKey()
 * @param {Array<{kind,name,id}>} found - output of extractResources()
 * @param {Object} [opts]
 * @param {number} [opts.max=200] - hard cap; oldest entries are kept, new ones dropped
 * @param {string} [opts.now] - ISO timestamp supplied by the caller (purity)
 * @param {string} [opts.source] - provenance, e.g. a step id
 * @returns {{ledger: Object, added: number, updated: number, dropped: number}}
 */
export function mergeResources(existing, found, opts = {}) {
  const max = opts.max ?? 200;
  const now = opts.now || '';
  const source = opts.source || '';
  const ledger = { ...(existing || {}) };
  let added = 0, updated = 0, dropped = 0;

  for (const r of found || []) {
    if (!r || !r.id || !r.name) continue;
    const key = resourceKey(r.kind, r.name);
    const prior = ledger[key];

    if (!prior) {
      if (Object.keys(ledger).length >= max) { dropped++; continue; }
      ledger[key] = { kind: r.kind, name: r.name, id: r.id, first_seen: now, source };
      added++;
      continue;
    }
    if (prior.id !== r.id) {
      ledger[key] = {
        ...prior,
        id: r.id,
        previous_id: prior.id,
        name: r.name,                  // keep the freshest spelling
        updated_at: now,
        source: source || prior.source,
      };
      updated++;
    }
  }
  return { ledger, added, updated, dropped };
}

/**
 * Render the ledger as the compact block memory hands to temporal-memory.
 * One line per resource so an id is never wrapped or truncated mid-token.
 *
 * @param {Object} ledger
 * @param {Object} [opts]
 * @param {number} [opts.limit=40]
 * @param {string[]} [opts.cues] - when present, prefer entries matching a cue
 * @returns {string} markdown block, or '' when the ledger is empty
 */
export function renderResources(ledger, opts = {}) {
  const limit = opts.limit ?? 40;
  const cues = (opts.cues || []).map(c => String(c).toLowerCase()).filter(Boolean);
  let rows = Object.entries(ledger || {}).map(([key, v]) => ({ key, ...v }));
  if (rows.length === 0) return '';

  if (cues.length > 0) {
    // Cue-matching entries first; the rest still ride along (the ledger is small
    // and a near-miss cue must not hide the id the task actually needs).
    const score = r => {
      const hay = `${r.name} ${r.kind}`.toLowerCase();
      return cues.reduce((n, c) => n + (hay.includes(c) ? 1 : 0), 0);
    };
    rows.sort((a, b) => score(b) - score(a));
  }

  const lines = rows.slice(0, limit).map(r =>
    `- ${r.kind}: "${r.name}" = ${r.id}${r.previous_id ? ` (was ${r.previous_id})` : ''}`
  );
  const more = rows.length > limit ? `\n- …${rows.length - limit} more` : '';
  return `## Known Resources (already resolved — do NOT search for these again)\n${lines.join('\n')}${more}`;
}
