// corekit/lib/fleet-config/registry.mjs — the tenant-local Fleet Definition store
//
// Content lives in a git repository on the existing GCS/Firestore CAS substrate
// (`corekit/lib/git-store.mjs`): immutable history, no runtime GitHub dependency,
// no shared infrastructure (C-2). Firestore holds the transactional metadata and
// the active pointers — changes, releases, evaluations, assignments, rollouts —
// because those need compare-and-swap and querying, which a bundle store does not
// provide.
//
// The division matters. Putting definitions in Firestore alone would give a
// mutable blob with no history and no content address; putting pointers in git
// alone would make "which release is active" a race. Each store does the thing it
// is good at.
//
// Everything here is I/O. The decisions — what is valid, what compiles, what
// changed — are pure and live in their own modules (B-19).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import * as gitStore from '../git-store.mjs';
import { createClient } from '../firestore.mjs';
import { contentDigest } from '../../contracts/digest.mjs';
import { sealRevision, verifyRevision, DEFINITION_KINDS, CATALOG } from '../../contracts/index.mjs';
import { FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH, pathFor } from '../../contracts/ids.mjs';

const nowIso = () => new Date().toISOString();

/**
 * Create a registry bound to one deployment.
 *
 * @param {object} config
 * @param {string} config.projectId - GCP project (the tenant)
 * @param {string} config.actor     - who is authoring; every revision is attributable (C-31)
 * @param {function} [config.logger]
 */
export function createRegistry(config) {
  const { projectId, actor } = config;
  if (!projectId) throw new Error('createRegistry requires a projectId');
  const log = config.logger || ((level, msg) => console.error(`[fleet-config] ${level}: ${msg}`));

  // Both stores are injectable so the registry's decisions — conflict detection,
  // no-op detection, rollback targeting — can be exercised without GCP. The
  // decisions are the part worth testing; the transport is git-store's own.
  const db = config.db || createClient({ projectId, logger: (...a) => log('DEBUG', a.join(' ')) });
  const git = config.git || gitStore;

  // ---- Content: the fleet-config git repository ----

  async function ensureRepo() {
    await git.ensureRepo(FLEET_CONFIG_REPO, { defaultBranch: FLEET_CONFIG_BRANCH });
    return FLEET_CONFIG_REPO;
  }

  function workDir(suffix) {
    const dir = join(tmpdir(), `fleet-config-${suffix}-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Read the whole definition set from a branch or a release commit.
   *
   * Every revision is verified on read: content that no longer hashes to its
   * recorded digest was edited outside the lifecycle and must not be trusted or
   * activated (C-31). A corrupt revision is reported and excluded rather than
   * silently used.
   */
  async function readDefinitions({ branch = FLEET_CONFIG_BRANCH } = {}) {
    await ensureRepo();
    const dir = workDir('read');
    try {
      await git.cloneRepo(FLEET_CONFIG_REPO, branch, dir);
    } catch (e) {
      log('INFO', `registry is empty (${e.message})`);
      return { definitions: new Map(), corrupt: [], empty: true };
    }

    const definitions = new Map();
    const corrupt = [];

    for (const kind of DEFINITION_KINDS) {
      for (const { id, file } of listKind(dir, kind)) {
        let record;
        try {
          record = JSON.parse(readFileSync(file, 'utf8'));
        } catch (e) {
          corrupt.push({ kind, id, reason: `unparseable: ${e.message}` });
          continue;
        }
        const verdict = verifyRevision(kind, record);
        if (!verdict.ok) { corrupt.push({ kind, id, reason: verdict.reason }); continue; }
        definitions.set(`${kind}/${id}`, record);
      }
    }

    rmSync(dir, { recursive: true, force: true });
    return { definitions, corrupt, empty: false };
  }

  /** Enumerate the files of one aggregate kind inside a working tree. */
  function listKind(root, kind) {
    const entry = CATALOG[kind];
    if (!entry || entry.store !== 'git-store') return [];
    // Derive the directory from the catalog path rather than hard-coding it, so
    // a layout change is one edit in the catalog and not a hunt through here.
    const sample = entry.path('__id__', '__organ__');
    const dir = join(root, sample.split('/')[0]);
    if (!existsSync(dir)) return [];

    const out = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          if (parsed?.kind === kind && parsed?.id) out.push({ id: parsed.id, file: full });
        } catch { /* reported by the caller's parse attempt */ }
      }
    };
    walk(dir);
    return out;
  }

  /**
   * Write a set of definition revisions as one change, on its own branch.
   *
   * Compare-and-swap on `baseRevision`: an edit that assumed a revision which is
   * no longer current returns a conflict rather than overwriting whoever got
   * there first (C-31). Two operators refining the same soul concurrently is a
   * conflict to resolve, never a silent lost update.
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} input.rationale
   * @param {Array<{kind:string, draft:object, baseRevision?:string|null}>} input.edits
   * @param {object[]} input.diff
   * @param {string} [input.risk]
   * @returns {Promise<{ ok:boolean, change?:object, conflicts?:object[] }>}
   */
  async function createChange({ title, rationale, edits, diff = [], risk = 'medium' }) {
    if (!edits?.length) throw new Error('a change must carry at least one edit');

    const current = await readDefinitions();
    const conflicts = [];
    const sealed = [];

    for (const { kind, draft, baseRevision = null } of edits) {
      const key = `${kind}/${draft.id}`;
      const existing = current.definitions.get(key);

      if (existing && baseRevision !== existing.revision) {
        conflicts.push({
          kind, id: draft.id,
          expected: baseRevision,
          actual: existing.revision,
          reason: baseRevision
            ? 'the definition moved since this edit was drafted'
            : 'the definition already exists — supply its revision as baseRevision to update it',
        });
        continue;
      }

      const revision = sealRevision(kind, draft, {
        actor,
        parentRevision: existing?.revision ?? null,
        now: nowIso(),
      });

      // Re-sealing identical content is a no-op, not a change. Recording it would
      // manufacture history and make a rollback target ambiguous.
      if (existing && existing.revision === revision.revision) continue;

      sealed.push({ kind, revision, baseRevision: existing?.revision ?? null });
    }

    if (conflicts.length) return { ok: false, conflicts };
    if (!sealed.length) return { ok: false, conflicts: [{ reason: 'no content changed' }] };

    const changeId = `fc-${contentDigest({ title, edits: sealed.map((s) => s.revision.revision) }).slice(7, 19)}`;
    const branch = `change/${changeId}`;

    // Objects before refs (C-24): write the content, then advance the pointer.
    await ensureRepo();
    const dir = workDir('write');
    try {
      await git.cloneRepo(FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH, dir);
    } catch {
      mkdirSync(dir, { recursive: true });
      gitInit(dir);
    }

    for (const { kind, revision } of sealed) {
      const rel = kind === 'persona'
        ? pathFor('persona', revision.role_id, revision.organ).replace(/\.md$/, '.json')
        : pathFor(kind, revision.id);
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(revision, null, 2) + '\n', 'utf8');
    }

    await git.pushWithRetry(FLEET_CONFIG_REPO, branch, dir, actor);
    rmSync(dir, { recursive: true, force: true });

    const change = {
      id: changeId,
      schema_version: 1,
      title,
      rationale,
      author: actor,
      created_at: nowIso(),
      base_release: await activeReleaseId(),
      status: 'draft',
      revisions: sealed.map((s) => ({
        kind: s.kind, id: s.revision.id, revision: s.revision.revision, base_revision: s.baseRevision,
      })),
      diff,
      evaluation_ids: [],
      risk,
    };

    await db.write(pathFor('fleetChange', changeId), change);
    log('INFO', `change ${changeId}: ${sealed.length} revision(s) on ${branch}`);
    return { ok: true, change, branch };
  }

  function gitInit(dir) {
    // A fresh registry needs a repository before it can hold a branch.
    execSync('git init -q', { cwd: dir });
  }

  /** Record a validation verdict on a change. An absent check is not a pass. */
  async function recordValidation(changeId, { passed, errors, checks }) {
    const path = pathFor('fleetChange', changeId);
    const change = await db.read(path);
    if (!change) throw new Error(`unknown change '${changeId}'`);
    const validation = { at: nowIso(), passed, errors: errors || [], checks: checks || [] };
    await db.write(path, { ...change, validation, status: passed ? 'validated' : 'draft' });
    return validation;
  }

  /**
   * Promote validated changes into an immutable release.
   *
   * The release merges the change branches into main and records the resulting
   * commit — that commit *is* the release content, which is what makes rollback a
   * pointer operation rather than a re-authoring exercise.
   */
  async function createRelease({ changeIds, platformVersion, approvedBy = null }) {
    if (!changeIds?.length) throw new Error('a release must carry at least one change');

    const changes = [];
    for (const id of changeIds) {
      const change = await db.read(pathFor('fleetChange', id));
      if (!change) throw new Error(`unknown change '${id}'`);
      if (!change.validation?.passed) {
        throw new Error(`change '${id}' has no passing validation — a release carries its evidence (C-31)`);
      }
      changes.push(change);
    }

    // ---- Release-time compare-and-swap (C-31) ----
    //
    // A draft lives on its own branch, so two authors can legitimately draft
    // against the same base at the same time and both succeed. The collision is
    // real but it is not visible until release, which is exactly where it must be
    // caught: merging both would apply one on top of the other and the second
    // author's change would vanish with nothing reporting it.
    //
    // Also re-checked here: main may have moved since the draft was written, even
    // with only one author, if another release landed in between.
    const { definitions: live } = await readDefinitions();
    const conflicts = [];
    const claimed = new Map(); // key → the change that already touches it

    for (const change of changes) {
      for (const rev of change.revisions) {
        const key = `${rev.kind}/${rev.id}`;

        const other = claimed.get(key);
        if (other) {
          conflicts.push({
            kind: rev.kind, id: rev.id,
            reason: `changes '${other}' and '${change.id}' both modify ${key} — release them one at a time so the second can rebase`,
          });
          continue;
        }
        claimed.set(key, change.id);

        const current = live.get(key);
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== (rev.base_revision ?? null)) {
          conflicts.push({
            kind: rev.kind, id: rev.id,
            reason: `${key} moved since change '${change.id}' was drafted ` +
              `(drafted against ${rev.base_revision || 'nothing'}, now ${currentRevision || 'nothing'})`,
          });
        }
      }
    }

    if (conflicts.length) {
      const err = new Error(
        `release blocked by ${conflicts.length} conflict(s):\n` +
        conflicts.map((c) => `  ${c.kind}/${c.id}: ${c.reason}`).join('\n')
      );
      err.conflicts = conflicts;
      err.code = 'CONFLICT';
      throw err;
    }

    await ensureRepo();
    for (const change of changes) {
      await git.mergeBranch(FLEET_CONFIG_REPO, `change/${change.id}`, FLEET_CONFIG_BRANCH, 'ours-theirs', actor);
    }
    const ref = await git.readRef(FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH);
    const commit = ref?.commit;
    if (!commit) throw new Error('release: the fleet-config branch has no commit after merge');

    const { definitions } = await readDefinitions();
    const digest = contentDigest({
      contents: [...definitions.entries()].sort().map(([k, v]) => [k, v.digest]),
    });

    const parent = await activeReleaseId();
    const releaseId = `fr-${digest.slice(7, 19)}`;
    const release = {
      id: releaseId,
      schema_version: 1,
      created_at: nowIso(),
      created_by: actor,
      change_ids: changeIds,
      content_ref: { repo: FLEET_CONFIG_REPO, branch: FLEET_CONFIG_BRANCH, commit },
      digest,
      parent_release: parent,
      platform_compat: { min: platformVersion, max: null },
      evidence: {
        validated: true,
        evaluation_ids: changes.flatMap((c) => c.evaluation_ids || []),
        approved_by: approvedBy,
        approved_at: approvedBy ? nowIso() : null,
      },
      status: 'pending',
    };

    await db.write(pathFor('fleetRelease', releaseId), release);
    for (const change of changes) {
      await db.write(pathFor('fleetChange', change.id), { ...change, status: 'released' });
    }
    log('INFO', `release ${releaseId} at ${commit.slice(0, 12)} (parent ${parent || 'none'})`);
    return release;
  }

  /**
   * Point agents at a release. This is the activation — one atomic write per
   * agent, and the only thing that makes a definition live.
   */
  async function assign({ releaseId, agents, specDigests, pinned = false }) {
    const release = await db.read(pathFor('fleetRelease', releaseId));
    if (!release) throw new Error(`unknown release '${releaseId}'`);

    const written = [];
    for (const agentId of agents) {
      const path = pathFor('fleetAssignment', agentId);
      const existing = await db.read(path);
      const assignment = {
        id: agentId,
        schema_version: 1,
        role_id: existing?.role_id || specDigests[agentId]?.roleId || 'unknown',
        desired_release: releaseId,
        desired_spec_digest: specDigests[agentId]?.digest || release.digest,
        actual_release: existing?.actual_release ?? null,
        actual_spec_digest: existing?.actual_spec_digest ?? null,
        pinned,
        applied_at: existing?.applied_at ?? null,
        drift: 'pending',
        last_error: null,
        updated_at: nowIso(),
      };
      await db.write(path, assignment);
      written.push(assignment);
    }

    const status = pinned ? 'canary' : 'active';
    await db.write(pathFor('fleetRelease', releaseId), { ...release, status });
    if (status === 'active' && release.parent_release) {
      const prev = await db.read(pathFor('fleetRelease', release.parent_release));
      if (prev && prev.status === 'active') {
        await db.write(pathFor('fleetRelease', prev.id), { ...prev, status: 'superseded' });
      }
    }
    return written;
  }

  /**
   * Roll back to a release's predecessor.
   *
   * Atomic pointer operation: the previous release's content is already in the
   * store, so this repoints assignments and marks the failed release. Nothing is
   * rebuilt and nothing is re-authored, which is the property that makes a
   * rollback safe to perform under pressure.
   */
  async function rollback({ releaseId, reason }) {
    const release = await db.read(pathFor('fleetRelease', releaseId));
    if (!release) throw new Error(`unknown release '${releaseId}'`);
    const target = release.parent_release;
    if (!target) throw new Error(`release '${releaseId}' has no predecessor to roll back to`);

    const prior = await db.read(pathFor('fleetRelease', target));
    if (!prior) throw new Error(`rollback target '${target}' is missing from the registry`);

    const affected = await listAssignments();
    const repointed = [];
    for (const a of affected) {
      if (a.desired_release !== releaseId) continue;
      await db.write(pathFor('fleetAssignment', a.id), {
        ...a,
        desired_release: target,
        desired_spec_digest: prior.digest,
        drift: 'pending',
        last_error: `rolled back from ${releaseId}: ${reason}`,
        updated_at: nowIso(),
      });
      repointed.push(a.id);
    }

    await db.write(pathFor('fleetRelease', releaseId), { ...release, status: 'rolled-back' });
    await db.write(pathFor('fleetRelease', target), { ...prior, status: 'active' });
    log('INFO', `rolled back ${releaseId} → ${target} for ${repointed.length} agent(s)`);
    return { from: releaseId, to: target, agents: repointed };
  }

  /** Every assignment in the deployment. */
  async function listAssignments() {
    const docs = await db.query('', 'fleet_assignments', [], { noOrderBy: true, limit: 300 });
    return docs || [];
  }

  /** The currently active release id, or null. */
  async function activeReleaseId() {
    const docs = await db.query('', 'fleet_releases', [{ field: 'status', op: 'EQUAL', value: { stringValue: 'active' } }], { noOrderBy: true, limit: 5 });
    return docs?.[0]?.id ?? null;
  }

  /** Report an agent's actual applied state, closing the desired/actual loop. */
  async function reportApplied({ agentId, releaseId, specDigest, error = null }) {
    const path = pathFor('fleetAssignment', agentId);
    const a = await db.read(path);
    if (!a) throw new Error(`no assignment for agent '${agentId}'`);
    const converged = !error && a.desired_release === releaseId && a.desired_spec_digest === specDigest;
    const next = {
      ...a,
      actual_release: error ? a.actual_release : releaseId,
      actual_spec_digest: error ? a.actual_spec_digest : specDigest,
      applied_at: error ? a.applied_at : nowIso(),
      drift: error ? 'failed' : converged ? 'converged' : 'pending',
      last_error: error,
      updated_at: nowIso(),
    };
    await db.write(path, next);
    return next;
  }

  return {
    ensureRepo,
    readDefinitions,
    createChange,
    recordValidation,
    createRelease,
    assign,
    rollback,
    listAssignments,
    activeReleaseId,
    reportApplied,
    _db: db,
  };
}
