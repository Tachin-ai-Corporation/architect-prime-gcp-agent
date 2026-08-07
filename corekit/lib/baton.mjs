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

/**
 * Resolve a delegation signal to a REAL teammate email using the project roster —
 * deterministically, because an LLM planner regularizes opaque strings: it emitted
 * `engineer-agent@<operator-domain>` with the correct `engineer-agent-bobby@…` sitting
 * right there in its context. The email is data the machine moves; the model only needs
 * to name the role (C-4/C-5). Mirrors the child-mission executor's "validate target_email
 * against the registry → fall through to specialty lookup" (checkpoint-executor.mjs), so
 * both dispatch models resolve teammates identically. Precedence: verbatim roster email →
 * specialty/role → name. Never resolves to a human (batons route to agent daemons).
 * Returns a canonical roster email, or null when nothing matches — the caller then keeps
 * the checkpoint with the originator rather than STRANDING the mission on an unverifiable
 * assignee no daemon will ever dequeue. Pure.
 *
 * @param {Array} roster  project team: [{email, role, name, type}]
 * @param {{target_email?:string,_specialty?:string,agent?:string,target_role?:string,target_name?:string}} signal
 * @returns {string|null}
 */
export function resolveAssignee(roster, signal) {
  const s = signal || {};
  const team = (Array.isArray(roster) ? roster : []).filter(m => m && m.email && m.type !== 'human');
  if (!team.length) return s.target_email || null; // no roster → best-effort passthrough (legacy behavior)
  const lpp = e => String(e || '').split('@')[0].toLowerCase().trim();
  const norm = v => String(v || '').toLowerCase().trim();
  // 1. verbatim email (matched by localpart) → the roster's canonical address
  if (s.target_email) {
    const hit = team.find(m => lpp(m.email) === lpp(s.target_email));
    if (hit) return hit.email;
  }
  // 2. specialty / role — the robust signal; the email is opaque, the role is not.
  //    Match the roster `role`, or (for specialties like product-architect that map to a
  //    role label such as `lead`) the specialty token embedded in the member email localpart.
  const spec = norm(s._specialty || s.target_role || s.agent);
  if (spec && spec !== 'motor' && spec !== 'delegation') {
    const hit = team.find(m => norm(m.role) === spec) || team.find(m => lpp(m.email).includes(spec));
    if (hit) return hit.email;
  }
  // 3. name
  const nm = norm(s.target_name);
  if (nm) {
    const hit = team.find(m => norm(m.name) === nm);
    if (hit) return hit.email;
  }
  // 4. unresolved — do not invent an address; the caller keeps the originator
  return null;
}

/**
 * Turn a structured plan's teammate-delegation signals into per-checkpoint ASSIGNEES for the
 * baton model. The planner signals teammate work today as a delegation task (carrying a
 * `target_email` and/or an `agent`/`_specialty`); under the handoff model that becomes a
 * checkpoint assigned to that teammate, whose tasks the teammate runs as its OWN motor work
 * on the shared mission — no nested delegation. The assignee is RESOLVED against the project
 * roster (resolveAssignee) so a hallucinated email never reaches the spine. Pure; returns a
 * new array (input untouched). A checkpoint with an explicit `assignee` is honored as-is; a
 * checkpoint whose delegation cannot be resolved keeps the originator (assignee stays null →
 * checkpointAssignee falls back to the originator) rather than stranding the mission.
 *
 * @param {Array} checkpoints  structured-plan checkpoints (post extractCheckpoints)
 * @param {Array} [roster]     project team roster [{email, role, name, type}]; omitted → legacy passthrough
 * @returns {Array}
 */
export function deriveHandoffCheckpoints(checkpoints, roster) {
  if (!Array.isArray(checkpoints)) return [];
  return checkpoints.map((cp) => {
    const tasks = Array.isArray(cp && cp.tasks) ? cp.tasks : [];
    const deleg = tasks.find(t => t && (t.type === 'delegation' || t._step_type === 'delegation')
      && (t.target_email || t._specialty || t.agent));
    let assignee = (cp && cp.assignee) || null;
    if (!assignee && deleg) assignee = resolveAssignee(roster, deleg);
    if (!assignee) return cp;
    // De-delegate: the assignee executes these as its own motor tasks on the shared mission.
    const localTasks = tasks.map((t) => {
      if (t && (t.type === 'delegation' || t._step_type === 'delegation')) {
        const { type, _step_type, target_email, _specialty, ...rest } = t;
        return { ...rest, agent: 'motor', type: 'standard' };
      }
      return t;
    });
    return { ...cp, assignee, tasks: localTasks };
  });
}

/** True when the baton model is active per contracts (default: off / child-mission). */
export function handoffModelEnabled(contracts) {
  return (contracts && contracts.dispatch && contracts.dispatch.delegation
    && contracts.dispatch.delegation.model) === 'handoff';
}
