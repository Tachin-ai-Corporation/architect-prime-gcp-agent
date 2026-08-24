// platform/work/work-recall.mjs — Episodic retrieval for work envelopes
//
// Pure ES module. All functions exported. firestoreQuery injected at call site.

const MAX_CUES = 8;
const HALF_LIFE_DAYS = 30;
const RELEVANCE_FLOOR = 0.15;
const CANDIDATE_BUDGET_CHARS = 8000;
const STOPWORDS = new Set(['the','and','for','are','but','not','you','all','can','had','her','was','one','our','out','has','its','let','say','she','too','use','way','who','how','now','old','see','get','did','may','new','any','few','got','own','man','big','end','put','run','try','his','him','ask','ago','off','yet','set','yes','sir','mrs','per','cup','bit','art','arm','bag','bed','bet','box','bus','cut','sir','due','ear','eat','egg','era','etc','eye','far','fat','fee','fit','fly','fun','gap','gas','gut','hat','hey','hip','hit','ice','ill','jam','jet','joy','key','kid','lab','lap','law','lay','led','leg','lip','log','lot','map','mix','net','nor','nut','odd','oil','pad','pan','pay','pen','pet','pie','pin','pit','pot','pub','raw','ray','red','rid','rod','row','rub','rug','sad','mud','tea','ten','tie','tin','tip','toe','top','toy','van','via','war','wet','win','won','zoo','also','been','come','does','done','each','even','fact','find','from','give','good','have','help','here','high','just','keep','know','last','left','life','like','line','long','look','made','make','many','more','most','much','must','name','need','next','only','over','part','plan','play','said','same','show','side','some','such','sure','take','tell','than','that','them','then','they','this','time','turn','upon','used','very','want','well','went','were','what','when','will','with','word','work','year','your']);

// ── extractCues ─────────────────────────────────────────────────────
// Pure. Lowercase, tokenize on non-alphanumerics, drop stopwords and
// tokens < 3 chars, keep distinct unigrams + adjacent bigrams, cap at MAX_CUES.

export function extractCues(text) {
  if (!text) return [];
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const cues = new Set(tokens);
  for (let i = 0; i < tokens.length - 1; i++) cues.add(`${tokens[i]} ${tokens[i + 1]}`);
  return [...cues].slice(0, MAX_CUES);
}

// ── scoreRelevance ──────────────────────────────────────────────────
// Pure. Score = termScore × (0.6 + 0.4 × recencyScore) × statusWeight × typeWeight

export function scoreRelevance(envelope, cues) {
  if (!cues || cues.length === 0) return 0;
  const blob = `${envelope.title || ''} ${envelope.instruction || ''} ${envelope.output || ''}`.toLowerCase();
  const overlap = cues.filter(c => blob.includes(c)).length;
  const termScore = overlap / cues.length;

  const created = envelope.created_at ? new Date(envelope.created_at) : new Date();
  const ageDays = Math.max(0, (Date.now() - created.getTime()) / 86400000);
  const recencyScore = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);

  const statusMap = { complete: 1.0, queued: 0.8, blocked: 0.6, failed: 0.6 };
  const statusWeight = statusMap[envelope.status] ?? 0.4;

  const typeMap = { M: 1.0, R: 0.8, C: 0.7 };
  const typeWeight = typeMap[envelope.type] ?? 0.5;

  return termScore * (0.6 + 0.4 * recencyScore) * statusWeight * typeWeight;
}

// ── searchWork ──────────────────────────────────────────────────────
// Indexed owner + status query via firestoreQuery. Client-side filter
// on created_at window and types. Score, rank, return top limit.

export async function searchWork({ firestoreQuery, owner, primeId, cues, sinceDays = 30, statuses = ['complete', 'active', 'queued', 'failed', 'blocked', 'needs_input'], types, limit = 6 }) {
  const cutoff = new Date(Date.now() - sinceDays * 86400000);
  let allDocs = [];

  for (const status of statuses) {
    const filters = [
      { field: 'owner', op: 'EQUAL', value: { stringValue: owner } },
      { field: 'status', op: 'EQUAL', value: { stringValue: status } },
    ];
    const docs = await firestoreQuery('work', filters);
    if (docs) allDocs.push(...docs);
  }

  // Client-side filters: created_at window, type match, own-prime scope.
  allDocs = allDocs.filter(d => {
    if (d.created_at && new Date(d.created_at) < cutoff) return false;
    if (types && !types.includes(d.type)) return false;
    // Own-prime scope (C-1): a prime's ambient recall is its OWN experience. Every
    // prime stamps the same owner ("prime", lacking an email identity), so without
    // this a prime recalls other primes' missions as its own — the identity
    // cross-population where a fresh prime "remembered" another's fleet. prime_id is
    // stamped on every work doc; filter client-side so no composite index is needed.
    if (primeId && d.prime_id && d.prime_id !== primeId) return false;
    return true;
  });

  // Score, drop below floor, rank descending
  const hits = [];
  let charBudget = CANDIDATE_BUDGET_CHARS;

  for (const d of allDocs) {
    const score = scoreRelevance(d, cues);
    if (score < RELEVANCE_FLOOR) continue;
    const matchedCues = cues.filter(c =>
      `${d.title || ''} ${d.instruction || ''} ${d.output || ''}`.toLowerCase().includes(c)
    );
    hits.push({
      id: d.id,
      type: d.type,
      title: d.title,
      instruction_blurb: (d.instruction || '').substring(0, 200),
      output_blurb: (d.output || '').substring(0, 200),
      status: d.status,
      created_at: d.created_at,
      completed_at: d.completed_at,
      score,
      matched_cues: matchedCues,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ── recentWorkDigest ────────────────────────────────────────────────
// Recent work in window across ALL terminal outcomes (not just complete),
// grouped by day and compacted. Failures/blocks carry the most learning, so
// they are included with an outcome marker and a why-blurb (output||error),
// each citing its id so recall can point at a specific mission.

const DIGEST_STATUSES = ['complete', 'failed', 'blocked', 'needs_input', 'cancelled'];
const OUTCOME_MARK = { complete: '[done]', failed: '[FAILED]', blocked: '[blocked]', needs_input: '[needs-input]', cancelled: '[cancelled]' };
const digestTs = d => d.completed_at || d.updated_at || d.created_at || '';

export async function recentWorkDigest({ firestoreQuery, owner, primeId, sinceDays = 7, limit = 50, statuses = DIGEST_STATUSES, types = ['M', 'R'] }) {
  const seen = new Map();
  for (const status of statuses) {
    const filters = [
      { field: 'owner', op: 'EQUAL', value: { stringValue: owner } },
      { field: 'status', op: 'EQUAL', value: { stringValue: status } },
    ];
    const docs = await firestoreQuery('work', filters);
    if (docs) for (const d of docs) if (d && d.id) seen.set(d.id, d);
  }
  const header = `## Recent Work (Last ${sinceDays} Days) — includes outcomes`;
  const empty = `${header}\n\nNo recent work found.`;
  if (seen.size === 0) return empty;

  // Recall is holistic-but-lean (B-4): keep top-level work units (missions,
  // responsibilities), whose output/error IS the outcome summary. Per-task
  // (C/T) detail is for deliberate investigation via work-log-read, not ambient recall.
  const cutoff = new Date(Date.now() - sinceDays * 86400000);
  const recent = [...seen.values()]
    .filter(d => types.includes(d.type))
    // Own-prime scope (C-1) — see searchWork: keeps a prime's recent-work digest to
    // its own missions, not the union of every prime that shares owner "prime".
    .filter(d => !(primeId && d.prime_id && d.prime_id !== primeId))
    .filter(d => { const t = digestTs(d); return t && new Date(t) >= cutoff; })
    .sort((a, b) => new Date(digestTs(b)) - new Date(digestTs(a)))
    .slice(0, limit);
  if (recent.length === 0) return empty;

  // Group by day
  const groups = {};
  for (const d of recent) {
    const day = new Date(digestTs(d)).toISOString().slice(0, 10);
    if (!groups[day]) groups[day] = [];
    const mark = OUTCOME_MARK[d.status] || `[${d.status || '?'}]`;
    const blurb = (d.output || d.error || '').substring(0, 220).replace(/\s+/g, ' ').trim();
    groups[day].push(`- ${mark} [${d.type || '?'}] ${d.title || 'Untitled'} (id:${d.id})${blurb ? ` — ${blurb}` : ''}`);
  }

  const lines = [header];
  for (const day of Object.keys(groups).sort().reverse()) {
    lines.push(`### ${day}`);
    lines.push(...groups[day]);
  }
  return lines.join('\n');
}

// ── getWorkOutput ───────────────────────────────────────────────
// Direct document read for deterministic recovery of truncated outputs.

export async function getWorkOutput(id, { firestoreRead }) {
  if (!id || !firestoreRead) return null;
  const doc = await firestoreRead('work', id);
  if (!doc) return null;
  return {
    id: doc.id,
    status: doc.status,
    type: doc.type,
    title: doc.title || null,
    output: doc.output || null,
    output_chars: (doc.output || '').length,
    accept_criteria: doc.accept_criteria || null,
    created_at: doc.created_at || null,
    completed_at: doc.completed_at || null,
    project_id: doc.project_id || null,
  };
}
