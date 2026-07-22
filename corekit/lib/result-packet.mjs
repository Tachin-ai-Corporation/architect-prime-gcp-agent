// result-packet.mjs — inter-organ result packets (ORGAN_CONTEXT_SHARING_PLAN, Phase 1)
//
// One organ's output crosses to another as a resource packet — a bounded, shape-aware
// SUMMARY plus a REF to the full artifact — never a blind character clip. This is the
// C-28 {kind, ref, summary} shape, extended from ProjectContext/context-promotion to
// inter-organ results. Economy is preserved (the summary stays in-prompt, B-4); the full
// content is fetched by ref only on demand (Phase 2 hydration).
//
// The defect this replaces: the daemon fed Cortex `smartTruncate(result, 2000)`, which
// keeps head+tail and drops the MIDDLE — exactly where a list's rows or a tool log's data
// live. Cortex saw "the first item" then nothing, judged the result incomplete, and
// re-dispatched. A shape-aware summary keeps the answer, not an arbitrary slice.
//
// Pure module — no I/O, no contracts read, no side effects (B-18/B-19). Deterministic.

const DEFAULT_BUDGET = 1200;   // chars for the summary body
const DEFAULT_TOPK = 8;        // list items rendered before eliding the tail

// Head+tail clip with a middle marker — the last-resort shape for opaque prose. Kept local
// so this core has zero imports and is trivially unit-testable.
function clip(text, budget) {
  const t = String(text || '');
  if (t.length <= budget) return t;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return t.slice(0, head) + `\n…[${t.length - budget} chars elided — full content at ref]…\n` + t.slice(t.length - tail);
}

// Find the primary array inside a parsed JSON value: the value itself if it's an array,
// else the first array-valued property (files/items/results/… — the common list wrappers).
function primaryArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of ['files', 'items', 'results', 'entries', 'rows', 'data', 'messages', 'events']) {
      if (Array.isArray(v[k])) return v[k];
    }
    for (const val of Object.values(v)) if (Array.isArray(val)) return val;
  }
  return null;
}

// Classify the result so we summarize it the way it's actually shaped.
export function detectShape(text) {
  const t = String(text || '');
  if (/\[TOOL EXECUTION LOG\]/.test(t)) return 'tool-agent';
  const trimmed = t.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      if (primaryArray(JSON.parse(trimmed)) !== null) return 'json-list';
    } catch { /* not clean JSON — fall through */ }
  }
  return 'text';
}

// One compact line per list item — prefer human-meaningful identity fields, fall back to a
// bounded JSON of the whole item.
function renderItem(it) {
  if (it && typeof it === 'object') {
    const id = it.id || it.fileId || it.name || '';
    const label = it.name || it.title || it.subject || '';
    const extra = it.shared || it.modified || it.type || it.owner || '';
    const parts = [label && `"${label}"`, id && id !== label && `id=${id}`, extra && String(extra)].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    return clip(JSON.stringify(it), 160);
  }
  return clip(String(it), 160);
}

function summarizeList(text, topK, budget) {
  let arr;
  try { arr = primaryArray(JSON.parse(text.trim())); } catch { arr = null; }
  if (!arr) return clip(text, budget);
  const shown = arr.slice(0, topK).map((it, i) => `${i + 1}. ${renderItem(it)}`);
  const more = arr.length > topK ? `\n…(+${arr.length - topK} more — full list at ref)` : '';
  const body = `${arr.length} item(s):\n${shown.join('\n')}${more}`;
  // A list summary is already compact; only clip if a few wide rows blew the budget.
  return body.length > budget ? clip(body, budget) : body;
}

// Elide the verbose [TOOL EXECUTION LOG] block (keep a one-line marker with the tool count)
// and keep the organ's prose answer — the part Cortex actually reasons over.
function summarizeToolAgent(text, budget) {
  const elided = String(text).replace(
    /\[TOOL EXECUTION LOG\][\s\S]*?(\[END TOOL LOG\]|$)/g,
    (m) => `[tool log elided: ${(m.match(/\[TOOL\]/g) || []).length} tool call(s) — full at ref]`
  );
  return elided.length > budget ? clip(elided, budget) : elided;
}

// Shape-aware summary of a result. Deterministic; safe on any string.
export function summarizeResult(text, { budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK } = {}) {
  const t = String(text || '');
  const shape = detectShape(t);
  if (shape === 'json-list') return summarizeList(t, topK, budget);
  if (shape === 'tool-agent') return summarizeToolAgent(t, budget);
  return clip(t, budget);
}

// Build the inter-organ packet: {kind, summary, ref, bytes, shape}. `kind` is always
// 'organ_result' here; `ref` is the caller's stable handle to the full artifact (a task
// envelope id the daemon can firestoreRead, or a file path) — null when there is none.
export function buildResultPacket({ text, ref = null, budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK } = {}) {
  const t = String(text || '');
  return {
    kind: 'organ_result',
    summary: summarizeResult(t, { budget, topK }),
    ref,
    bytes: t.length,
    shape: detectShape(t),
  };
}
