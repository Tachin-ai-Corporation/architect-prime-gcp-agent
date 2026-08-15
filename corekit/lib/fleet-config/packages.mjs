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
 * The install destination for a skill's documentation and metadata.
 *
 * Load-bearing, and the source of a real production defect: `skill-setup`
 * provisions dependencies and builds the capability map ONLY for skills under
 * `corekit/specialties/${SPECIALTY}/skills/`. A specialty role that reuses
 * another specialty's skill must install it into *its own* namespace — installing
 * it under the owning specialty's path leaves it invisible to skill-setup, so its
 * `requires` are never installed and the agent holds a documented skill whose
 * tools are absent (C-9 phantom capability).
 *
 * Core skills installed for every role keep the flat `skills/<id>/` destination.
 */
export function skillDestRoot(skill, roleId, { core }) {
  if (core) return `skills/${skill.id}`;
  return `corekit/specialties/${roleId}/skills/${skill.id}`;
}

/**
 * Build the file mappings a role's skills contribute to its install manifest.
 *
 * @param {object} role - a Role definition
 * @param {object} ctx
 * @param {Map<string,object>} ctx.skillFiles - skillId → { docs: string[], executables: string[], support: string[] }
 * @param {object} ctx.catalog - see resolveSkill
 * @param {Set<string>} ctx.baseSkills - skills every agent already gets from base/role manifests
 * @returns {{ lines: Array<{source:string,dest:string}>, unresolved: string[] }}
 */
export function skillManifestLines(role, ctx) {
  const lines = [];
  const unresolved = [];

  for (const skillId of role.default_skills || []) {
    // Base and role-layer skills are installed by base.txt / role-*.txt. Listing
    // them again in a job manifest would install the same file twice and, worse,
    // let two manifests fight over one destination.
    if (ctx.baseSkills.has(skillId)) continue;

    const resolved = resolveSkill(skillId, ctx.catalog);
    if (!resolved) { unresolved.push(skillId); continue; }

    const files = ctx.skillFiles.get(skillId);
    if (!files) { unresolved.push(skillId); continue; }

    const isCore = resolved.owner === null;
    const destRoot = skillDestRoot(resolved, role.id, { core: isCore });

    for (const rel of files.docs) {
      lines.push({ source: `${resolved.root}/${rel}`, dest: `${destRoot}/${rel}` });
    }
    for (const rel of files.support) {
      lines.push({ source: `${resolved.root}/${rel}`, dest: `${destRoot}/${rel}` });
    }
    // Executables go on PATH, never namespaced — two roles reusing one skill must
    // resolve the same binary.
    for (const rel of files.executables) {
      lines.push({ source: `${resolved.root}/${rel}`, dest: `bin/${rel}` });
    }
  }

  return { lines, unresolved };
}

/**
 * Render manifest lines to the `source dest` text format install.sh consumes.
 *
 * The generated file is marked so nobody edits it as a source (C-7's rule about
 * generated artifacts, applied to manifests).
 */
export function renderManifest(roleId, lines, opts = {}) {
  const header = [
    `# infra/manifests/job-${roleId}.txt`,
    '#',
    '# GENERATED from the canonical Role definition by corekit/system/fleet-config.',
    '# Do not edit. Edit the Role definition and regenerate — a hand-edit here is a',
    '# fourth authority for a fact that already has one (C-7, C-29).',
    opts.sourceRevision ? `# role revision: ${opts.sourceRevision}` : null,
    '',
  ].filter((l) => l !== null);

  const body = lines.map(({ source, dest }) => `${source} ${dest}`);
  return `${header.join('\n')}${body.join('\n')}\n`;
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
