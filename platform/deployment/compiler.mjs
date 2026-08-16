// platform/deployment/compiler.mjs — Role + overlays → Effective Agent Spec (Foundation)
//
// The runtime consumes one deterministic, immutable bundle rather than
// independently resolving overlapping role metadata, install manifests, SOUL
// appends, skill indexes and local config and hoping they agree (B-35).
//
// Pure by construction. No network, no filesystem, no clock beyond what the
// caller supplies — so compiling the same inputs twice yields the same digest,
// which is what makes an agentSpecDigest a replay key (C-32).
//
// Composition is ordered and one-directional:
//
//     foundation firmware
//       + active deployment defaults
//       + role definition
//       + project overlay
//       + agent overlay
//       = effective bundle + digest
//
// Later layers add; they never reach back. An overlay cannot replace a Foundation
// field, add an undeclared capability, broaden egress, grant IAM, or inject a
// secret (C-33, B-36). Those are enforced here rather than described in a prompt,
// because a prompt is not a boundary.

import { contentDigest, treeDigest, bytesDigest } from '../contracts/digest.mjs';
import { assertValid } from '../contracts/validate.mjs';
import { EFFECTIVE_AGENT_SPEC_SCHEMA } from '../contracts/schemas/spec.mjs';

/**
 * Fields no overlay may set. These are the machine, not the personality (B-36).
 *
 * The list is short on purpose: a deployment should be able to change almost
 * everything about how an agent *thinks*, and nothing about how the brain *runs*.
 */
export const PROTECTED_SPEC_FIELDS = Object.freeze([
  'schema_version', 'platform_version', 'digest', 'bundle',
  'capabilities', 'egress_class', 'secret_handles',
]);

/** Overlay layers, in composition order. Later wins for the fields it may set. */
export const OVERLAY_ORDER = Object.freeze(['role', 'deployment', 'agent']);

/**
 * Compose the persona overlays for one organ into rendered markdown.
 *
 * Order is the composition order, and it is deliberate: the base firmware is the
 * subject, the role gives it a job, the deployment gives it a culture, and the
 * agent overlay gives it whatever it has personally learned. Reversing any pair
 * would let a narrower layer be overwritten by a broader one.
 */
export function composePersona(organ, firmware, overlays) {
  const ordered = OVERLAY_ORDER
    .flatMap((layer) => overlays.filter((o) => (o.layer || 'role') === layer && o.organ === organ));

  const parts = [firmware.trimEnd()];
  for (const overlay of ordered) {
    const body = String(overlay.body || '').trim();
    if (!body) continue;
    parts.push(`\n\n<!-- ${overlay.layer || 'role'}: ${overlay.id} ${overlay.revision} -->\n\n${body}`);
  }
  return `${parts.join('')}\n`;
}

/**
 * Compute the capability closure for a role and report anything unsatisfied.
 *
 * The closure question is not "what does this role want" but "what will actually
 * be granted, and does every skill it holds stay inside that". A skill binding a
 * capability the role does not declare is the exact shape of privilege creep
 * C-33 exists to stop, and it fails the compile rather than surfacing at runtime
 * as a confusing "command not found".
 */
export function capabilityClosure(role, skills) {
  const declared = new Set(role.capabilities || []);
  const required = new Map(); // capability → skill ids that need it

  for (const skill of skills) {
    for (const cap of skill.tool_bindings || []) {
      if (!required.has(cap)) required.set(cap, []);
      required.get(cap).push(skill.id);
    }
  }

  const missing = [];
  for (const [cap, users] of required) {
    if (!declared.has(cap)) missing.push({ capability: cap, requiredBy: users });
  }

  // A declared capability nothing uses is not an error — a role may hold reach it
  // has not needed yet — but it is worth surfacing, because it is usually either
  // a typo or privilege nobody justified.
  const unused = [...declared].filter((c) => !required.has(c));

  return { granted: [...declared].sort(), missing, unused };
}

/**
 * Resolve the egress class for a spec.
 *
 * Widening is the direction that matters: `none` < `tenant` < `declared`. An
 * overlay may narrow, never widen, so a role cannot acquire network reach by
 * being assigned to a project.
 */
const EGRESS_RANK = { none: 0, tenant: 1, declared: 2 };

export function resolveEgress(base, overlays) {
  let current = base || 'tenant';
  const hosts = new Set();
  for (const o of overlays) {
    if (!o.egress_class) continue;
    if (EGRESS_RANK[o.egress_class] > EGRESS_RANK[current]) {
      // Refused, loudly: an overlay that tried to widen is a definition asking
      // for a capability it was not granted.
      return { egress_class: current, declared_hosts: [...hosts], widened_by: o.id };
    }
    current = o.egress_class;
    for (const h of o.declared_hosts || []) hosts.add(h);
  }
  return { egress_class: current, declared_hosts: [...hosts].sort(), widened_by: null };
}

/**
 * Compile an Effective Agent Spec.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.platformVersion
 * @param {string} input.fleetRelease
 * @param {object} input.role                 - sealed Role revision
 * @param {object[]} input.personas           - sealed Persona revisions
 * @param {object[]} input.skills             - sealed Skill revisions
 * @param {object[]} input.responsibilities   - sealed Responsibility revisions
 * @param {Record<string,string>} input.firmware - organ → base SOUL text (Foundation)
 * @param {object} [input.deploymentDefaults] - policy applied under the role
 * @param {object} [input.projectOverlay]
 * @param {object} [input.agentOverlay]
 * @param {string} input.compiledAt           - ISO timestamp, supplied so the compile is pure
 * @returns {{ spec: object, files: Record<string,string>, closure: object, warnings: string[] }}
 */
export function compileAgentSpec(input) {
  const {
    agentId, platformVersion, fleetRelease,
    role, personas = [], skills = [], responsibilities = [],
    firmware = {}, deploymentDefaults = {}, projectOverlay = {}, agentOverlay = {},
    compiledAt,
  } = input;

  if (!agentId) throw new Error('compileAgentSpec requires an agentId');
  if (!role?.id) throw new Error('compileAgentSpec requires a sealed Role revision');
  if (!compiledAt) throw new Error('compileAgentSpec requires compiledAt — the compile must be pure');

  const warnings = [];

  // ---- Capability closure (C-33) ----
  const closure = capabilityClosure(role, skills);
  if (closure.missing.length) {
    const detail = closure.missing
      .map((m) => `${m.capability} (required by ${m.requiredBy.join(', ')})`)
      .join('; ');
    throw new Error(
      `capability closure failed for role '${role.id}': ${detail}. ` +
      `A skill cannot drive a capability its role does not declare (C-33). ` +
      `If the capability does not exist at all, that is a Platform Finding (C-34).`
    );
  }
  for (const cap of closure.unused) warnings.push(`role '${role.id}' declares '${cap}' but no assigned skill uses it`);

  // ---- Protected firmware (B-36) ----
  for (const overlay of [deploymentDefaults, projectOverlay, agentOverlay]) {
    for (const field of PROTECTED_SPEC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(overlay || {}, field)) {
        throw new Error(
          `overlay attempts to set protected field '${field}'. ` +
          `A deployment composes disposition onto an organ; it does not redefine the wiring (B-36).`
        );
      }
    }
  }

  // ---- Egress ----
  const egress = resolveEgress(role.egress_class, [projectOverlay, agentOverlay].filter(Boolean));
  if (egress.widened_by) {
    throw new Error(
      `overlay '${egress.widened_by}' attempts to widen egress beyond '${egress.egress_class}'. ` +
      `Overlays may narrow reach, never broaden it (C-33).`
    );
  }

  // ---- Rendered bundle ----
  const files = {};
  const organs = new Set([...Object.keys(firmware), ...personas.map((p) => p.organ)]);
  for (const organ of [...organs].sort()) {
    const base = firmware[organ];
    if (base === undefined) {
      warnings.push(`persona overlay targets organ '${organ}' which has no base firmware — skipped`);
      continue;
    }
    files[`workspace-${organ}/SOUL.md`] = composePersona(organ, base, personas);
  }

  for (const skill of skills) {
    files[`skills/${skill.id}/SKILL.md`] = renderSkillDoc(skill);
    files[`skills/${skill.id}/skill.json`] = JSON.stringify(skillMetadata(skill), null, 2) + '\n';
  }

  if (responsibilities.length) {
    files['corekit/responsibilities-job.json'] =
      JSON.stringify({ version: 2, responsibilities: responsibilities.map(responsibilityRecord) }, null, 2) + '\n';
  }

  const fileDigests = {};
  for (const [path, content] of Object.entries(files)) fileDigests[path] = bytesDigest(content);

  // ---- The spec ----
  const spec = {
    schema_version: EFFECTIVE_AGENT_SPEC_SCHEMA.version,
    agent_id: agentId,
    platform_version: platformVersion,
    fleet_release: fleetRelease,
    digest: 'sha256:' + '0'.repeat(64), // placeholder; replaced below
    compiled_at: compiledAt,
    role: { id: role.id, revision: role.revision },
    personas: personas.map((p) => ({ id: p.id, revision: p.revision })),
    skills: skills.map((s) => ({ id: s.id, revision: s.revision })),
    responsibilities: responsibilities.map((r) => ({ id: r.id, revision: r.revision })),
    capabilities: closure.granted,
    secret_handles: [...(role.secret_handles || [])].sort(),
    egress_class: egress.egress_class,
    declared_hosts: egress.declared_hosts,
    model_policy: { ...(deploymentDefaults.model_policy || {}), ...(role.model_policy ? { policy: role.model_policy } : {}) },
    memory_policy: { ...(deploymentDefaults.memory_policy || {}), ...(role.memory_policy ? { policy: role.memory_policy } : {}) },
    bundle: { tree_digest: treeDigest(files), files: fileDigests },
  };

  // ---- What the digest covers, and what it deliberately does not ----
  //
  // `agentSpecDigest` answers one question: *what content is this agent
  // running*. So it covers the definition revisions, the capability closure and
  // the rendered bundle — and excludes the platform and release coordinates.
  //
  // Including `platform_version` was a real error, caught by the canary: every
  // platform upgrade changed the digest even when no content changed, so work
  // done before and after an upgrade could never be grouped, and the rollout gate
  // saw zero missions for a release that had run several. It also made the digest
  // redundant — C-32 stamps three coordinates precisely because they answer three
  // different questions, and a digest that already encoded the platform version
  // would make the first of them noise.
  //
  // `fleet_release` is excluded for the same reason in the other direction: two
  // releases that leave an agent's content identical should yield the identical
  // digest, so "nothing changed for this agent" is visible rather than inferred.
  spec.digest = contentDigest(spec, {
    exclude: ['digest', 'compiled_at', 'platform_version', 'fleet_release'],
  });

  assertValid(EFFECTIVE_AGENT_SPEC_SCHEMA, spec, `effectiveAgentSpec/${agentId}`);
  return { spec, files, closure, warnings };
}

/** Render a Skill definition back into the SKILL.md an organ reads. */
export function renderSkillDoc(skill) {
  const lines = [`# ${skill.name}`, '', skill.summary, ''];

  if (skill.triggers?.length) {
    lines.push('## When to use', '');
    for (const t of skill.triggers) lines.push(`- ${t}`);
    lines.push('');
  }

  lines.push('## Procedure', '', skill.procedure.trim(), '');

  if (skill.recovery?.length) {
    lines.push('## Error recovery', '', '| Symptom | Cause | Action |', '|---|---|---|');
    for (const r of skill.recovery) {
      lines.push(`| ${r.symptom} | ${r.cause || '—'} | ${r.action} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** The skill.json a runtime reads — derived, never hand-maintained. */
function skillMetadata(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.summary,
    revision: skill.revision,
    when_to_use: (skill.triggers || []).join('; '),
    scripts: (skill.tool_bindings || []).map((c) => c.split('.')[1]),
    agent_part: (skill.organs || [])[0] || 'motor',
  };
}

function responsibilityRecord(r) {
  return {
    id: r.id,
    name: r.name,
    revision: r.revision,
    trigger: r.trigger,
    instruction: r.instruction,
    success_criteria: r.success_criteria,
    target_agent: r.target_agent ?? null,
    project_id: r.project_id ?? null,
    enabled: r.enabled !== false,
  };
}
