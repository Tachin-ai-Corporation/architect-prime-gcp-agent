// corekit/lib/fleet-config/diff.mjs — semantic diff between definition sets
//
// An operator approving a fleet change should read what changed *about the
// agents*, not a unified patch. "web-master gained the firebase skill and lost
// its deploy approval gate" is reviewable; forty lines of JSON context is not.
//
// Pure. Feeds the proposal card, the Change record, and the rollback preview.

import { contentDigest } from '../../contracts/digest.mjs';

/** Fields whose change is worth naming explicitly, per kind. */
const SALIENT = {
  role: ['name', 'purpose', 'owned_outcomes', 'decision_posture', 'default_skills',
    'responsibilities', 'capabilities', 'secret_handles', 'collaboration', 'model_policy', 'memory_policy'],
  persona: ['organ', 'role_id', 'body', 'layer'],
  skill: ['name', 'summary', 'triggers', 'procedure', 'recovery', 'tool_bindings', 'organs', 'package'],
  process: ['name', 'description', 'narrative', 'intent_keywords'],
  responsibility: ['name', 'trigger', 'instruction', 'success_criteria', 'target_agent', 'enabled'],
  policy: ['name', 'domain', 'settings'],
  projectTemplate: ['name', 'goal_hint', 'default_team_roles', 'standard_processes'],
  evalSuite: ['name', 'target', 'cases', 'thresholds'],
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Describe a change to one field in domain terms rather than as a patch. */
function describeField(kind, field, before, after) {
  if (Array.isArray(before) && Array.isArray(after)) {
    const added = after.filter((x) => !before.some((y) => same(x, y)));
    const removed = before.filter((x) => !after.some((y) => same(x, y)));
    const parts = [];
    if (added.length) parts.push(`+${added.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}`);
    if (removed.length) parts.push(`−${removed.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}`);
    return parts.length ? `${field}: ${parts.join(' ')}` : null;
  }
  if (typeof before === 'string' && typeof after === 'string') {
    if (before === after) return null;
    // Prose fields are the ones an operator most wants summarized, not shown.
    if (before.length > 200 || after.length > 200) {
      const delta = after.length - before.length;
      return `${field}: rewritten (${delta >= 0 ? '+' : ''}${delta} chars)`;
    }
    return `${field}: "${before}" → "${after}"`;
  }
  if (before === undefined) return `${field}: set`;
  if (after === undefined) return `${field}: cleared`;
  return `${field}: changed`;
}

/**
 * Diff two revisions of the same definition.
 *
 * @returns {{ fields: string[], summary: string }|null} null when content is identical
 */
export function diffRevision(kind, before, after) {
  if (!before) {
    return { fields: [], summary: `added ${kind} '${after.id}'` };
  }
  if (!after) {
    return { fields: [], summary: `deprecated ${kind} '${before.id}'` };
  }
  if (contentDigest(before) === contentDigest(after)) return null;

  const fields = [];
  const descriptions = [];
  for (const field of SALIENT[kind] || []) {
    if (same(before[field], after[field])) continue;
    fields.push(field);
    const d = describeField(kind, field, before[field], after[field]);
    if (d) descriptions.push(d);
  }

  // Status changes are salient everywhere and are not in the per-kind lists.
  if (before.status !== after.status) {
    fields.push('status');
    descriptions.push(`status: ${before.status} → ${after.status}`);
  }

  return {
    fields,
    summary: descriptions.length
      ? `${kind} '${after.id}': ${descriptions.join('; ')}`
      : `${kind} '${after.id}': content changed`,
  };
}

/**
 * Diff two whole definition sets.
 *
 * @param {Map<string,object>} before - key `${kind}/${id}` → sealed revision
 * @param {Map<string,object>} after
 * @returns {Array<object>} diff entries in the Change schema's shape
 */
export function diffSets(before, after) {
  const entries = [];
  const keys = new Set([...before.keys(), ...after.keys()]);

  for (const key of [...keys].sort()) {
    const [kind, ...rest] = key.split('/');
    const id = rest.join('/');
    const b = before.get(key);
    const a = after.get(key);

    if (b && a && contentDigest(b) === contentDigest(a)) continue;

    const d = diffRevision(kind, b, a);
    if (!d) continue;

    entries.push({
      kind,
      id,
      op: !b ? 'add' : !a ? 'deprecate' : 'update',
      from_revision: b?.revision ?? null,
      to_revision: a?.revision ?? null,
      summary: d.summary,
      fields: d.fields,
    });
  }
  return entries;
}

/**
 * Which agents a diff actually reaches.
 *
 * The question an operator asks before approving is "who does this touch",
 * and it is not answerable from the diff alone — a skill change reaches every
 * role that assigns it, and a role change reaches every agent holding it.
 *
 * @param {Array<object>} diff
 * @param {Map<string,object>} roles - roleId → Role definition
 * @param {Array<{agent_id:string, role_id:string}>} assignments
 */
export function impactedAgents(diff, roles, assignments) {
  const touchedRoles = new Set();

  for (const entry of diff) {
    if (entry.kind === 'role') { touchedRoles.add(entry.id); continue; }
    for (const [roleId, role] of roles) {
      if (entry.kind === 'skill' && (role.default_skills || []).includes(entry.id)) touchedRoles.add(roleId);
      if (entry.kind === 'responsibility' && (role.responsibilities || []).includes(entry.id)) touchedRoles.add(roleId);
      if (entry.kind === 'persona' && entry.id.startsWith(`${roleId}-`)) touchedRoles.add(roleId);
      if (entry.kind === 'policy' && (role.model_policy === entry.id || role.memory_policy === entry.id)) touchedRoles.add(roleId);
    }
    // A process or project template is fleet-wide know-how — it reaches everyone.
    if (entry.kind === 'process' || entry.kind === 'projectTemplate') {
      for (const roleId of roles.keys()) touchedRoles.add(roleId);
    }
  }

  return assignments
    .filter((a) => touchedRoles.has(a.role_id))
    .map((a) => a.agent_id)
    .sort();
}

/** A one-paragraph rendering of a diff, for a chat proposal card. */
export function renderDiff(diff) {
  if (!diff.length) return 'No content changes.';
  const byOp = { add: [], update: [], deprecate: [] };
  for (const e of diff) byOp[e.op].push(e.summary);

  const sections = [];
  if (byOp.add.length) sections.push(`**Added**\n${byOp.add.map((s) => `- ${s}`).join('\n')}`);
  if (byOp.update.length) sections.push(`**Changed**\n${byOp.update.map((s) => `- ${s}`).join('\n')}`);
  if (byOp.deprecate.length) sections.push(`**Deprecated**\n${byOp.deprecate.map((s) => `- ${s}`).join('\n')}`);
  return sections.join('\n\n');
}
