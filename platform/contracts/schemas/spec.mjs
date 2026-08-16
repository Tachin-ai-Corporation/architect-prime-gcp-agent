// platform/contracts/schemas/spec.mjs — the two compiled artifacts (Foundation)
//
// EffectiveAgentSpec is what a brain actually reads (B-35): one deterministic,
// immutable bundle instead of independently resolving overlapping role metadata,
// install manifests, SOUL appends, skill indexes and local config and hoping
// they agree.
//
// FoundationRelease is the platform's own unit of activation (C-35): the thing a
// human channel like STABLE resolves *to* before anything is installed.

import { ID_PATTERN, REVISION_PATTERN, DIGEST_PATTERN, COMMIT_SHA_PATTERN } from '../ids.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const schema = (id, version, properties, check) => ({
  id, version, spec: { type: 'object', properties, check },
});

const REF = {
  type: 'object',
  properties: {
    id: { type: 'string', required: true, pattern: ID_PATTERN },
    revision: { type: 'string', required: true, pattern: REVISION_PATTERN },
  },
};

// ── Effective Agent Spec ───────────────────────────────────────────────

export const EFFECTIVE_AGENT_SPEC_SCHEMA = schema('effectiveAgentSpec', 1, {
  schema_version: { type: 'integer', required: true, min: 1 },
  agent_id: { type: 'string', required: true, pattern: ID_PATTERN },

  // The two version coordinates that make behavior attributable (C-32).
  platform_version: { type: 'string', required: true, describe: 'The Foundation release that compiled this' },
  fleet_release: { type: 'string', required: true, pattern: /^fr-[a-z0-9-]+$/ },
  digest: {
    type: 'string', required: true, pattern: DIGEST_PATTERN,
    describe: 'Content address of this spec. Stamped on every mission; the replay key.',
  },
  compiled_at: { type: 'string', required: true, pattern: ISO_DATE },

  role: { ...REF, required: true },
  personas: { type: 'array', required: true, items: REF, default: [], describe: 'In composition order' },
  skills: { type: 'array', required: true, items: REF, default: [] },
  responsibilities: { type: 'array', required: true, items: REF, default: [] },

  capabilities: {
    type: 'array', required: true, items: { type: 'string' }, default: [],
    describe: 'The closure. The runtime grants exactly this and nothing more (C-33).',
  },
  secret_handles: {
    type: 'array', required: true, items: { type: 'string' }, default: [],
    describe: 'Opaque handles. Values are injected into the authorized process, never into this spec (C-8).',
  },
  egress_class: { type: 'string', required: true, enum: ['none', 'tenant', 'declared'], default: 'tenant' },
  declared_hosts: { type: 'array', items: { type: 'string' }, default: [] },

  model_policy: { type: 'object', open: true, required: true, default: {} },
  memory_policy: { type: 'object', open: true, required: true, default: {} },

  bundle: {
    type: 'object', required: true,
    describe: 'The rendered files this spec resolves to, and their collective identity.',
    properties: {
      tree_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
      files: {
        type: 'object', open: true, required: true,
        describe: 'path → content digest. A file moved is a different bundle.',
      },
    },
  },
}, (spec) => {
  // C-8: the single most damaging thing that could end up in a compiled bundle.
  const handles = spec.secret_handles || [];
  for (const h of handles) {
    if (/[:=]/.test(h) || h.length > 64) return `secret_handles must be handles, not values (saw '${h.slice(0, 16)}…')`;
  }
  if (spec.egress_class === 'declared' && !(spec.declared_hosts?.length)) {
    return 'egress_class "declared" requires declared_hosts';
  }
  return null;
});

// ── Foundation release ─────────────────────────────────────────────────

export const FOUNDATION_RELEASE_SCHEMA = schema('foundationRelease', 1, {
  schema_version: { type: 'integer', required: true, min: 1 },
  release_id: { type: 'string', required: true, describe: 'Canonical, human-referenceable — e.g. v2026.08.15.2.0' },
  source_sha: {
    type: 'string', required: true, pattern: COMMIT_SHA_PATTERN,
    describe: 'Full commit. A branch or tag is not activatable (C-35).',
  },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },

  artifacts: {
    type: 'object', required: true,
    describe: 'Every activatable piece, addressed immutably.',
    properties: {
      corekit_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
      control_plane_image: {
        type: 'string', required: true,
        describe: 'Fully-qualified image reference including its immutable tag or digest — never `:latest`',
        pattern: /@sha256:[0-9a-f]{64}$|:[0-9a-f]{40}$/,
      },
      installer_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
      manifest_graph_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
    },
  },

  epochs: {
    type: 'object', required: true,
    describe: 'Compatibility coordinates. A definition or a state document declares which epoch it was written for.',
    properties: {
      contract_epoch: { type: 'integer', required: true, min: 1 },
      state_schema_epoch: { type: 'integer', required: true, min: 1 },
      fleet_definition_schema: {
        type: 'object', required: true,
        properties: {
          min: { type: 'integer', required: true, min: 1 },
          max: { type: 'integer', required: true, min: 1 },
        },
      },
    },
  },

  migrations: {
    type: 'array', required: true, default: [],
    describe: 'Ordered, checksummed, and each individually reversible or forward-repairable.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', required: true },
        checksum: { type: 'string', required: true, pattern: DIGEST_PATTERN },
        direction: { type: 'string', required: true, enum: ['expand', 'migrate', 'contract'] },
        reversible: { type: 'boolean', required: true },
      },
    },
  },

  provenance: {
    type: 'object', required: true,
    properties: {
      builder: { type: 'string', required: true },
      built_at: { type: 'string', required: true, pattern: ISO_DATE },
      sbom_digest: { type: 'string', nullable: true, pattern: DIGEST_PATTERN },
      signature: { type: 'string', nullable: true },
    },
  },

  rollback_target: {
    type: 'string', nullable: true,
    describe: 'The previous supported release. Named at build time, not improvised during an incident.',
  },
}, (rel) => {
  const e = rel.epochs?.fleet_definition_schema;
  if (e && e.min > e.max) return 'fleet_definition_schema min exceeds max';
  // Expand → migrate → verify → switch readers → contract later. A release that
  // contracts before it has expanded destroys the rollback path.
  const dirs = (rel.migrations || []).map((m) => m.direction);
  if (dirs.includes('contract') && !dirs.includes('expand') && dirs.indexOf('contract') === 0) {
    return 'a release cannot open with a contract migration — expand and migrate must precede it';
  }
  return null;
});
