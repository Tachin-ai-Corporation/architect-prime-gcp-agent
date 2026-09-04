// platform/contracts/posture.mjs — capability posture (C-37): pure resolution + overlay.
//
// One brain, two profiles. A "posture" is a named bundle of COGNITIVE-LATITUDE config
// (execution model tier, iteration/tool budgets, …) that the single brain overlays onto
// its effective contract BY ROLE:
//   - 'unbound' (Prime): a wider cognitive envelope — licensed only because Prime is
//                        dashboard-only, admin-facing, with a human in the loop (C-1).
//   - 'strict'  (fleet): the canon-bound baseline — an empty overlay (today's behavior).
//
// This module is pure (B-19): no I/O, no clock, no randomness. The brain daemon and the
// neural gateway are SEPARATE processes that each load contracts.json independently, so
// each calls applyPosture() after its own load — both then see the role-correct contract.
//
// C-37: a posture widens COGNITION only. It must NEVER loosen the deterministic spine
// (C-4/C-5/C-15) or the structural fence (C-21/C-1/C-33/C-8/C-27). The `postures` block
// therefore only ever carries latitude knobs (vertex.strong_model_agents, dispatch/brain
// budgets, sampling) — never a capability, secret, egress, or state-machine key.

/**
 * Resolve the posture NAME for this agent.
 * Role decides by default; an explicit AGENT_POSTURE env forces it (canary / rollback).
 * Pure: pass `env` in tests; falls back to process.env.
 */
export function agentPosture(contracts, { isPrime = false, env } = {}) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const forced = e.AGENT_POSTURE;
  if (forced === 'unbound' || forced === 'strict') return forced;
  return isPrime ? 'unbound' : 'strict';
}

/** Deep-merge: source overrides target; plain objects merge recursively, arrays and scalars replace. Pure. */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const base = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Return a NEW contracts object with the named posture's overrides deep-merged on.
 * An empty / missing / unknown posture (e.g. 'strict') returns the base UNCHANGED.
 * Pure — never mutates its argument.
 */
export function applyPosture(contracts, postureName) {
  const baseContracts = contracts || {};
  const overlay = (baseContracts.postures || {})[postureName];
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay) || Object.keys(overlay).length === 0) {
    return baseContracts;
  }
  return deepMerge(baseContracts, overlay);
}

/** Convenience: resolve + apply in one call. Pure. */
export function withPosture(contracts, { isPrime = false, env } = {}) {
  return applyPosture(contracts, agentPosture(contracts, { isPrime, env }));
}
