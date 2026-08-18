// platform/deployment/registry.mjs — the tenant-local Fleet Definition store
//
// Content lives in a git repository on the existing GCS/Firestore CAS substrate
// (`platform/persistence/git-store.mjs`): immutable history, no runtime GitHub dependency,
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

import * as gitStore from '../persistence/git-store.mjs';
import { createClient } from '../persistence/firestore.mjs';
import { contentDigest } from '../contracts/digest.mjs';
import { sealRevision, verifyRevision, DEFINITION_KINDS, CATALOG } from '../contracts/index.mjs';
import { FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH, pathFor } from '../contracts/ids.mjs';

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

  /**
   * Read the definition set a release was cut from — the EXACT bytes, or nothing.
   *
   * `readDefinitions()` reads a mutable branch tip. That is correct for authoring
   * and wrong for everything downstream of a release: an agent assigned to
   * release A could be handed whatever the branch said later, with the result
   * still stamped A. Canary attribution, holdback, evaluation and rollback all
   * rest on a release id meaning one thing, and it did not.
   *
   * Three ways this differs from readDefinitions, all of them deliberate:
   *
   * 1. It pins `content_ref.commit`, detached, and verifies HEAD.
   * 2. **A corrupt revision throws.** readDefinitions collects `corrupt` and
   *    continues, which is right while authoring — you want to see the damage.
   *    A release is a unit: a partially-readable one must never be compiled,
   *    evaluated or applied, so there is no partial success to return.
   * 3. **It recomputes the release digest and compares.** createRelease derives
   *    `digest` from the definition digests at the commit, so recomputing it here
   *    proves the tree really is the tree the release was made from, rather than
   *    trusting that the commit pointer alone was enough.
   *
   * A clone failure also throws rather than reporting an empty registry — "the
   * store is unreachable" and "this release has no content" are different facts,
   * and this repo has already been bitten by treating one as the other.
   *
   * @param {string} releaseId
   * @returns {Promise<{definitions: Map, release: object, commit: string}>}
   */
  async function readReleaseDefinitions(releaseId) {
    const release = await db.read(pathFor('fleetRelease', releaseId), { strict: true });
    if (!release) throw new Error(`readRelease: unknown release '${releaseId}'`);

    const commit = release.content_ref?.commit;
    if (!commit) {
      throw new Error(
        `readRelease: release '${releaseId}' records no content commit — its bytes cannot be reproduced`
      );
    }
    const branch = release.content_ref?.branch || FLEET_CONFIG_BRANCH;

    await ensureRepo();
    const dir = workDir('release');
    try {
      // Clone the branch to bring the objects local, then pin to the commit. The
      // release commit is an ancestor of the branch unless history was rewritten,
      // in which case the pin fails — which is the correct outcome.
      await git.cloneRepo(FLEET_CONFIG_REPO, branch, dir);
      git.checkoutCommit(dir, commit);

      const definitions = new Map();
      for (const kind of DEFINITION_KINDS) {
        for (const { id, file } of listKind(dir, kind)) {
          let record;
          try {
            record = JSON.parse(readFileSync(file, 'utf8'));
          } catch (e) {
            throw new Error(`readRelease: ${releaseId} has unparseable ${kind}/${id}: ${e.message}`);
          }
          const verdict = verifyRevision(kind, record);
          if (!verdict.ok) {
            throw new Error(`readRelease: ${releaseId} has tampered ${kind}/${id}: ${verdict.reason}`);
          }
          definitions.set(`${kind}/${id}`, record);
        }
      }

      // Same formula createRelease used. A mismatch means the commit does not
      // hold the content the release claims, whatever the pointer says.
      const recomputed = contentDigest({
        contents: [...definitions.entries()].sort().map(([k, v]) => [k, v.digest]),
      });
      if (release.digest && recomputed !== release.digest) {
        throw new Error(
          `readRelease: ${releaseId} digest mismatch at ${String(commit).slice(0, 12)} — ` +
          `recorded ${release.digest.slice(0, 19)}, tree yields ${recomputed.slice(0, 19)}`
        );
      }

      return { definitions, release, commit };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    // git-store pushes a *commit*; a working tree with uncommitted files has no
    // HEAD, and pushBranch answers that with `up_to_date` — a success-shaped
    // return meaning "I did nothing". Commit first, then insist the push landed.
    commitTree(dir, `fleet-config: ${title}`, branch);
    const pushed = await git.pushWithRetry(FLEET_CONFIG_REPO, branch, dir, actor);
    rmSync(dir, { recursive: true, force: true });

    if (pushed?.status !== 'pushed') {
      throw new Error(
        `change ${changeId}: push to ${branch} did not land (status: ${pushed?.status || 'unknown'}). ` +
        `Nothing was recorded.`
      );
    }

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

    await db.write(pathFor('fleetChange', changeId), change, { strict: true });
    log('INFO', `change ${changeId}: ${sealed.length} revision(s) on ${branch}`);
    return { ok: true, change, branch };
  }

  function gitInit(dir) {
    // A fresh registry needs a repository before it can hold a branch.
    execSync('git init -q', { cwd: dir });
  }

  /**
   * Commit the working tree so there is a HEAD to push.
   *
   * Identity is set locally rather than assumed: the daemon user has no global
   * git config, and `git commit` fails without one — which would surface far
   * from here as an empty push.
   */
  function commitTree(dir, message, branch) {
    // `git bundle create … <branch>` needs that branch to exist locally. A fresh
    // `git init` lands on whatever the default name is, so the tree is moved onto
    // the target branch before anything is committed or bundled.
    if (branch) execSync(`git checkout -q -B "${branch}"`, { cwd: dir });
    execSync('git add -A', { cwd: dir });
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
    if (!status) {
      // Nothing staged means the caller already checked for a no-op, or the
      // write silently produced nothing. Either way, do not fabricate a commit.
      const hasHead = (() => {
        try { execSync('git rev-parse HEAD', { cwd: dir, stdio: 'ignore' }); return true; } catch { return false; }
      })();
      if (hasHead) return;
      throw new Error('commitTree: nothing to commit and no existing HEAD');
    }
    execSync(
      `git -c user.name="${actor}" -c user.email="${actor}@fleet-config.local" commit -q -m "${message.replace(/"/g, "'")}"`,
      { cwd: dir }
    );
  }

  /** Record a validation verdict on a change. An absent check is not a pass. */
  async function recordValidation(changeId, { passed, errors, checks }) {
    const path = pathFor('fleetChange', changeId);
    const change = await db.read(path, { strict: true });
    if (!change) throw new Error(`unknown change '${changeId}'`);
    const validation = { at: nowIso(), passed, errors: errors || [], checks: checks || [] };
    await db.write(path, { ...change, validation, status: passed ? 'validated' : 'draft' }, { strict: true });
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
      const change = await db.read(pathFor('fleetChange', id), { strict: true });
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

    // A brand-new registry has no `main` commit, so there is nothing to merge
    // into — git refuses, correctly, rather than inventing a common ancestor.
    // The first release seeds the branch by promoting the change's own tree.
    // Every release after it merges normally.
    let seeded = false;
    const head = await git.readRef(FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH);
    if (!head?.sha) {
      const [first, ...rest] = changes;
      const dir = workDir('seed');
      await git.cloneRepo(FLEET_CONFIG_REPO, `change/${first.id}`, dir);
      commitTree(dir, `fleet-config: seed ${FLEET_CONFIG_BRANCH}`, FLEET_CONFIG_BRANCH);
      const seedPush = await git.pushWithRetry(FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH, dir, actor);
      rmSync(dir, { recursive: true, force: true });
      if (seedPush?.status !== 'pushed') {
        throw new Error(`release: seeding ${FLEET_CONFIG_BRANCH} did not land (status: ${seedPush?.status || 'unknown'})`);
      }
      seeded = true;
      log('INFO', `seeded ${FLEET_CONFIG_BRANCH} from change/${first.id}`);
      for (const change of rest) {
        await git.mergeBranch(FLEET_CONFIG_REPO, `change/${change.id}`, FLEET_CONFIG_BRANCH, 'ours-theirs', actor);
      }
    } else {
      for (const change of changes) {
        await git.mergeBranch(FLEET_CONFIG_REPO, `change/${change.id}`, FLEET_CONFIG_BRANCH, 'ours-theirs', actor);
      }
    }

    // git-store's ref carries `sha` (the branch head), not `commit`.
    const ref = await git.readRef(FLEET_CONFIG_REPO, FLEET_CONFIG_BRANCH);
    const commit = ref?.sha;
    if (!commit) {
      throw new Error(
        `release: ${FLEET_CONFIG_BRANCH} has no commit after ${seeded ? 'seeding' : 'merge'} — ` +
        `nothing was activated`
      );
    }

    const { definitions } = await readDefinitions();
    const digest = contentDigest({
      contents: [...definitions.entries()].sort().map(([k, v]) => [k, v.digest]),
    });

    const parent = await previousLiveReleaseId();
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

    await db.write(pathFor('fleetRelease', releaseId), release, { strict: true });
    for (const change of changes) {
      await db.write(pathFor('fleetChange', change.id), { ...change, status: 'released' }, { strict: true });
    }
    log('INFO', `release ${releaseId} at ${commit.slice(0, 12)} (parent ${parent || 'none'})`);
    return release;
  }

  /**
   * Point agents at a release. This is the activation — one atomic write per
   * agent, and the only thing that makes a definition live.
   */
  async function assign({ releaseId, agents, specDigests, pinned = false }) {
    const release = await db.read(pathFor('fleetRelease', releaseId), { strict: true });
    if (!release) throw new Error(`unknown release '${releaseId}'`);

    const written = [];
    for (const agentId of agents) {
      const path = pathFor('fleetAssignment', agentId);
      const existing = await db.read(path, { strict: true });
      const assignment = {
        id: agentId,
        schema_version: 1,
        // An explicitly supplied role wins over whatever is stored: the stored
        // value may be a placeholder from an earlier assignment, and `'unknown'`
        // is truthy, so a plain `existing || supplied` kept the placeholder.
        role_id: specDigests[agentId]?.roleId || existing?.role_id || 'unknown',
        desired_release: releaseId,
        // The agent's spec digest is NOT the release digest. A release digest
        // covers the whole definition set; a spec digest covers one agent's
        // compiled bundle, which also depends on the firmware installed on that
        // VM — a coordinate the control plane does not hold. Substituting one for
        // the other made every apply refuse itself.
        //
        // Left null unless a caller supplies a genuinely computed digest (an
        // evaluation pinning a candidate does). Null means "compile from this
        // release and tell me what you got"; non-null means "this exact bundle
        // was approved, refuse anything else".
        desired_spec_digest: specDigests[agentId]?.digest ?? null,
        actual_release: existing?.actual_release ?? null,
        actual_spec_digest: existing?.actual_spec_digest ?? null,
        pinned,
        applied_at: existing?.applied_at ?? null,
        drift: 'pending',
        last_error: null,
        updated_at: nowIso(),
      };
      await db.write(path, assignment, { strict: true });
      written.push(assignment);
    }

    const status = pinned ? 'canary' : 'active';
    await db.write(pathFor('fleetRelease', releaseId), { ...release, status }, { strict: true });
    if (status === 'active' && release.parent_release) {
      const prev = await db.read(pathFor('fleetRelease', release.parent_release), { strict: true });
      if (prev && prev.status === 'active') {
        await db.write(pathFor('fleetRelease', prev.id), { ...prev, status: 'superseded' }, { strict: true });
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
    const release = await db.read(pathFor('fleetRelease', releaseId), { strict: true });
    if (!release) throw new Error(`unknown release '${releaseId}'`);
    const target = release.parent_release;
    if (!target) throw new Error(`release '${releaseId}' has no predecessor to roll back to`);

    const prior = await db.read(pathFor('fleetRelease', target), { strict: true });
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
      }, { strict: true });
      repointed.push(a.id);
    }

    await db.write(pathFor('fleetRelease', releaseId), { ...release, status: 'rolled-back' }, { strict: true });
    await db.write(pathFor('fleetRelease', target), { ...prior, status: 'active' }, { strict: true });
    log('INFO', `rolled back ${releaseId} → ${target} for ${repointed.length} agent(s)`);
    return { from: releaseId, to: target, agents: repointed };
  }

  /** Every assignment in the deployment. */
  async function listAssignments() {
    const docs = await db.query('', 'fleet_assignments', [], { strict: true, noOrderBy: true, limit: 300 });
    return docs || [];
  }

  /**
   * The work a release produced, narrowed to the spec digests its agents attested.
   *
   * Ask Firestore for the release's own missions rather than reading `work` and
   * filtering locally. `work` holds every mission the deployment has ever run,
   * so an unfiltered read returns an arbitrary slice that almost certainly
   * excludes the release being judged — and the gate then reports "0 missions,
   * too early to judge", which is indistinguishable from a genuinely young
   * release. The operator waits for evidence that will never arrive.
   *
   * One equality filter, so no composite index is required. Truncation and
   * unstamped work are returned rather than swallowed: a sample that reads as a
   * census is how a partial view becomes a confident verdict.
   *
   * @param {string} releaseId
   * @param {Iterable<string>} digests - the digests agents on this release attested
   * @returns {Promise<{ work: Array, truncated: boolean, unstamped: number }>}
   */
  async function readReleaseWork(releaseId, digests, { limit = 500 } = {}) {
    const rows = (await db.query('', 'work', [
      { field: 'fleet_release', op: 'EQUAL', value: { stringValue: releaseId } },
    ], { strict: true, noOrderBy: true, limit })) || [];

    const wanted = new Set(digests);
    const work = [];
    let unstamped = 0;
    for (const row of rows) {
      if (!row.agent_spec_digest) { unstamped++; continue; }
      if (wanted.has(row.agent_spec_digest)) work.push(row);
    }
    return { work, truncated: rows.length >= limit, unstamped };
  }

  /**
   * The release a new one would supersede — the rollback target (C-31).
   *
   * NOT the same as the active release. A release reaches `active` only after a
   * full promotion, and a canary-first workflow may never take it there: both
   * releases in the first live registry sat at `canary`, so
   * `parent_release` came back null every time and no release had anywhere to
   * roll back to. `evaluateRollout` can decide `rollback`, and `observe --apply`
   * would then find no target and pause instead — the one moment the promise
   * matters is the one where it was missing.
   *
   * Two equality filters rather than an unfiltered read: `fleet_releases` is
   * small today, and a query that reads a slice and filters locally is the shape
   * that made the rollout gate report zero missions.
   */
  async function previousLiveReleaseId() {
    const live = [];
    for (const status of ['active', 'canary']) {
      const docs = await db.query('', 'fleet_releases', [
        { field: 'status', op: 'EQUAL', value: { stringValue: status } },
      ], { strict: true, noOrderBy: true, limit: 100 });
      live.push(...(docs || []));
    }
    if (!live.length) return null;
    // Newest first. An `active` release outranks a `canary` one at the same
    // instant, because it is what the fleet at large is running.
    live.sort((a, b) => {
      const t = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      if (t !== 0) return t;
      return (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1);
    });
    return live[0].id;
  }

  /** The currently active release id, or null. */
  async function activeReleaseId() {
    const docs = await db.query('', 'fleet_releases', [{ field: 'status', op: 'EQUAL', value: { stringValue: 'active' } }], { strict: true, noOrderBy: true, limit: 5 });
    return docs?.[0]?.id ?? null;
  }

  /** Report an agent's actual applied state, closing the desired/actual loop. */
  async function reportApplied({ agentId, releaseId, specDigest, error = null }) {
    const path = pathFor('fleetAssignment', agentId);
    const a = await db.read(path, { strict: true });
    if (!a) throw new Error(`no assignment for agent '${agentId}'`);
    // With no pinned digest, converging means running the assigned release and
    // having attested a digest for it. With one, the digests must match.
    const converged = !error
      && a.desired_release === releaseId
      && (a.desired_spec_digest === null || a.desired_spec_digest === undefined
        ? Boolean(specDigest)
        : a.desired_spec_digest === specDigest);
    const next = {
      ...a,
      actual_release: error ? a.actual_release : releaseId,
      actual_spec_digest: error ? a.actual_spec_digest : specDigest,
      applied_at: error ? a.applied_at : nowIso(),
      drift: error ? 'failed' : converged ? 'converged' : 'pending',
      last_error: error,
      updated_at: nowIso(),
    };
    await db.write(path, next, { strict: true });
    return next;
  }

  return {
    ensureRepo,
    readDefinitions,
    readReleaseDefinitions,
    createChange,
    recordValidation,
    createRelease,
    assign,
    rollback,
    listAssignments,
    readReleaseWork,
    activeReleaseId,
    previousLiveReleaseId,
    reportApplied,
    _db: db,
  };
}
