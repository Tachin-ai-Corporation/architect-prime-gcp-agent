// platform/contracts/schemas/definition.mjs — Fleet Definition content (Foundation-owned schemas)
//
// These schemas are Foundation; the records they describe are Fleet Definition.
// That distinction is the whole architecture in one file: the *shape* of a role
// is platform machinery and changes only by release, while *the roles this
// deployment has* are authored by Prime and change constantly (C-29).
//
// Every definition carries the same provenance envelope so any revision can
// answer: what am I, which revision, derived from what, authored by whom, valid
// against which platform, and what evidence backs me (C-31).

import { ID_PATTERN, REVISION_PATTERN, DIGEST_PATTERN } from '../ids.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A capability reference: `tool.<provider>.<action>` — see the capability closure check. */
const CAPABILITY_PATTERN = /^tool\.[a-z0-9-]+\.[a-z0-9-]+$/;

/** Scope narrows where a definition applies. Absent means deployment-wide. */
export const SCOPE_SPEC = {
  type: 'object',
  describe: 'Where this definition applies. Absent fields widen; present fields narrow.',
  properties: {
    project_ids: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, describe: 'Limit to these projects' },
    role_ids: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, describe: 'Limit to these roles' },
    agent_ids: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, describe: 'Limit to these agents' },
  },
};

/**
 * The provenance envelope every definition revision carries.
 *
 * Spread into each schema rather than nested, because these fields are queried
 * and compared constantly and a nesting level buys nothing.
 */
export const PROVENANCE_FIELDS = {
  id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'Stable identity across revisions' },
  kind: { type: 'string', required: true, describe: 'Aggregate name from the catalog' },
  schema_version: { type: 'integer', required: true, min: 1, describe: 'Which version of this schema the record was written against' },
  revision: { type: 'string', required: true, pattern: REVISION_PATTERN, describe: 'Immutable, derived from the content digest' },
  digest: { type: 'string', required: true, pattern: DIGEST_PATTERN, describe: 'Content address of this revision' },
  parent_revision: { type: 'string', nullable: true, pattern: REVISION_PATTERN, describe: 'The revision this was derived from; null for the first' },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  created_by: { type: 'string', required: true, minLength: 1, describe: 'Actor identity — an agent id or an operator email' },
  scope: SCOPE_SPEC,
  platform_compat: {
    type: 'object',
    describe: 'Foundation versions this definition is valid against (C-36 N/N-1 policy)',
    properties: {
      min: { type: 'string', describe: 'Earliest supported platformVersion' },
      max: { type: 'string', nullable: true, describe: 'Latest supported platformVersion; null means open-ended' },
    },
  },
  evidence: {
    type: 'object',
    describe: 'What backs this revision. Required before high-scope promotion (C-31).',
    properties: {
      validated_at: { type: 'string', nullable: true, pattern: ISO_DATE },
      evaluation_ids: { type: 'array', items: { type: 'string' }, default: [] },
      rationale: { type: 'string', maxLength: 4000, describe: 'Why this change, in the author\'s words' },
    },
  },
  status: {
    type: 'string',
    enum: ['draft', 'active', 'deprecated'],
    default: 'draft',
    describe: 'draft is authorable; active is released; deprecated is retained for rollback',
  },
};

const definitionSchema = (id, version, properties, check) => ({
  id,
  version,
  spec: { type: 'object', properties: { ...PROVENANCE_FIELDS, ...properties }, check },
});

// ── Role ───────────────────────────────────────────────────────────────
//
// Replaces the tri-source authority (corekit/config/agent-types.json +
// specialties/*/kit.json + infra/manifests/job-*.txt). Those three had to agree
// by hand; validate-contracts existed partly to catch when they did not. One
// definition, and the manifests become generated output.

export const ROLE_SCHEMA = definitionSchema('role', 1, {
  name: { type: 'string', required: true, minLength: 1, maxLength: 80, describe: 'Human-facing role name' },
  purpose: { type: 'string', required: true, minLength: 20, maxLength: 2000, describe: 'What this role exists to do' },
  owned_outcomes: {
    type: 'array', required: true, minLength: 1, items: { type: 'string', minLength: 5 },
    describe: 'The results this role is accountable for — not the tasks it performs',
  },
  decision_posture: { type: 'string', maxLength: 2000, describe: 'How this role decides: bias, risk tolerance, when it asks' },
  collaboration: {
    type: 'object',
    describe: 'How this role works with others — what it delegates and what it accepts',
    properties: {
      delegates_to: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, default: [] },
      accepts_from: { type: 'array', items: { type: 'string', pattern: ID_PATTERN }, default: [] },
      escalation: { type: 'string', maxLength: 1000, describe: 'When and to whom this role escalates' },
    },
  },
  default_skills: {
    type: 'array', required: true, items: { type: 'string', pattern: ID_PATTERN }, default: [],
    describe: 'Skill ids installed for this role. Every one must resolve (reference check).',
  },
  responsibilities: {
    type: 'array', items: { type: 'string', pattern: ID_PATTERN }, default: [],
    describe: 'Responsibility ids enabled for this role',
  },
  capabilities: {
    type: 'array', required: true, items: { type: 'string', pattern: CAPABILITY_PATTERN }, default: [],
    describe: 'Declared capability closure. A role cannot use what it does not declare (C-33).',
  },
  secret_handles: {
    type: 'array', items: { type: 'string', pattern: ID_PATTERN }, default: [],
    describe: 'Opaque handles only — never values (C-8)',
  },
  souls: {
    type: 'object', open: true,
    describe: 'organ → soul overlay revision. Overlays add disposition; they cannot reach firmware (B-36).',
  },
  model_policy: { type: 'string', pattern: ID_PATTERN, nullable: true, describe: 'Policy id, or null for the deployment default' },
  memory_policy: { type: 'string', pattern: ID_PATTERN, nullable: true },
}, (role) => {
  // A role that delegates to itself is almost always a copy-paste error, and it
  // produces a mission that can loop forever without ever looking wrong.
  if (role.collaboration?.delegates_to?.includes(role.id)) {
    return `role '${role.id}' delegates to itself`;
  }
  return null;
});

// ── Persona (soul overlay) ─────────────────────────────────────────────

export const PERSONA_SCHEMA = definitionSchema('persona', 1, {
  organ: {
    type: 'string', required: true,
    enum: ['cortex', 'prefrontal', 'motor', 'cerebellum', 'temporal-memory', 'temporal-research'],
    describe: 'Which organ this overlay composes onto',
  },
  role_id: { type: 'string', required: true, pattern: ID_PATTERN },
  body: {
    type: 'string', required: true, minLength: 1, maxLength: 40000,
    describe: 'Markdown appended during composition. Character and judgment only — no tool syntax (C-28).',
  },
  layer: {
    type: 'string', enum: ['role', 'deployment', 'agent'], default: 'role',
    describe: 'Composition order: role, then deployment culture, then agent profile',
  },
}, (persona) => {
  // C-28 layer purity, enforced where the content is written rather than only in
  // a CI grep — a backticked flag in a soul is the single most common leak.
  if (/`[^`\n]*\s--[a-z]/.test(persona.body || '')) {
    return 'contains a command flag — tool syntax belongs in a skill (C-28)';
  }
  return null;
});

// ── Skill (declarative) ────────────────────────────────────────────────

export const SKILL_SCHEMA = definitionSchema('skill', 1, {
  name: { type: 'string', required: true, minLength: 1, maxLength: 80 },
  summary: { type: 'string', required: true, minLength: 10, maxLength: 500, describe: 'One line: what capability this drives' },
  triggers: {
    type: 'array', required: true, minLength: 1, items: { type: 'string', minLength: 3 },
    describe: 'Selection cues — how an organ recognizes that this skill applies',
  },
  procedure: { type: 'string', required: true, minLength: 20, describe: 'The SKILL.md body: commands, flags, multi-step how-to' },
  recovery: {
    type: 'array', items: {
      type: 'object',
      properties: {
        symptom: { type: 'string', required: true },
        cause: { type: 'string' },
        action: { type: 'string', required: true },
      },
    },
    default: [],
    describe: 'Error-recovery rows. The difference between a skill and a man page.',
  },
  tool_bindings: {
    type: 'array', required: true, items: { type: 'string', pattern: CAPABILITY_PATTERN }, default: [],
    describe: 'Capabilities this skill drives. Must be a subset of the assigned role closure (C-33).',
  },
  organs: {
    type: 'array', items: { type: 'string' }, default: [],
    describe: 'Which organs may use this skill; empty means any',
  },
  package: {
    type: 'object', nullable: true,
    describe: 'Optional sandbox package. A skill that ships a privileged binary is a provider, not a skill (C-33).',
    properties: {
      entrypoint: { type: 'string', required: true },
      runtime: { type: 'string', required: true, enum: ['node', 'python3'] },
      limits: {
        type: 'object', required: true,
        properties: {
          cpu_seconds: { type: 'integer', required: true, min: 1, max: 300 },
          memory_mb: { type: 'integer', required: true, min: 16, max: 1024 },
          egress: { type: 'string', required: true, enum: ['none', 'tenant', 'declared'] },
          filesystem: { type: 'string', required: true, enum: ['none', 'workspace'] },
        },
      },
      declared_hosts: { type: 'array', items: { type: 'string' }, default: [] },
    },
  },
  eval_suite: { type: 'string', pattern: ID_PATTERN, nullable: true },
}, (skill) => {
  if (skill.package?.limits?.egress === 'declared' && !(skill.package.declared_hosts?.length)) {
    return 'declares egress class "declared" but names no hosts';
  }
  return null;
});

// ── Process (narrative playbook) ───────────────────────────────────────

export const PROCESS_SCHEMA = definitionSchema('process', 1, {
  name: { type: 'string', required: true, minLength: 1, maxLength: 80 },
  description: { type: 'string', required: true, minLength: 10, maxLength: 500 },
  narrative: {
    type: 'string', required: true, minLength: 50,
    describe: 'Prose. What has worked for this kind of work — recalled into the agent\'s own plan, never executed (C-15).',
  },
  intent_keywords: { type: 'array', required: true, minLength: 1, items: { type: 'string' }, describe: 'Recall cues' },
}, (process) => {
  // The process-as-narrative migration removed the step executor. A narrative
  // that reads as a numbered command sequence is the old shape reappearing.
  const n = process.narrative || '';
  if (/```/.test(n)) return 'narrative contains a code block — tool syntax belongs in a skill (C-28)';
  if (/^\s*\d+\.\s/m.test(n) && /\$\s|\bcurl\b|\bgcloud\b/.test(n)) {
    return 'narrative reads as an executable step list — a playbook is prose the agent adapts (C-15)';
  }
  return null;
});

// ── Responsibility ─────────────────────────────────────────────────────

export const RESPONSIBILITY_SCHEMA = definitionSchema('responsibility', 1, {
  name: { type: 'string', required: true, minLength: 1, maxLength: 80 },
  trigger: {
    type: 'object', required: true,
    properties: {
      kind: { type: 'string', required: true, enum: ['schedule', 'event'] },
      cron: { type: 'string', nullable: true, describe: 'Five-field cron; required when kind is schedule' },
      timezone: { type: 'string', default: 'UTC', describe: 'IANA zone — explicit, because DST silently shifts a fire time' },
      event: { type: 'string', nullable: true },
      catch_up: {
        type: 'string', enum: ['skip', 'once', 'all'], default: 'once',
        describe: 'What to do about fires missed while the agent was down',
      },
    },
  },
  instruction: { type: 'string', required: true, minLength: 10, describe: 'The goal handed to the agent when this fires' },
  success_criteria: { type: 'string', required: true, minLength: 10, describe: 'How the agent knows the firing succeeded' },
  target_agent: { type: 'string', nullable: true, describe: 'Agent id, or null to run on whichever agent holds the role' },
  project_id: { type: 'string', nullable: true, pattern: ID_PATTERN },
  enabled: { type: 'boolean', default: true },
}, (r) => {
  if (r.trigger?.kind === 'schedule' && !r.trigger.cron) return 'a schedule trigger requires a cron expression';
  if (r.trigger?.kind === 'event' && !r.trigger.event) return 'an event trigger requires an event name';
  return null;
});
