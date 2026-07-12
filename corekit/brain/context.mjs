// corekit/brain/context.mjs — Gateway Session Store (SESSION_CONTEXT_PLAN Phase 5)
//
// A token-accounted, activity-TTL'd, LRU-capped store of daemon-commanded
// conversation sessions. The DAEMON owns every lifecycle decision (open /
// continue / reset / close — B-1); the gateway only stores what the daemon
// already assembled and replays it to the provider. Sessions are explicitly
// a REBUILDABLE CACHE (B-22): in-memory only, nothing persisted, and every
// miss answers fast so the daemon re-opens from Firestore state via today's
// exact stateless assembly. Losing the store costs one full-price rebuild —
// never correctness.
//
// Invalidation: systemHash covers the STABLE system block only (MEMORY.md is
// volatile by design — routine memory appends must not churn sessions); a
// SOUL/skill change flows through a gateway restart, which empties the store.
// seq echoes catch daemon/gateway drift; generation counters prevent a stale
// in-flight request from resurrecting an old transcript.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
let _contracts = {};
try {
  const p = existsSync(join(CORE_DIR, 'corekit', 'contracts.json'))
    ? join(CORE_DIR, 'corekit', 'contracts.json')
    : join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..', 'infra', 'contracts.json');
  _contracts = JSON.parse(readFileSync(p, 'utf8'));
} catch { /* defaults apply */ }

const CFG = _contracts.session || {};
const IDLE_TTL_MS = (CFG.idle_ttl_minutes || 30) * 60_000;
const MAX_SESSIONS = CFG.max_sessions || 16;
const TURN_CONTENT_CAP = _contracts.utility?.context_budgets?.agent_step || 8000;

/** chars/4 heuristic over a messages array. */
export function estimateTokens(messages) {
  return Math.ceil(messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return sum + content.length / 4;
  }, 0));
}

export function hashSystem(stableSystemBlock) {
  return createHash('sha256').update(stableSystemBlock || '').digest('hex').substring(0, 16);
}

// Cap stored tool_result content at the same budget the stateless path uses
// (B-4: a session must not replace bounded digests with unbounded transcripts).
function capMessage(m) {
  if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TURN_CONTENT_CAP) {
    return { ...m, content: m.content.substring(0, TURN_CONTENT_CAP) + ` [...capped at ${TURN_CONTENT_CAP} chars — full result in envelope state]` };
  }
  return m;
}

const sessions = new Map(); // id -> session record

function evictIfNeeded() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > IDLE_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastUsedAt < oldestAt) { oldestAt = s.lastUsedAt; oldestId = id; }
    }
    if (!oldestId) break;
    sessions.delete(oldestId);
  }
}

/** op:'open' — store the full opening context the daemon assembled. */
export function openSession({ id, agentId, systemHash, messages }) {
  evictIfNeeded();
  const s = {
    id,
    agentId,
    systemHash,
    messages: messages.map(capMessage),
    seq: 0,
    lastRealPromptTokens: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  sessions.set(id, s);
  return s;
}

/**
 * op:'continue' — validate identity and return the session, or a typed miss.
 * A miss NEVER throws: the caller answers fast without a provider call and
 * the daemon rebuilds.
 */
export function continueSession({ id, agentId, systemHash, expectedSeq }) {
  const s = sessions.get(id);
  if (!s) return { miss: 'absent' };
  if (s.agentId !== agentId) return { miss: 'agent' };
  if (systemHash && s.systemHash !== systemHash) return { miss: 'system_hash' };
  if (typeof expectedSeq === 'number' && s.seq !== expectedSeq) return { miss: 'seq' };
  s.lastUsedAt = Date.now();
  return { session: s };
}

/** Append the completed turn (delta user msgs + assistant result + tool turns). */
export function appendTurn(id, newMessages, promptTokens = 0) {
  const s = sessions.get(id);
  if (!s) return null;
  for (const m of newMessages) s.messages.push(capMessage(m));
  s.seq++;
  s.lastRealPromptTokens = promptTokens || s.lastRealPromptTokens;
  s.lastUsedAt = Date.now();
  return s;
}

/** op:'reset' — wholesale replacement (daemon-driven compaction or repair). */
export function resetSession({ id, agentId, systemHash, messages }) {
  const existing = sessions.get(id);
  const s = openSession({ id, agentId, systemHash, messages });
  s.seq = existing ? existing.seq : 0;
  return s;
}

export function closeSession(id) {
  return sessions.delete(id); // idempotent (C-18)
}

/** Enriched metadata for /status (C-20) — ids and counters, zero content. */
export function listSessions() {
  const now = Date.now();
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    agentId: s.agentId,
    seq: s.seq,
    est_tokens: estimateTokens(s.messages),
    last_prompt_tokens: s.lastRealPromptTokens,
    age_sec: Math.round((now - s.createdAt) / 1000),
    idle_sec: Math.round((now - s.lastUsedAt) / 1000),
  }));
}
