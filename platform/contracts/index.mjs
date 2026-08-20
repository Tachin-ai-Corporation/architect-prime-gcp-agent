// platform/contracts/index.mjs — the contracts package (Foundation)
//
// One executable definition of every persisted shape in the system, and the
// helpers that make a definition revision immutable and content-addressed.
//
// The point of this package is that there is exactly one of it. The daemon, the
// control plane, shell tools and migration scripts previously each carried their
// own idea of a record's shape; that is how a Project could be written by the
// dashboard in a form no agent could read. A schema here is the authority — the
// dashboard's TypeScript types are generated from it (`corekit/system/gen-types`),
// not maintained beside it.
//
// Nothing here touches the network or the filesystem. Schemas and digests are
// pure, so they can be exercised in CI with no credentials and reused in a
// browser bundle without a shim.

export {
  validate,
  assertValid,
  coerce,
  fieldPaths,
} from './validate.mjs';

export {
  canonicalize,
  canonicalJson,
  contentDigest,
  bytesDigest,
  treeDigest,
  sameContent,
  shortDigest,
  NON_CONTENT_FIELDS,
} from './digest.mjs';

export {
  CATALOG,
  FLEET_CONFIG_REPO,
  FLEET_CONFIG_BRANCH,
  ID_PATTERN,
  REVISION_PATTERN,
  DIGEST_PATTERN,
  COMMIT_SHA_PATTERN,
  isValidId,
  toId,
  pathFor,
  planeOf,
  aggregatesInPlane,
  revisionFromDigest,
} from './ids.mjs';

import {
  ROLE_SCHEMA, PERSONA_SCHEMA, SKILL_SCHEMA, PROCESS_SCHEMA,
  RESPONSIBILITY_SCHEMA,
  PROVENANCE_FIELDS, SCOPE_SPEC,
} from './schemas/definition.mjs';

import {
  CHANGE_SCHEMA, RELEASE_SCHEMA, EVALUATION_SCHEMA,
  ASSIGNMENT_SCHEMA, ROLLOUT_SCHEMA, PLATFORM_FINDING_SCHEMA,
} from './schemas/lifecycle.mjs';

import {
  WORK_SCHEMA, APPROVAL_SCHEMA, PROJECT_SCHEMA,
  ENVELOPE_TYPES, ENVELOPE_STATUSES, TERMINAL_STATUSES,
} from './schemas/runtime.mjs';

import {
  EFFECTIVE_AGENT_SPEC_SCHEMA, FOUNDATION_RELEASE_SCHEMA,
} from './schemas/spec.mjs';

import { contentDigest } from './digest.mjs';
import { revisionFromDigest, planeOf, CATALOG } from './ids.mjs';
import { assertValid, coerce } from './validate.mjs';

export {
  ROLE_SCHEMA, PERSONA_SCHEMA, SKILL_SCHEMA, PROCESS_SCHEMA,
  RESPONSIBILITY_SCHEMA,
  CHANGE_SCHEMA, RELEASE_SCHEMA, EVALUATION_SCHEMA,
  ASSIGNMENT_SCHEMA, ROLLOUT_SCHEMA, PLATFORM_FINDING_SCHEMA,
  WORK_SCHEMA, APPROVAL_SCHEMA, PROJECT_SCHEMA,
  EFFECTIVE_AGENT_SPEC_SCHEMA, FOUNDATION_RELEASE_SCHEMA,
  PROVENANCE_FIELDS, SCOPE_SPEC,
  ENVELOPE_TYPES, ENVELOPE_STATUSES, TERMINAL_STATUSES,
};

/** Every schema, keyed by the aggregate name used in the storage catalog. */
export const SCHEMAS = {
  // Fleet Definition content
  role: ROLE_SCHEMA,
  persona: PERSONA_SCHEMA,
  skill: SKILL_SCHEMA,
  process: PROCESS_SCHEMA,
  responsibility: RESPONSIBILITY_SCHEMA,
  // Fleet Definition lifecycle
  fleetChange: CHANGE_SCHEMA,
  fleetRelease: RELEASE_SCHEMA,
  fleetEvaluation: EVALUATION_SCHEMA,
  fleetAssignment: ASSIGNMENT_SCHEMA,
  fleetRollout: ROLLOUT_SCHEMA,
  platformFinding: PLATFORM_FINDING_SCHEMA,
  // Runtime State
  work: WORK_SCHEMA,
  approval: APPROVAL_SCHEMA,
  project: PROJECT_SCHEMA,
};

/** Compiled artifacts — produced by the platform, not stored as aggregates. */
export const COMPILED_SCHEMAS = {
  effectiveAgentSpec: EFFECTIVE_AGENT_SPEC_SCHEMA,
  foundationRelease: FOUNDATION_RELEASE_SCHEMA,
};

/** The aggregate kinds that are Fleet Definition *content* (authorable by Prime). */
export const DEFINITION_KINDS = [
  'role', 'persona', 'skill', 'process',
  'responsibility',
];

export function schemaFor(kind) {
  const s = SCHEMAS[kind] || COMPILED_SCHEMAS[kind];
  if (!s) throw new Error(`No schema for '${kind}' — declare it in corekit/contracts before persisting it`);
  return s;
}

/**
 * Seal a definition into an immutable revision.
 *
 * Applies defaults, computes the content digest, derives the revision from it,
 * and validates the result. Sealing is idempotent by construction: identical
 * content yields the identical revision, so a no-op edit does not manufacture
 * history (C-31).
 *
 * @param {string} kind
 * @param {object} draft - the definition body, with or without provenance
 * @param {{ actor: string, parentRevision?: string|null, now?: string }} ctx
 * @returns {object} the sealed revision
 */
export function sealRevision(kind, draft, ctx) {
  if (!DEFINITION_KINDS.includes(kind)) {
    throw new Error(`'${kind}' is not authorable Fleet Definition content (${DEFINITION_KINDS.join(', ')})`);
  }
  if (!ctx?.actor) throw new Error('sealRevision requires an actor — every revision is attributable (C-31)');

  const schema = schemaFor(kind);
  const now = ctx.now || new Date().toISOString();

  const body = coerce(schema, {
    ...draft,
    kind,
    schema_version: schema.version,
    created_at: draft.created_at || now,
    created_by: ctx.actor,
    parent_revision: ctx.parentRevision ?? draft.parent_revision ?? null,
  });

  const digest = contentDigest(body);
  const sealed = { ...body, digest, revision: revisionFromDigest(digest) };

  assertValid(schema, sealed, `${kind}/${sealed.id}`);
  return sealed;
}

/**
 * Verify a sealed revision still matches its own digest.
 *
 * The check that makes tampering detectable: a definition read back from storage
 * whose content no longer hashes to its recorded digest was edited outside the
 * lifecycle, and must not be trusted or activated.
 */
export function verifyRevision(kind, record) {
  const schema = schemaFor(kind);
  const { valid, errors } = validateRecord(schema, record);
  if (!valid) {
    // A schema failure on a sealed record is NOT tampering. The commonest cause is
    // a schema that evolved after the record was sealed (a v1 responsibility read
    // by v2 code) — the content is authentic, it just predates the field set.
    // Carry a `code` so callers can say "re-author or migrate" instead of raising
    // a false integrity alarm. The digest check below is what actually detects
    // tampering, and it can only be trusted to mean tampering once schema is ruled
    // out — so schema is checked, and reported, first.
    return { ok: false, code: 'schema', reason: `schema: ${errors[0].path || '(root)'} ${errors[0].message}` };
  }

  const recomputed = contentDigest(record);
  if (recomputed !== record.digest) {
    return { ok: false, code: 'integrity', reason: `digest mismatch — content was modified outside the lifecycle (C-31)` };
  }
  if (record.revision !== revisionFromDigest(recomputed)) {
    return { ok: false, code: 'integrity', reason: 'revision does not derive from the digest' };
  }
  return { ok: true, code: 'ok', reason: 'content verified' };
}

// Local alias so verifyRevision does not depend on the re-export above.
import { validate as validateRecord } from './validate.mjs';

/** The governance plane every schema belongs to — used by the boundary tests. */
export function planeOfSchema(kind) {
  if (CATALOG[kind]) return planeOf(kind);
  if (COMPILED_SCHEMAS[kind]) return 'foundation';
  throw new Error(`Unknown schema '${kind}'`);
}
