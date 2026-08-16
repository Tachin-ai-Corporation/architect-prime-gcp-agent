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
const DEFAULT_MINPROSE = 240;  // tool-agent prose below this → the tool results are the answer, digest them

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

// The prose an agent writes OUTSIDE its [TOOL EXECUTION LOG] block — the answer for most
// tool-agent results (an edit confirmation, an audit verdict). Returned trimmed.
function proseOutsideToolLog(text) {
  return String(text || '').replace(/\[TOOL EXECUTION LOG\][\s\S]*?(?:\[END TOOL LOG\]|$)/g, '').trim();
}

// Digest the [TOOL EXECUTION LOG] into its RESULTS, packed into `budget`. Each entry is
// `[TOOL] name(args) → result` (loop.mjs; result already ~500-capped). When the tool results
// ARE the answer — a discovery mission enumerating data, where the prose outside the log is
// thin — these must be kept, not elided to a marker. Splits per call, drops the args noise,
// keeps the head of each result (a listing's columns + first rows), fair-shares the budget.
// Pure and deterministic. Returns '' when there is nothing to digest.
export function digestToolResults(text, budget) {
  const block = (String(text || '').match(/\[TOOL EXECUTION LOG\]([\s\S]*?)(?:\[END TOOL LOG\]|$)/) || [])[1] || '';
  if (!block.trim() || budget < 48) return '';
  // Split BEFORE each `[TOOL] ` marker (lookahead) so a multi-line result stays with its call.
  const entries = block.split(/(?=\[TOOL\]\s)/).map(s => s.trim()).filter(s => s.startsWith('[TOOL]'));
  if (entries.length === 0) return '';
  const per = Math.max(48, Math.floor(budget / entries.length));
  const lines = entries.map((e) => {
    const body = e.replace(/^\[TOOL\]\s*/, '');
    const arrow = body.indexOf('→');
    const name = (arrow >= 0 ? body.slice(0, arrow) : body).split('(')[0].trim().slice(0, 48);
    const result = (arrow >= 0 ? body.slice(arrow + 1) : '').trim();
    const shown = result.length > per ? result.slice(0, per - 1).trimEnd() + '…' : (result || '(no output)');
    return `• ${name}: ${shown}`;
  });
  const out = lines.join('\n');
  return out.length > budget ? clip(out, budget) : out;
}

// Summarize a tool-agent result for an organ's decide/plan delta. Two shapes:
//  - substantial prose  → keep it, elide the log to a one-line marker (economy, the answer
//    is the prose — an edit/audit verdict). This is the common, unchanged case.
//  - thin prose         → the tool RESULTS are the answer; digest them into the budget.
// The defect this fixes: a read-only discovery mission's output is almost all tool log with
// negligible prose, so the old unconditional elision collapsed a 2.6KB result to a 53-char
// "[tool log elided]" marker — Cortex saw NO data, could not synthesize, and re-planned to
// re-observe a result it already had (52 calls / 1.4M tokens on one live mission).
function summarizeToolAgent(text, budget, minProse) {
  const t = String(text);
  const prose = proseOutsideToolLog(t);
  const toolCount = (t.match(/\[TOOL\]/g) || []).length;
  if (toolCount === 0) return prose.length > budget ? clip(prose, budget) : prose;
  if (prose.length >= minProse) {
    const body = `${prose}${prose ? '\n' : ''}[tool log elided: ${toolCount} tool call(s) — full at ref]`;
    return body.length > budget ? clip(body, budget) : body;
  }
  const header = prose ? `${prose}\n` : '';
  const label = `${toolCount} tool call(s) — result digest (full at ref):`;
  const digest = digestToolResults(t, Math.max(48, budget - header.length - label.length - 2));
  const body = digest ? `${header}${label}\n${digest}` : `${header}[tool log — ${toolCount} call(s), full at ref]`;
  return body.length > budget ? clip(body, budget) : body;
}

// Pack multiple task outputs into a bounded evidence string for the VERIFIER, keeping each
// task's tool RESULTS. B-28 verification re-derives from the tool outputs, so a head+tail
// smartTruncate (which drops the MIDDLE, where a command's result sits) is the wrong reducer
// — one live mission FAILed "no gcloud command was executed" for a command that ran but was
// truncated out of view. Each item is {step, agent, output}; each gets a fair share of the
// budget, shape-reduced (tool-agent → prose + result digest; else clipped). Pure.
export function packToolEvidence(items, budget) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (list.length === 0 || budget < 80) return '';
  const per = Math.max(160, Math.floor(budget / list.length));
  const blocks = list.map((it) => {
    const head = `- [${it.step}] ${it.agent}:`;
    const out = String(it.output || '');
    let reduced;
    if (detectShape(out) === 'tool-agent') {
      const prose = proseOutsideToolLog(out);
      const digest = digestToolResults(out, Math.max(96, per - prose.length - head.length));
      reduced = [prose, digest].filter(Boolean).join('\n') || out.slice(0, per);
    } else {
      reduced = out.length > per ? clip(out, per) : out;
    }
    return `${head} ${reduced}`;
  });
  const joined = blocks.join('\n');
  return joined.length > budget ? clip(joined, budget) : joined;
}

// Shape-aware summary of a result. Deterministic; safe on any string.
export function summarizeResult(text, { budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK, minProse = DEFAULT_MINPROSE } = {}) {
  const t = String(text || '');
  const shape = detectShape(t);
  if (shape === 'json-list') return summarizeList(t, topK, budget);
  if (shape === 'tool-agent') return summarizeToolAgent(t, budget, minProse);
  return clip(t, budget);
}

// Build the inter-organ packet: {kind, summary, ref, bytes, shape}. `kind` is always
// 'organ_result' here; `ref` is the caller's stable handle to the full artifact (a task
// envelope id the daemon can firestoreRead, or a file path) — null when there is none.
export function buildResultPacket({ text, ref = null, budget = DEFAULT_BUDGET, topK = DEFAULT_TOPK, minProse = DEFAULT_MINPROSE } = {}) {
  const t = String(text || '');
  return {
    kind: 'organ_result',
    summary: summarizeResult(t, { budget, topK, minProse }),
    ref,
    bytes: t.length,
    shape: detectShape(t),
  };
}
