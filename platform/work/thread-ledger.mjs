// platform/work/thread-ledger.mjs — thread-keyed conversation ledger (B-32, SESSION_CONTEXT_PLAN Phase 4)
//
// A prime-scoped, REBUILDABLE Firestore cache of each conversation thread,
// keyed on (channel, thread). Written idempotently by the deterministic
// daemons at exactly three seams — brain at intake claim, ears as GChat page
// backfill, mouth at delivery — and read by classify assembly and delivery
// voicing. Never authored, fetched, or queried by a cognitive organ.
//
// Every consumer degrades to today's exact assembly (intake conversation_ctx,
// assembleConversation, envelope snapshot) when the ledger is missing or
// unreadable — losing it costs coverage, never correctness (B-22).
//
// Storage:
//   primes/{primeId}/threads/{threadKey}                    (thread doc)
//   primes/{primeId}/threads/{threadKey}/turns/{turnId}     (turn docs)
//
// Turn identity is the CHANNEL's message identity (GChat message resource
// name, dashboard message doc id, envelope id for deliveries) so every
// writer's retry path is a replay-safe upsert. Counters are derived at read
// time — three separate daemon processes write here and read-modify-write
// counters would drift.

import { toStr } from '../providers/to-str.mjs';
import { smartTruncate } from '../providers/vertex-text.mjs';
import { redactSecrets } from '../context/compaction.mjs';

const DEFAULTS = {
  max_turns: 12,
  budget_chars: 6000,
  per_turn_chars: 600,
  turn_store_chars: 8000,
  summary_max_chars: 1200,
  compact_after_turns: 30,
};

// GChat resource names ('spaces/AAA/threads/BBB') are case-sensitive with the
// [A-Za-z0-9_-] alphabet plus '/'. Encoding preserves case (lowercasing could
// collide two distinct threads — the worst failure for a context source) and
// maps '/' to '~', which Firestore doc ids allow and the alphabet excludes.
export function encodeResourceName(name) {
  return String(name || '').replace(/\//g, '~').replace(/[^A-Za-z0-9_~.-]/g, '_');
}

/**
 * Derive the deterministic thread key for an address. Pure.
 * @param {object|null} address  {channel, space?, thread?} (decoded form)
 * @param {string} primeId
 * @returns {string|null} threadKey, or null when unkeyable
 */
export function threadKeyFor(address, primeId) {
  if (!address || !address.channel) return null;
  if (address.channel === 'gchat') {
    const ref = address.thread || address.space;
    return ref ? `gchat-${encodeResourceName(ref)}` : null;
  }
  // Dashboard: one live operator thread per prime (fleet dashboard chat is
  // read-only per C-26 — no fleet dashboard ledgers exist).
  return primeId ? `dash-${primeId}` : null;
}

function threadDocPath(primeId, threadKey) {
  return `primes/${primeId}/threads/${threadKey}`;
}

/**
 * Idempotently upsert one turn (PATCH = upsert on a deterministic doc id).
 * Text is capped and secret-scrubbed before persisting (C-8) — as is every
 * denormalized copy on the thread doc.
 */
export async function appendTurn({
  projectId, primeId, getToken,
  threadKey, turnId, role, text, source = 'intake',
  channelMeta = {}, config = {}, log = () => {},
}) {
  if (!projectId || !primeId || !threadKey || !turnId || !text) return false;
  const cfg = { ...DEFAULTS, ...config };
  const token = await getToken();
  if (!token) return false;

  const clean = redactSecrets(smartTruncate(toStr(text), cfg.turn_store_chars));
  const ts = new Date().toISOString();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const safeTurnId = encodeResourceName(turnId);

  const turnBody = { fields: {
    role: { stringValue: role === 'admin' ? 'admin' : 'prime' },
    text: { stringValue: clean },
    ts: { timestampValue: ts },
    source: { stringValue: source },
  } };
  const docBody = { fields: {
    channel: { stringValue: channelMeta.channel || (threadKey.startsWith('gchat-') ? 'gchat' : 'dashboard') },
    ...(channelMeta.space ? { space: { stringValue: channelMeta.space } } : {}),
    ...(channelMeta.thread ? { thread: { stringValue: channelMeta.thread } } : {}),
    updated_at: { timestampValue: ts },
  } };

  try {
    const turnRes = await fetch(`${base}/${threadDocPath(primeId, threadKey)}/turns/${safeTurnId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(turnBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!turnRes.ok) {
      log('WARN', `thread-ledger: turn upsert HTTP ${turnRes.status} (${threadKey}/${safeTurnId})`);
      return false;
    }
    // Thread-doc metadata: field-masked so concurrent writers can't clobber
    // each other (and no counters live here).
    const mask = Object.keys(docBody.fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
    await fetch(`${base}/${threadDocPath(primeId, threadKey)}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(docBody),
      signal: AbortSignal.timeout(8000),
    });
    return true;
  } catch (e) {
    log('WARN', `thread-ledger: appendTurn failed (${threadKey}): ${e.message}`);
    return false;
  }
}

/**
 * Read and render a thread — the same shape assembleConversation returns, so
 * consumers switch sources without call-site changes. Returns null when the
 * ledger has nothing (callers fall back to today's assembly).
 */
export async function readThread({
  projectId, primeId, getToken, threadKey, config = {}, log = () => {},
}) {
  if (!projectId || !primeId || !threadKey) return null;
  const cfg = { ...DEFAULTS, ...config };
  const token = await getToken();
  if (!token) return null;

  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  let rows;
  let summary = '';
  try {
    const docRes = await fetch(`${base}/${threadDocPath(primeId, threadKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (docRes.ok) {
      const doc = await docRes.json();
      summary = doc.fields?.summary?.stringValue || '';
    }
    const res = await fetch(`${base}/${threadDocPath(primeId, threadKey)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'turns' }],
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'DESCENDING' }],
        limit: cfg.max_turns,
      } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log('WARN', `thread-ledger: runQuery HTTP ${res.status} (${threadKey})`);
      return null;
    }
    rows = await res.json();
  } catch (e) {
    log('WARN', `thread-ledger: readThread failed (${threadKey}): ${e.message}`);
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const trimTurn = t => {
    const s = (t || '').trim();
    return s.length <= cfg.per_turn_chars ? s : `${s.substring(0, cfg.per_turn_chars)} […trimmed]`;
  };
  const turns = rows
    .filter(r => r.document?.fields?.text?.stringValue)
    .map(r => {
      const f = r.document.fields;
      return {
        role: f.role?.stringValue === 'admin' ? 'admin' : 'prime',
        text: trimTurn(f.text.stringValue),
        ts: f.ts?.timestampValue || '',
      };
    })
    .reverse();
  if (turns.length === 0 && !summary) return null;

  const render = ts => ts.map(t => `[${t.role}${t.ts ? ' ' + t.ts.substring(0, 16) : ''}] ${t.text}`).join('\n');
  let kept = turns;
  while (kept.length > 1 && render(kept).length > cfg.budget_chars) kept = kept.slice(1);

  const lastAdmin = [...kept].reverse().find(t => t.role === 'admin') || null;
  const lastPrime = [...kept].reverse().find(t => t.role === 'prime') || null;
  const summarySection = summary
    ? `## Thread summary (compacted, derived — not verbatim; ranks below operator statements)\n${summary}\n\n`
    : '';

  return {
    block: `${summarySection}## Conversation (most recent ${kept.length} turns, oldest first)\n${render(kept)}`,
    turns: kept,
    last_admin_text: lastAdmin?.text || null,
    last_prime_text: lastPrime?.text || null,
    cue_text: kept.slice(-4).map(t => t.text).join(' '),
  };
}

/**
 * Retention sweep: delete turn docs that are BOTH already folded into the
 * thread summary (ts <= summary_through_ts) AND older than the retention
 * horizon. Digest-before-prune, mirroring the memory_written-before-archival
 * ceremony — an unfolded turn is never deleted regardless of age. Bounded
 * per run; called on the archival cadence.
 */
export async function sweepThreadTurns({
  projectId, primeId, getToken, config = {}, log = () => {}, maxDeletes = 200,
}) {
  const cfg = { ...DEFAULTS, turn_retention_days: 14, ...config };
  const token = await getToken();
  if (!token) return 0;
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const cutoff = new Date(Date.now() - cfg.turn_retention_days * 86_400_000).toISOString();
  let deleted = 0;

  try {
    const listRes = await fetch(`${base}/primes/${primeId}/threads?pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!listRes.ok) return 0;
    const threads = (await listRes.json()).documents || [];

    for (const t of threads) {
      if (deleted >= maxDeletes) break;
      const watermark = t.fields?.summary_through_ts?.timestampValue || '';
      if (!watermark) continue; // nothing folded yet — nothing eligible
      const bound = watermark < cutoff ? watermark : cutoff;
      const res = await fetch(`${t.name}:runQuery`.replace(t.name, `https://firestore.googleapis.com/v1/${t.name}`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'turns' }],
          where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: bound } } },
          limit: Math.min(50, maxDeletes - deleted),
        } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()).filter(r => r.document?.name);
      for (const r of rows) {
        const del = await fetch(`https://firestore.googleapis.com/v1/${r.document.name}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (del.ok) deleted++;
      }
    }
    if (deleted > 0) log('INFO', `[TELEMETRY] thread_turns_swept deleted=${deleted} horizon_days=${cfg.turn_retention_days}`);
  } catch (e) {
    log('WARN', `thread-ledger: sweep failed: ${e.message}`);
  }
  return deleted;
}

/**
 * Code-triggered thread compaction (never model-decided). Folds turns older
 * than the recent window into the thread doc's summary via ONE stateless
 * utility call (C-6), watermark-preconditioned: the summary write carries
 * summary_through_ts so replays advance at most once. Summaries live only on
 * the thread doc — memory is reachable exclusively through the B-5 gate.
 *
 * @param {object} p — {projectId, primeId, getToken, threadKey, summarize, config, log}
 *   summarize: async (text, instruction, opts) => string  (vertex-text summarize)
 * @returns {boolean} whether a fold happened
 */
export async function compactThread({
  projectId, primeId, getToken, threadKey, summarize, config = {}, log = () => {},
}) {
  if (!summarize) return false;
  const cfg = { ...DEFAULTS, ...config };
  const token = await getToken();
  if (!token) return false;
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  try {
    const docRes = await fetch(`${base}/${threadDocPath(primeId, threadKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const doc = docRes.ok ? await docRes.json() : { fields: {} };
    const prevSummary = doc.fields?.summary?.stringValue || '';
    const watermark = doc.fields?.summary_through_ts?.timestampValue || '';

    // Count-based trigger evaluated from a bounded query (no racy counters).
    const res = await fetch(`${base}/${threadDocPath(primeId, threadKey)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'turns' }],
        ...(watermark ? { where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN', value: { timestampValue: watermark } } } } : {}),
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
        limit: cfg.compact_after_turns + cfg.max_turns + 1,
      } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const rows = (await res.json()).filter(r => r.document?.fields?.text?.stringValue);
    if (rows.length < cfg.compact_after_turns + cfg.max_turns) return false; // window not exceeded

    // Fold everything except the newest max_turns.
    const folding = rows.slice(0, rows.length - cfg.max_turns);
    const foldText = folding.map(r => {
      const f = r.document.fields;
      return `[${f.role?.stringValue || 'prime'}] ${f.text.stringValue}`;
    }).join('\n');
    const newWatermark = folding[folding.length - 1].document.fields.ts?.timestampValue || '';
    if (!newWatermark) return false;

    const instruction = 'Fold this conversation into a running thread summary. Preserve who-said-what attributions, open commitments, unresolved questions, and exact names/ids. Mark inferences as inferences. Be concise.';
    const input = prevSummary ? `EXISTING SUMMARY:\n${prevSummary}\n\nNEW TURNS:\n${foldText}` : foldText;
    const result = await summarize(input, instruction, { maxTokens: Math.ceil(cfg.summary_max_chars / 3) });
    if (!result || result.length === 0) {
      log('WARN', `thread-ledger: compaction summarize failed (${threadKey}) — window keeps rendering verbatim`);
      return false;
    }
    const summary = redactSecrets(result.substring(0, cfg.summary_max_chars));

    // Watermark-preconditioned advance: only write if the stored watermark is
    // still the one we folded from (at-most-once per window).
    const freshRes = await fetch(`${base}/${threadDocPath(primeId, threadKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const fresh = freshRes.ok ? await freshRes.json() : { fields: {} };
    if ((fresh.fields?.summary_through_ts?.timestampValue || '') !== watermark) {
      log('INFO', `thread-ledger: compaction lost the watermark race (${threadKey}) — skipping`);
      return false;
    }
    const mask = 'updateMask.fieldPaths=summary&updateMask.fieldPaths=summary_through_ts&updateMask.fieldPaths=updated_at';
    await fetch(`${base}/${threadDocPath(primeId, threadKey)}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        summary: { stringValue: summary },
        summary_through_ts: { timestampValue: newWatermark },
        updated_at: { timestampValue: new Date().toISOString() },
      } }),
      signal: AbortSignal.timeout(8000),
    });
    log('INFO', `[TELEMETRY] thread_compact thread=${threadKey} folded_turns=${folding.length} summary_chars=${summary.length}`);
    return true;
  } catch (e) {
    log('WARN', `thread-ledger: compactThread failed (${threadKey}): ${e.message}`);
    return false;
  }
}
