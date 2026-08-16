// platform/control-plane/project-bootstrap.mjs — pure core for fleet project bootstrap.
//
// A PM/lead role stands up a whole delivery project from a single chat ask, using the
// GChat space the ask ARRIVED on as the project's comms space. This module is the pure
// decision/shape core (B-19): no I/O, no clock, no randomness. The caller (the
// project_bootstrap action handler) supplies `now`, reads the fleet roster, performs the
// Firestore writes, and re-scopes the mission. Correctness lives here where it is tested.

import { normalizeDeployDescriptor, validateDeployDescriptor } from './deploy-target.mjs';

const localpart = (e) => String(e || '').split('@')[0].toLowerCase().trim();

/** True when the project_bootstrap action is enabled per contracts (default: off). */
export function projectBootstrapEnabled(contracts) {
  return !!(contracts && contracts.dispatch && contracts.dispatch.project_bootstrap
    && contracts.dispatch.project_bootstrap.enabled === true);
}

/**
 * The GChat space a mission arrived on (its comms origin), or '' when it did not come
 * from a space. This is the space a bootstrap binds the new project to — NOT the
 * project's current gchat_space_id (which is empty on the `general` fallback).
 */
export function missionOriginSpace(envelope) {
  const m = (envelope && (envelope.source_meta || envelope._sourceMeta)) || {};
  return (m.address && m.address.space) || m.spaceName || m.space || '';
}

/** Derive a stable kebab-case project id from a name, avoiding collisions with taken ids. Pure. */
export function slugifyProjectId(name, taken = []) {
  let base = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  if (!base) base = 'project';
  const takenSet = new Set((taken || []).map(String));
  if (!takenSet.has(base)) return base;
  for (let i = 2; i < 1000; i++) { const c = `${base}-${i}`; if (!takenSet.has(c)) return c; }
  return `${base}-x`;
}

/** An existing, non-archived project already bound to `space` (idempotent adopt), or null. Pure. */
export function findProjectBySpace(projects, space) {
  if (!space || !projects) return null;
  for (const [id, p] of Object.entries(projects)) {
    if (p && p.gchat_space_id === space && p.status !== 'archived') return id;
  }
  return null;
}

/**
 * Resolve a team spec to REAL fleet emails using the roster — never invent an address.
 * teamSpec: [{ role?, specialty?, name?, email?, responsibilities?, type? }]
 * roster:   [{ email, specialty, status }] (from the fleet registry)
 * Returns { team: [{email,role,name,type,responsibilities?}], unresolved: [label...] }.
 * A human member (type:'human') with an email passes through (the operator/owner);
 * an agent spec that matches no roster agent is 'unresolved' (left off, surfaced to cortex).
 */
export function resolveTeam(teamSpec, roster, opts = {}) {
  const pool = (roster || []).filter(a => a && a.email && (opts.anyStatus || a.status === 'online' || !a.status));
  const bySpec = new Map();
  for (const a of pool) { const s = String(a.specialty || '').toLowerCase(); if (s && !bySpec.has(s)) bySpec.set(s, a); }
  const team = [];
  const unresolved = [];
  for (const m of (teamSpec || [])) {
    if (!m) continue;
    if (m.type === 'human' && m.email) {
      team.push({ email: m.email, role: m.role || 'owner', name: m.name || localpart(m.email), type: 'human', ...(m.responsibilities ? { responsibilities: m.responsibilities } : {}) });
      continue;
    }
    const spec = String(m.specialty || m.role || '').toLowerCase();
    let hit = null;
    if (m.email) hit = pool.find(a => localpart(a.email) === localpart(m.email)) || null;
    if (!hit && spec) hit = bySpec.get(spec) || pool.find(a => localpart(a.email).includes(spec)) || null;
    if (hit) {
      team.push({ email: hit.email, role: m.role || spec || 'member', name: m.name || hit.name || localpart(hit.email), type: 'agent', ...(m.responsibilities ? { responsibilities: m.responsibilities } : {}) });
    } else {
      unresolved.push(spec || m.role || m.email || 'unknown');
    }
  }
  return { team, unresolved };
}

/**
 * Agent teammates on a team with no `responsibilities` — the field the brain renders as the
 * per-member "who does what" line, which is the primary signal Cortex uses to pick a delegate
 * (projects.mjs buildContext). The auto-added lead (the PM) and owner always carry a default, so
 * they are excluded by role. A non-empty result means the PM under-specified the roster and the
 * planner will have a weak delegation signal for those members. Pure. Returns an array of emails.
 */
export function teammatesMissingResponsibilities(team, opts = {}) {
  const exclude = new Set((opts.excludeRoles || ['lead', 'owner']).map(r => String(r).toLowerCase()));
  return (Array.isArray(team) ? team : [])
    .filter(m => m && m.email && String(m.type || 'agent').toLowerCase() === 'agent')
    .filter(m => !exclude.has(String(m.role || '').toLowerCase()))
    .filter(m => !String(m.responsibilities || '').trim())
    .map(m => m.email);
}

/** Required agent emails NOT present among the space's members (localpart-compared). Pure. */
export function membershipGap(requiredEmails, memberEmails) {
  const mem = new Set((memberEmails || []).map(localpart).filter(Boolean));
  return [...new Set((requiredEmails || []).map(String))].filter(e => e && !mem.has(localpart(e)));
}

/**
 * Assemble the projects/{id} Firestore doc. Pure — caller supplies `now` (ISO) + resolved team.
 * canon: [{key,text}] -> { authority:[owner], entries:[{key,text,updated_at,updated_by}] }
 * context: [{key,kind,ref,url,name,summary}] -> Context-Packet map.
 */
export function buildProjectDoc({ id, name, description, goal, spaceId, team, canon, context, deploy, owner, createdBy, now }) {
  const by = createdBy || owner || '';
  const doc = {
    id,
    name: name || id,
    description: description || '',
    goal: goal || '',
    status: 'active',
    gchat_space_id: spaceId || null,
    team: Array.isArray(team) ? team : [],
    owner: owner || '',
    created_by: by,
    parent_id: null,
    depends_on: [],
    created_at: now,
    updated_at: now,
  };
  // Deploy target — first-class + unambiguous (site vs GCP project), only when valid, so a
  // devops agent reads it instead of inferring the site or shipping a placeholder.
  const _deploy = normalizeDeployDescriptor(deploy);
  if (_deploy && validateDeployDescriptor(_deploy).ok) doc.deploy = _deploy;
  if (Array.isArray(canon) && canon.length) {
    doc.canon = {
      authority: owner ? [owner] : [],
      entries: canon.filter(c => c && c.key).map(c => ({ key: c.key, text: c.text || '', updated_at: now, updated_by: by })),
    };
  }
  if (Array.isArray(context) && context.length) {
    doc.context = {};
    for (const c of context) {
      if (!c || !c.key) continue;
      doc.context[c.key] = { kind: c.kind || 'url', ref: c.ref || '', url: c.url || '', name: c.name || c.key, summary: c.summary || '', updatedAt: now, updatedBy: by };
    }
  }
  return doc;
}
