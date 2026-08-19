// platform/contracts/ids.mjs — the canonical ID and path catalog (Foundation)
//
// One place that answers "what is this thing called and where does it live".
// Before this catalog, storage paths were string-built at each call site, which
// is how `work` ended up written under both `primes/{id}/work` and root `work/`,
// and how the Firestore index provisioner came to declare indexes for a `plans`
// collection nothing writes.
//
// Every path here is a *deployment-rooted* collection unless the entity is
// genuinely actor state. C-1: work artifacts belong to the deployment, not to a
// Prime subcollection; fleet, messages and commands legitimately stay
// prime-scoped because they describe an actor.

// ── ID grammar ─────────────────────────────────────────────────────────
//
// Lowercase kebab-case. Deliberately narrow: these ids appear in Firestore
// document paths, git-store paths, filesystem paths and URLs, and the
// intersection of what all four accept safely is small.

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/** A revision id is content-derived and immutable: `rev-<12 hex>`. */
export const REVISION_PATTERN = /^rev-[0-9a-f]{12}$/;

/** A digest is always fully qualified so its algorithm is never implied. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A Foundation release pins a full commit — never a branch or tag (C-35). */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * Normalize a human-supplied name into a legal id.
 *
 * Returns null rather than a mangled fallback when nothing legal survives —
 * a silently-renamed entity is worse than a rejected one.
 */
export function toId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return isValidId(id) ? id : null;
}

// ── Storage catalog ────────────────────────────────────────────────────

/**
 * Every persisted aggregate: its plane, its store, and how to address it.
 *
 * `plane` is the governance plane (C-29) — it is what tells a reader whether a
 * record may be authored by Prime, only by a platform release, or only by the
 * runtime.
 */
export const CATALOG = {
  // ---- Runtime State: what is happening and what happened ----
  work: {
    plane: 'runtime-state',
    store: 'firestore',
    path: (id) => `work/${id}`,
    collection: () => 'work',
    describe: 'R/M/C/T envelopes, deployment-rooted, scoped by `owner` (C-1)',
  },
  approval: {
    plane: 'runtime-state',
    store: 'firestore',
    path: (id) => `approvals/${id}`,
    collection: () => 'approvals',
    describe: 'Approval requests and their consumed tokens',
  },
  project: {
    plane: 'runtime-state',
    store: 'firestore',
    path: (id) => `projects/${id}`,
    collection: () => 'projects',
    describe: 'Project records — the working areas work is scoped to',
  },
  coreMemory: {
    plane: 'runtime-state',
    store: 'firestore',
    path: (agentId, id) => `agents/${agentId}/core_memory/${id}`,
    collection: (agentId) => `agents/${agentId}/core_memory`,
    describe: 'Durable agent facts with provenance and supersession',
  },
  fleetAgent: {
    plane: 'runtime-state',
    store: 'firestore',
    path: (primeId, agent) => `primes/${primeId}/fleet/${agent}`,
    collection: (primeId) => `primes/${primeId}/fleet`,
    describe: 'Fleet registry — actor state, legitimately prime-scoped',
  },

  // ---- Fleet Definition: what this deployment's agents are ----
  // Content lives in the tenant git-store repo; Firestore holds transactional
  // metadata and the active pointers (C-31).
  role: {
    plane: 'fleet-definition',
    store: 'git-store',
    path: (id) => `roles/${id}/role.json`,
    describe: 'Canonical role definition — replaces the agent-types/kit.json/job-manifest triad',
  },
  persona: {
    plane: 'fleet-definition',
    store: 'git-store',
    path: (roleId, organ) => `roles/${roleId}/souls/${organ}.md`,
    describe: 'Role soul overlay for one organ',
  },
  skill: {
    plane: 'fleet-definition',
    store: 'git-store',
    path: (id) => `skills/${id}/skill.json`,
    docPath: (id) => `skills/${id}/SKILL.md`,
    describe: 'Declarative skill definition and its procedure',
  },
  process: {
    plane: 'fleet-definition',
    store: 'git-store',
    path: (id) => `processes/${id}.json`,
    describe: 'Narrative playbook',
  },
  responsibility: {
    plane: 'fleet-definition',
    store: 'git-store',
    path: (id) => `responsibilities/${id}.json`,
    describe: 'Schedule or event rule with its instruction and success criteria',
  },
  // ---- Fleet Definition: transactional metadata and active pointers ----
  fleetChange: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (id) => `fleet_changes/${id}`,
    collection: () => 'fleet_changes',
    describe: 'A draft: base revision, author, semantic diff, rationale',
  },
  fleetRelease: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (id) => `fleet_releases/${id}`,
    collection: () => 'fleet_releases',
    describe: 'Immutable content ref + digest, compatibility, evidence, parent',
  },
  fleetEvaluation: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (id) => `fleet_evaluations/${id}`,
    collection: () => 'fleet_evaluations',
    describe: 'A pinned baseline/candidate comparison and its results',
  },
  fleetAssignment: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (agentId) => `fleet_assignments/${agentId}`,
    collection: () => 'fleet_assignments',
    describe: 'Desired release and role for one agent, plus rollout state',
  },
  fleetRollout: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (id) => `fleet_rollouts/${id}`,
    collection: () => 'fleet_rollouts',
    describe: 'Canary cohort, progress, thresholds, rollback target',
  },

  // ---- The bridge ----
  platformFinding: {
    plane: 'fleet-definition',
    store: 'firestore',
    path: (id) => `platform_findings/${id}`,
    collection: () => 'platform_findings',
    describe: 'The only deployment→repository escalation packet (C-34)',
  },
};

/** The tenant-local git-store repository that holds Fleet Definition content. */
export const FLEET_CONFIG_REPO = 'system-fleet-config';

/** The branch whose tip is the deployment's working definition set. */
export const FLEET_CONFIG_BRANCH = 'main';

/**
 * Resolve a storage path for an aggregate.
 *
 * @param {keyof CATALOG} kind
 * @param {...string} parts
 */
export function pathFor(kind, ...parts) {
  const entry = CATALOG[kind];
  if (!entry) throw new Error(`Unknown aggregate '${kind}' — add it to the catalog before storing it`);
  return entry.path(...parts);
}

/** The governance plane an aggregate belongs to. */
export function planeOf(kind) {
  const entry = CATALOG[kind];
  if (!entry) throw new Error(`Unknown aggregate '${kind}'`);
  return entry.plane;
}

/** Every aggregate in one plane. */
export function aggregatesInPlane(plane) {
  return Object.keys(CATALOG).filter((k) => CATALOG[k].plane === plane);
}

/**
 * Generate a revision id from a content digest.
 *
 * Deriving it from content rather than a counter means re-authoring identical
 * content yields the identical revision, so a no-op edit does not manufacture
 * history (C-31).
 */
export function revisionFromDigest(digest) {
  const hex = String(digest || '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Cannot derive a revision from '${digest}'`);
  return `rev-${hex.slice(0, 12)}`;
}
