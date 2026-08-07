// corekit/lib/baton.mjs — intra-mission checkpoint hand-off ("baton") routing.
//
// ONE mission travels agent→agent. `originator` started it (stable identity);
// `assignee` is whose turn it is (the routing key the daemon dequeues on). Each
// checkpoint may carry an `assignee`; the daemon routes the mission to the assignee
// of the first not-complete checkpoint, and back to the originator to finish.
//
// This module is the DECISION core: pure, no I/O, no clock, no randomness (B-19).
// Callers supply `now` (ms) and perform every Firestore write themselves. The daemon
// wiring around it is deliberately thin — call a function, do a field-masked write,
// return — so correctness lives here where it is unit-tested.

const localpart = (e) => String(e || '').split('@')[0].toLowerCase().trim();
const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms)) ? new Date(ms).toISOString() : '';

/** Same agent, compared by email localpart — matches the dequeue localpart match. */
export function sameAgent(a, b) {
  const la = localpart(a);
  const lb = localpart(b);
  return !!la && la === lb;
}

/** The agent whose turn it is to run this mission (routing key). Shim: assignee || owner. */
export function effectiveAssignee(env) {
  return (env && (env.assignee || env.owner)) || '';
}

/** The agent that started the mission (stable identity). Shim: originator || owner. */
export function missionOriginator(env) {
  return (env && (env.originator || env.owner)) || '';
}

/** Who owns a checkpoint: its explicit assignee, else the mission originator (default). */
export function checkpointAssignee(cp, originator) {
  return (cp && cp.assignee) || originator || '';
}

/**
 * Decide what the CURRENT agent should do with this mission's spine. Pure.
 * Returns one of:
 *   { action: 'execute',   index }     run checkpoint `index` — it is mine
 *   { action: 'handoff',   to, index } checkpoint `index` belongs to `to`
 *   { action: 'handback',  to }        remaining work is done here; return to originator
 *   { action: 'synthesize' }           all checkpoints complete and I am the originator
 *
 * @param {Array} spine  the _cp_spine array
 * @param {{me:string, originator?:string}} who
 */
export function decideHop(spine, { me, originator } = {}) {
  const s = Array.isArray(spine) ? spine : [];
  const orig = originator || me || '';
  const idx = s.findIndex((cp) => !cp || cp.status !== 'complete');
  if (idx < 0) {
    return sameAgent(me, orig) ? { action: 'synthesize' } : { action: 'handback', to: orig };
  }
  const owner = checkpointAssignee(s[idx], orig);
  if (sameAgent(owner, me)) return { action: 'execute', index: idx };
  return { action: 'handoff', to: owner, index: idx };
}

/**
 * Exclusive end index of the contiguous run of checkpoints from `startIndex` that
 * are assigned to `me`. The executor runs [startIndex, stopBefore) then hands off at
 * stopBefore. Pure.
 */
export function myRunEnd(spine, { me, originator, startIndex = 0 } = {}) {
  const s = Array.isArray(spine) ? spine : [];
  const orig = originator || me || '';
  let i = Math.max(0, startIndex);
  for (; i < s.length; i++) {
    if (!sameAgent(checkpointAssignee(s[i], orig), me)) break;
  }
  return i;
}

/**
 * The field-mask patch that hands the mission to `to`. The caller writes it with a
 * DISJOINT field-masked write (no clobber) and then stops touching the doc. Pure.
 *
 * @param {Object} env  the mission envelope (read `_baton.turn`, `assignee`/`owner`)
 * @param {string} to   the agent to hand to
 * @param {{now?:number, leaseMs?:number, turn?:number}} opts
 */
export function handoffPatch(env, to, { now, leaseMs = 1800000, turn } = {}) {
  const prevTurn = (env && env._baton && Number(env._baton.turn)) || 0;
  return {
    assignee: to,
    status: 'queued',
    _baton: {
      turn: turn ?? (prevTurn + 1),
      from: effectiveAssignee(env),
      to,
      lease_expiry: (typeof now === 'number') ? iso(now + leaseMs) : '',
      handed_at: iso(now),
    },
    updated_at: iso(now),
  };
}

/**
 * A baton is stale when the mission is assigned AWAY from its originator and the
 * lease has expired — the assignee likely died. The caller reclaims to the
 * originator (or escalates). Pure.
 */
export function isBatonStale(env, nowMs) {
  if (!env || !env._baton || !env._baton.lease_expiry) return false;
  if (sameAgent(effectiveAssignee(env), missionOriginator(env))) return false;
  const exp = Date.parse(env._baton.lease_expiry);
  return Number.isFinite(exp) && typeof nowMs === 'number' && nowMs > exp;
}

/** Reclaim patch: route a stale mission back to its originator. Pure. */
export function reclaimPatch(env, { now } = {}) {
  const orig = missionOriginator(env);
  const prevTurn = (env && env._baton && Number(env._baton.turn)) || 0;
  return {
    assignee: orig,
    status: 'queued',
    _baton: {
      turn: prevTurn + 1,
      from: effectiveAssignee(env),
      to: orig,
      reclaimed: true,
      lease_expiry: '',
      handed_at: iso(now),
    },
    updated_at: iso(now),
  };
}

/** True when the baton model is active per contracts (default: off / child-mission). */
export function handoffModelEnabled(contracts) {
  return (contracts && contracts.dispatch && contracts.dispatch.delegation
    && contracts.dispatch.delegation.model) === 'handoff';
}
