// corekit/lib/work-recall.mjs — Episodic retrieval for work envelopes
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

  const statusMap = { complete: 1.0, blocked: 0.6, failed: 0.6 };
  const statusWeight = statusMap[envelope.status] ?? 0.4;

  const typeMap = { M: 1.0, R: 0.8, C: 0.7 };
  const typeWeight = typeMap[envelope.type] ?? 0.5;

  return termScore * (0.6 + 0.4 * recencyScore) * statusWeight * typeWeight;
}

// ── searchWork ──────────────────────────────────────────────────────
// Indexed owner + status query via firestoreQuery. Client-side filter
// on created_at window and types. Score, rank, return top limit.

export async function searchWork({ firestoreQuery, owner, cues, sinceDays = 30, statuses = ['complete'], types, limit = 6 }) {
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

  // Client-side filters: created_at window, type match
  allDocs = allDocs.filter(d => {
    if (d.created_at && new Date(d.created_at) < cutoff) return false;
    if (types && !types.includes(d.type)) return false;
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
// Completed work in window, grouped by day and compacted.

export async function recentWorkDigest({ firestoreQuery, owner, sinceDays = 7, limit = 50 }) {
  const filters = [
    { field: 'owner', op: 'EQUAL', value: { stringValue: owner } },
    { field: 'status', op: 'EQUAL', value: { stringValue: 'complete' } },
  ];
  const docs = await firestoreQuery('work', filters);
  if (!docs || docs.length === 0) return `## Work Completed (Last ${sinceDays} Days)\n\nNo completed work found.`;

  const cutoff = new Date(Date.now() - sinceDays * 86400000);
  const recent = docs
    .filter(d => d.completed_at && new Date(d.completed_at) >= cutoff)
    .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
    .slice(0, limit);

  if (recent.length === 0) return `## Work Completed (Last ${sinceDays} Days)\n\nNo completed work found.`;

  // Group by day
  const groups = {};
  for (const d of recent) {
    const day = new Date(d.completed_at).toISOString().slice(0, 10);
    if (!groups[day]) groups[day] = [];
    const blurb = (d.output || '').substring(0, 200);
    groups[day].push(`- [${d.type || '?'}] ${d.title || 'Untitled'} — ${blurb} (${d.completed_at})`);
  }

  const lines = [`## Work Completed (Last ${sinceDays} Days)`];
  for (const day of Object.keys(groups).sort().reverse()) {
    lines.push(`### ${day}`);
    lines.push(...groups[day]);
  }
  return lines.join('\n');
}
