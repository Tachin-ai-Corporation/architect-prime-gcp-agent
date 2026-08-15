// corekit/lib/fleet-config/packages.mjs — where a skill's files actually live
//
// A Role definition says *which* skills a role holds. It deliberately does not
// say where their files are — that is repo layout, not deployment intent, and
// baking it into a definition would make every role revision churn when a skill
// moves.
//
// This module answers the layout question, so the manifest generator can be a
// pure function of (Role, catalog) rather than a hand-authored list. It is what
// ends the tri-source role authority: `agent-types.json`, `specialties/*/kit.json`
// and `infra/manifests/job-*.txt` each carried a slice of the same fact and had
// to agree by hand.

/**
 * Capability naming.
 *
 * A capability is *the privileged executable a skill may invoke*. That is the
 * granularity C-33 cares about: a skill cannot drive a binary its role does not
 * hold, and introducing a new binary is a Provider change (Foundation), not a
 * definition change. Finer granularity would be theatre — nothing enforces it
 * below the process boundary.
 *
 * Gateway-native tools (registered in corekit/brain/tools.mjs rather than
 * installed to bin/) get their own suffix so the closure check does not expect a
 * binary that correctly does not exist.
 */
export function capabilityFor(script, kind = 'bin') {
  const safe = String(script).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `tool.${safe}.${kind === 'gateway' ? 'gateway' : 'invoke'}`;
}

/** Every capability a skill package drives, derived from its declared scripts. */
export function capabilitiesOf(skillJson) {
  const kind = skillJson?._scripts_kind === 'gateway' ? 'gateway' : 'bin';
  return (skillJson?.scripts || []).map((s) => capabilityFor(s, kind));
}

/**
 * Resolve a skill id to its owning location in the repo catalog.
 *
 * Search order matters: a core skill and a specialty skill may share a name, and
 * the specialty copy is the one a specialty role means.
 *
 * @param {string} skillId
 * @param {{ coreSkills: Set<string>, specialtySkills: Map<string,string> }} catalog
 *        specialtySkills maps skillId → owning specialty id
 * @returns {{ id: string, owner: string|null, root: string }|null}
 */
export function resolveSkill(skillId, catalog) {
  if (catalog.specialtySkills.has(skillId)) {
    const owner = catalog.specialtySkills.get(skillId);
    return { id: skillId, owner, root: `specialties/${owner}/skills/${skillId}` };
  }
  if (catalog.coreSkills.has(skillId)) {
    return { id: skillId, owner: null, root: `skills/${skillId}` };
  }
  return null;
}

/**
 * Parse an existing manifest into comparable `source dest` pairs.
 *
 * Comments and blank lines are dropped; a trailing `?` on a destination marks an
 * optional install and is part of the destination, so it is preserved.
 */
export function parseManifest(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    out.push({ source: parts[0], dest: parts[1] });
  }
  return out;
}
