// corekit/lib/conversation-context.mjs — deterministic conversation assembly (B-32)
//
// The conversation is context, not memory: transport-owned, deterministically
// assembled from the channel's durable transcript, trimmed to budget, injected
// by the daemon. Organs never fetch chat history themselves.
//
// Dashboard-lane implementation. The descriptor is channel-agnostic so a gchat
// assembler can slot in later without touching call sites.

const DEFAULTS = {
  max_turns: 12,
  budget_chars: 6000,
  per_turn_chars: 600,
};

function trimTurn(text, perTurnChars) {
  const t = (text || '').trim();
  if (t.length <= perTurnChars) return t;
  return `${t.substring(0, perTurnChars)} […trimmed]`;
}

/**
 * Assemble recent conversation for a Prime's dashboard channel.
 *
 * @param {object} p
 * @param {string} p.projectId    GCP project id
 * @param {string} p.primeId      Prime id
 * @param {Function} p.getToken   async () => GCE access token
 * @param {object} [p.config]     contracts.conversation (max_turns, budget_chars, per_turn_chars)
 * @param {Function} [p.log]      logger(level, msg)
 * @returns {Promise<null | {
 *   block: string,          // rendered transcript block for prompts/envelope
 *   turns: Array<{role: 'admin'|'prime', text: string, ts: string}>,
 *   last_admin_text: string|null,
 *   last_prime_text: string|null,
 *   cue_text: string,       // recent-turn text for cue extraction (CP3)
 * }>}
 */
export async function assembleConversation({ projectId, primeId, getToken, config = {}, log = () => {} }) {
  const cfg = { ...DEFAULTS, ...config };
  if (!projectId || !primeId) return null;

  const token = await getToken();
  if (!token) return null;

  const parent = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/primes/${primeId}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'messages' }],
      orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
      limit: cfg.max_turns,
    },
  };

  let rows;
  try {
    const res = await fetch(`${parent}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log('WARN', `conversation-context: runQuery HTTP ${res.status}`);
      return null;
    }
    rows = await res.json();
  } catch (e) {
    log('WARN', `conversation-context: fetch failed: ${e.message}`);
    return null;
  }
  if (!Array.isArray(rows)) return null;

  // Decode, oldest-first
  const turns = rows
    .filter(r => r.document?.fields?.text?.stringValue)
    .map(r => {
      const f = r.document.fields;
      const sender = f.sender?.stringValue || 'prime';
      return {
        role: sender === 'admin' ? 'admin' : 'prime',
        text: trimTurn(f.text.stringValue, cfg.per_turn_chars),
        ts: f.timestamp?.timestampValue || '',
      };
    })
    .reverse();

  if (turns.length === 0) return null;

  // Budget trim: drop oldest whole turns until under budget
  const render = ts => ts.map(t => `[${t.role}${t.ts ? ' ' + t.ts.substring(0, 16) : ''}] ${t.text}`).join('\n');
  let kept = turns;
  while (kept.length > 1 && render(kept).length > cfg.budget_chars) kept = kept.slice(1);

  const lastAdmin = [...kept].reverse().find(t => t.role === 'admin') || null;
  const lastPrime = [...kept].reverse().find(t => t.role === 'prime') || null;

  return {
    block: `## Conversation (most recent ${kept.length} turns, oldest first)\n${render(kept)}`,
    turns: kept,
    last_admin_text: lastAdmin?.text || null,
    last_prime_text: lastPrime?.text || null,
    cue_text: kept.slice(-4).map(t => t.text).join(' '),
  };
}
