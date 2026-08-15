// corekit/lib/artifacts.mjs — Shared workspace & artifact management
// Extracted from agent-brain.mjs Phase 3
//
// Manages the lifecycle of per-mission shared workspaces (shared/{envelopeId}/)
// and publishes work products via the git artifact substrate (C-24).
// Git store: GCS bundles + Firestore refs with CAS.
//
// All external state (Firestore, config, projects, auth) injected via deps.

import { getGceToken } from './gce-auth.mjs';
import { ensureRepo, cloneRepo, pushWithRetry, pushBranch, mergeBranch, buildManifest, readRef, sanitizeRepoId, allocateVersion } from './git-store.mjs';

// Marker for the corekit-managed block in a mission tree's LOCAL git excludes.
const WORKSPACE_EXCLUDE_MARKER = '# --- corekit: mission scratch (inputs + bookkeeping, never artifacts) ---';

/**
 * Render the corekit-managed block for a mission working tree's LOCAL git excludes
 * (`.git/info/exclude`), merged onto whatever is already there. Pure — no I/O.
 *
 * Ignores three classes of non-artifact file that the daemon/motor leave in the tree:
 *   - source material downloaded to be READ (contracts, scans), not produced — images too
 *     by default, since a downloaded scan is an input that would bloat every future clone.
 *     For an ASSET-BEARING project (opts.keepAssets — a website whose own images are the
 *     deliverable) the media globs are NOT excluded, so the site's images commit as artifacts.
 *     Archives (*.zip/*.gz/*.tar) and office docs (*.pdf/*.docx/…) stay excluded regardless —
 *     those are never a static site's committable source;
 *   - corekit mission bookkeeping (the MISSION.md blackboard + the missions/ record,
 *     step-transcript and session-log dir) — telemetry, not a project artifact (C-24);
 *   - organ / agent-workspace identity (IDENTITY/MEMORY/SOUL, the shared tree) — a
 *     defense so a mis-targeted git add -A never leaks an organ into an artifact (C-28).
 *
 * Bookkeeping paths are root-anchored (`/MISSION.md`, `/missions/`) so a project's own
 * nested paths deeper in the tree are never masked. Idempotent (C-18): if the managed
 * block is already present, returns the input unchanged with changed=false.
 *
 * @param {string} [existing] - Current exclude-file contents
 * @param {object} [opts]
 * @param {boolean} [opts.keepAssets] - Asset-bearing project: keep image/media globs committable.
 * @returns {{ content: string, changed: boolean }}
 */
export function renderWorkspaceExcludes(existing = '', opts = {}) {
  if (existing.includes(WORKSPACE_EXCLUDE_MARKER)) {
    return { content: existing, changed: false };
  }
  const keepAssets = opts.keepAssets === true;
  // Media: excluded by default (a downloaded scan is an input), but for an asset-bearing
  // project the site's own images ARE the artifact, so keep them committable.
  const mediaLines = keepAssets
    ? ['# Asset-bearing project (class: web / commit_assets): images are deliverable source,',
       '# so media globs are intentionally NOT excluded here — they commit as artifacts.']
    : ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp'];
  const block = [
    WORKSPACE_EXCLUDE_MARKER,
    '# Downloaded to be READ (drive-download, drive-to-doc) — publish deliverables with',
    '# work-publish; do not commit raw source material into the artifact substrate.',
    '*.pdf', '*.docx', '*.xlsx', '*.pptx',
    ...mediaLines,
    '*.zip', '*.gz', '*.tar',
    '# Tool caches, dependency trees, and VCS conflict artifacts — never a project artifact.',
    '# A stray add -A must not commit a deploy cache (.firebase/) or node_modules into the',
    '# substrate (this is how deploy scratch reached a project main). Match-anywhere (nested).',
    '.firebase/',
    'node_modules/',
    '*.orig', '*.rej',
    '# Corekit mission bookkeeping the daemon writes into the tree — process notes, not',
    "# a project artifact. Root-anchored so a project's own nested paths stay safe.",
    '/MISSION.md',
    '/missions/',
    '# Organ / agent-workspace identity — belt-and-suspenders so that even a mis-targeted',
    "# git add -A can never leak an organ's IDENTITY/MEMORY/SOUL or the shared tree into a",
    '# project artifact (C-28). Root-anchored; work-commit also hard-refuses such a tree.',
    '/IDENTITY.md',
    '/MEMORY.md',
    '/SOUL.md',
    '/SOUL.base.md',
    '/SOUL_APPEND.md',
    '/shared',
    '# --- end corekit block ---',
    '',
  ].join('\n');
  const content = existing ? `${existing.replace(/\n*$/, '\n')}\n${block}` : block;
  return { content, changed: true };
}

/**
 * Whether a project's own binary assets (images) are committable artifacts rather than
 * downloaded scratch. True for an explicit `commit_assets` flag or a web/site-class project.
 * Mirrors resolveMergePolicy's precedence: an explicit field wins, else derive from class/type.
 * @param {object} [project]
 * @returns {boolean}
 */
export function resolveCommitAssets(project) {
  if (project?.commit_assets === true) return true;
  if (project?.commit_assets === false) return false;
  const cls = project?.class || project?.type;
  return cls === 'web' || cls === 'website' || cls === 'site';
}

// Entries in the persistent motor workspace (`{coreDir}/workspace`, the motor's tool cwd)
// that are identity, working memory, live runtime state, agent-authored skills, or the
// shared-missions symlink. EVERYTHING else there is per-mission scratch that must not
// survive into the next mission: a mission that writes a site/clone/node_modules there and
// then runs `firebase deploy public:"."` would otherwise ship the previous mission's files
// (this is exactly how an old marketing-site build reached a staging URL). Symlinks are
// ALSO always kept and never traversed, so `shared` (→ every mission tree) is untouched.
//
// `SOUL.base.md` is kept for a sharper reason than the others: it is the fixed
// point the rendered SOUL.md is composed FROM. Sweeping it would not merely
// lose a file — the next content-sync would have no base to compose onto, and
// the only remaining source would be its own previous output.
const MOTOR_WORKSPACE_KEEP = new Set([
  'SOUL.md', 'SOUL.base.md', 'SOUL_APPEND.md', 'IDENTITY.md', 'MEMORY.md', 'CLASSIFIED_MEMORY.md',
  'TASK.json', 'config.json', 'progress.json', 'sessions.json',
  'custom-skills', 'shared',
]);

/**
 * Decide which top-level entries of the persistent motor workspace to delete. Pure (B-19):
 * takes dirents as `{ name, isSymlink }`, returns the names to remove — everything that is
 * neither in the keep-set nor a symlink.
 * @param {Array<{name:string, isSymlink:boolean}>} entries
 * @returns {string[]}
 */
export function motorWorkspaceSweepPlan(entries) {
  return (entries || [])
    .filter((e) => e && e.name && !e.isSymlink && !MOTOR_WORKSPACE_KEEP.has(e.name))
    .map((e) => e.name);
}

/**
 * Sweep the persistent motor workspace of non-identity scratch. Best-effort + idempotent
 * (C-18): a clean workspace sweeps to a no-op. Skips symlinks entirely so the `shared`
 * missions link is never followed or removed.
 * @param {string} coreDir
 * @param {function} [log]
 * @returns {Promise<{removed: string[]}>}
 */
export async function sweepMotorWorkspace(coreDir = '/opt/corekit', log = () => {}) {
  try {
    const { readdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const dir = `${coreDir}/workspace`;
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); }
    catch { return { removed: [] }; } // no persistent workspace → nothing to sweep
    const entries = dirents.map((d) => ({ name: d.name, isSymlink: d.isSymbolicLink() }));
    const toRemove = motorWorkspaceSweepPlan(entries);
    for (const name of toRemove) {
      try { rmSync(join(dir, name), { recursive: true, force: true }); }
      catch (e) { log('WARN', `sweepMotorWorkspace: could not remove ${name}: ${e.message}`); }
    }
    if (toRemove.length) {
      log('INFO', `Swept motor workspace: removed ${toRemove.length} stale scratch entr${toRemove.length === 1 ? 'y' : 'ies'} (kept identity/runtime + symlinks)`);
    }
    return { removed: toRemove };
  } catch (e) {
    log('WARN', `sweepMotorWorkspace failed (non-fatal): ${e.message}`);
    return { removed: [] };
  }
}

/**
 * Create an artifact manager instance.
 *
 * @param {object} deps
 * @param {function} deps.firestoreWrite  - async (collection, docId, data) => result
 * @param {function} deps.firestoreRead   - async (collection, docId) => data
 * @param {function} deps.logger          - (level, msg) logging function
 * @param {function} deps.firestoreEncode - Firestore value encoder (from firestore.mjs)
 * @param {function} deps.getProjects     - () => projects map (live reference)
 * @param {function} deps.getDefaultProjectId - () => default project ID
 * @param {object}   deps.config
 * @param {string}   deps.config.coreDir       - e.g. '/opt/corekit'
 * @param {string}   deps.config.primeId       - e.g. 'chucknorris'
 * @param {string}   deps.config.agentId       - e.g. 'stan'
 * @param {string}   deps.config.agentEmail    - e.g. 'devops-agent-stan@example.com'
 * @param {string}   deps.config.gcpProject    - GCP project ID
 * @returns {object} Artifact manager API
 */
export function createArtifactManager(deps) {
  const {
    firestoreWrite,
    firestoreRead,
    firestoreEncode,
    getProjects,
    getDefaultProjectId,
    config,
  } = deps;

  const log = deps.logger || ((level, msg) => console.log(`[artifacts] ${level}: ${msg}`));
  const {
    coreDir,
    primeId,
    agentId,
    agentEmail,
    gcpProject,
  } = config;

  const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  // =========================================================================
  //  Merge policy resolution (A2)
  // =========================================================================

  /**
   * Resolve the merge policy for a project.
   * Project-level setting wins; code-class projects default to gated; else auto.
   * @param {object} [project]
   * @returns {'auto'|'gated'}
   */
  function resolveMergePolicy(project) {
    if (project?.merge_policy) return project.merge_policy;
    if (project?.class === 'code' || project?.type === 'code') return 'gated';
    return 'auto';
  }

  // =========================================================================
  //  Shared workspace management
  // =========================================================================

  /**
   * Seed the mission working tree's LOCAL git excludes (`.git/info/exclude`) so the
   * daemon's scratch never enters the project repo. Uses the repo-local exclude file
   * (NOT a tracked `.gitignore`) on purpose: the rules are mission-local and re-seeded
   * every mission, and keeping them out of `.gitignore` means the merged diff carries
   * ONLY the real source change — the exclude file itself is never committed (CR-4).
   * Idempotent (C-18): the managed block is written once and skipped thereafter.
   *
   * @param {string} sharedDir - Absolute path to the mission working tree (repo root)
   * @param {object} [opts]
   * @param {boolean} [opts.keepAssets] - Asset-bearing project: keep media committable.
   */
  async function ensureWorkspaceExcludes(sharedDir, opts = {}) {
    try {
      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs');
      const infoDir = `${sharedDir}/.git/info`;
      // Normal clone → .git is a directory; ensure info/ exists before appending.
      try { mkdirSync(infoDir, { recursive: true }); } catch { /* ignore */ }
      const p = `${infoDir}/exclude`;
      const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
      const { content, changed } = renderWorkspaceExcludes(existing, opts);
      if (changed) writeFileSync(p, content);
    } catch (e) {
      log('WARN', `Could not seed workspace git excludes in ${sharedDir}: ${e.message}`);
    }
  }

  /**
   * Initialize a shared workspace directory for an envelope.
   * Creates `{coreDir}/shared/{envelopeId}/` via shell, then clones the
   * project's git artifact repo and creates a mission branch.
   *
   * @param {string} envelopeId - Envelope ID to create workspace for
   * @param {object} [opts]
   * @param {string} [opts.projectId] - Project ID for git substrate init
   * @param {object} [opts.envelope]  - Envelope ref for degradation marking
   */
  async function initWorkspace(envelopeId, opts = {}) {
    // Start clean: clear last mission's scratch out of the persistent motor workspace (the
    // motor's tool cwd) so a stray `public:"."` deploy can't ship stale leftovers. The
    // per-mission working tree is shared/<id>/ (created below); the persistent workspace
    // should only ever hold identity/runtime files between missions.
    await sweepMotorWorkspace(coreDir, log);
    const sharedDir = `${coreDir}/shared/${envelopeId}`;
    try {
      const { execSync } = await import('child_process');
      execSync(`mkdir -p ${sharedDir}`, { timeout: 3000 });
    } catch (e) {
      log('WARN', `Failed to init shared workspace for ${envelopeId}: ${e.message}`);
    }

    // Git substrate: clone project repo and create mission branch
    const projectId = opts.projectId;
    if (projectId) {
      try {
        const repoId = sanitizeRepoId(projectId);
        const project = getProjects()[projectId];
        await ensureRepo(repoId, { mergePolicy: resolveMergePolicy(project) });
        const branch = `mission/${envelopeId}`;
        const ref = await readRef(repoId, 'main');
        // Clone main (or init empty) into shared dir
        await cloneRepo(repoId, 'main', sharedDir);
        // Create and checkout mission branch
        const { execSync } = await import('child_process');
        try {
          execSync(`git checkout -b "${branch}"`, { cwd: sharedDir, timeout: 5000 });
        } catch {
          // Branch may exist if resuming
          try { execSync(`git checkout "${branch}"`, { cwd: sharedDir, timeout: 5000 }); } catch { /* ignore */ }
        }
        // Keep the daemon's scratch out of the artifact substrate. Two classes leak
        // into the tree otherwise: source material downloaded to be READ (contracts,
        // scans — third-party data that would bloat every future clone), and corekit
        // mission bookkeeping (MISSION.md, missions/ records + step transcripts). Both
        // go into the repo-LOCAL `.git/info/exclude`, so they are ignored during the
        // mission yet never committed — the merged diff is only the real source change.
        // An asset-bearing project (website) keeps its own images committable (keepAssets).
        await ensureWorkspaceExcludes(sharedDir, { keepAssets: resolveCommitAssets(project) });
        log('INFO', `Git workspace initialized: repo=${repoId} branch=${branch} base=${ref?.sha?.slice(0, 8) || 'empty'}`);
      } catch (e) {
        log('WARN', `Git workspace init failed (non-fatal): ${e.message}`);
        // A9 degradation marker: flag so publish() and commitAndSync know to skip git
        try {
          const env = opts.envelope;
          if (env) { env.context = env.context || {}; env.context.git_status = `degraded: ${e.message.slice(0, 100)}`; }
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * Clean up a shared workspace directory after mission completion.
   * Removes `{coreDir}/shared/{envelopeId}/` recursively.
   *
   * @param {string} envelopeId - Envelope ID to clean up
   */
  async function cleanupWorkspace(envelopeId) {
    try {
      const { execSync } = await import('child_process');
      execSync(`rm -rf ${coreDir}/shared/${envelopeId}`, { timeout: 3000 });
    } catch (e) {
      log('WARN', `Failed to cleanup shared workspace for ${envelopeId}: ${e.message}`);
    }
  }

  // =========================================================================
  //  Git substrate: checkpoint-level commit+sync
  // =========================================================================

  /**
   * Commit current shared/ changes and push to the ether.
   * Called after each checkpoint completion by the brain daemon.
   *
   * @param {string} envelopeId - Mission envelope ID
   * @param {string} projectId  - Project ID (sanitized to repoId internally)
   * @param {string} message    - Canonical commit message (C-23)
   * @returns {Promise<{committed: boolean, synced: boolean, sha: string|null}>}
   */
  async function commitAndSync(envelopeId, projectId, message) {
    if (!projectId) return { committed: false, synced: false, sha: null };
    const repoId = sanitizeRepoId(projectId);
    const sharedDir = `${coreDir}/shared/${envelopeId}`;
    const branch = `mission/${envelopeId}`;

    try {
      const { execSync, execFileSync } = await import('child_process');

      // Check if git repo exists
      try {
        execSync('git rev-parse --git-dir', { cwd: sharedDir, timeout: 3000 });
      } catch {
        return { committed: false, synced: false, sha: null };
      }

      // Stage all changes
      execSync('git add -A', { cwd: sharedDir, timeout: 5000 });

      // Check if there's anything to commit
      const status = execSync('git status --porcelain', { cwd: sharedDir, timeout: 3000, encoding: 'utf8' }).trim();
      if (!status) {
        log('DEBUG', `commitAndSync: nothing new to stage for ${envelopeId}`);
        // Guard: unborn HEAD on empty repos throws fatal; detect and return cleanly
        const headCheck = execSync('git rev-parse --verify -q HEAD 2>/dev/null || echo unborn', { cwd: sharedDir, timeout: 3000, encoding: 'utf8' }).trim();
        if (headCheck === 'unborn') {
          return { committed: false, synced: true, sha: null, unborn: true };
        }
        // A LOCAL commit the motor already made (its own work-commit) leaves nothing new to
        // stage — but that commit has NOT necessarily reached the git store, so returning here
        // without pushing leaves the mission branch ref behind and the completion merge finds
        // nothing: the "committed but nothing landed on main" failure seen on real code missions.
        // Push the existing HEAD so a motor-side commit actually propagates.
        const pushResult = await pushWithRetry(repoId, branch, sharedDir, agentId || 'brain');
        const synced = pushResult.status === 'pushed' || pushResult.status === 'up_to_date';
        if (synced) log('INFO', `commitAndSync: pushed pre-existing commit ${headCheck.slice(0, 8)} on ${branch} (${pushResult.status})`);
        else log('WARN', `commitAndSync: push of pre-existing commit ${headCheck.slice(0, 8)} failed (${pushResult.status})`);
        return { committed: false, synced, sha: headCheck };
      }

      // Set agent identity
      const agentName = agentId || 'brain';
      const agentMail = agentEmail || `${agentName}@agent`;
      // Shell-free (execFileSync, argv array) so identity/message free text — which can carry
      // backticks, $, ", or newlines (the commit message is derived from the mission goal) —
      // is never re-interpreted by /bin/sh. A backtick in the message previously opened an
      // unterminated backquote substitution and dropped the mission-record commit.
      execFileSync('git', ['config', 'user.name', agentName], { cwd: sharedDir, timeout: 3000 });
      execFileSync('git', ['config', 'user.email', agentMail], { cwd: sharedDir, timeout: 3000 });

      // Commit
      execFileSync('git', ['commit', '-m', message], { cwd: sharedDir, timeout: 10000 });
      const sha = execSync('git rev-parse HEAD', { cwd: sharedDir, timeout: 3000, encoding: 'utf8' }).trim();
      log('INFO', `commitAndSync: committed ${sha.slice(0, 8)} on ${branch}`);

      // Push to ether
      const pushResult = await pushWithRetry(repoId, branch, sharedDir, agentName);
      if (pushResult.status === 'pushed' || pushResult.status === 'up_to_date') {
        log('INFO', `commitAndSync: synced ${branch} (${pushResult.status}, ${pushResult.attempts} attempts)`);
        return { committed: true, synced: true, sha };
      } else {
        log('WARN', `commitAndSync: sync failed (${pushResult.status})`);
        return { committed: true, synced: false, sha };
      }
    } catch (e) {
      log('WARN', `commitAndSync failed: ${e.message}`);
      return { committed: false, synced: false, sha: null };
    }
  }

  // =========================================================================
  //  Artifact publishing (git-only, C-24)
  // =========================================================================

  /**
   * Publish artifacts from shared/{missionId}/ on mission completion.
   * Commits remaining changes, merges mission branch into main,
   * builds a changed-paths manifest, and sets envelope.context.artifacts.
   *
   * @param {object} envelope - Mission envelope to publish artifacts for
   * @returns {Promise<object|null>} Git artifact manifest or null
   */
  async function publish(envelope) {
    if (!envelope || envelope.type !== 'M') return null;
    if (!envelope.project_id) return null;

    // Skip if workspace is degraded (git init failed at initWorkspace time)
    if (envelope.context?.git_status?.startsWith('degraded')) {
      log('WARN', `publish: skipping degraded workspace (${envelope.context.git_status})`);
      return null;
    }

    try {
      const sharedDir = `${coreDir}/shared/${envelope.id}`;
      const repoId = sanitizeRepoId(envelope.project_id);
      const branch = `mission/${envelope.id}`;

      // Allocate version index for deterministic versioning (A3)
      const d = new Date();
      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '.');
      const versionIndex = envelope.context?.git_version_index || allocateVersion(sharedDir, 'main', d) || 1;
      const nextStep = (envelope.context?.git_checkpoint_count || 0) + 1;
      const title = (envelope.title || 'mission complete').slice(0, 80);
      const commitMsg = `v${dateStr}.${versionIndex}.${nextStep}: ${title}`;

      // Final commit of any remaining changes
      const commitResult = await commitAndSync(envelope.id, envelope.project_id, commitMsg);

      if (!commitResult.sha) {
        log('DEBUG', 'publish: no changes to publish');
        return null;
      }

      // Record main SHA before merge (for changed-paths manifest)
      const mainBefore = (await readRef(repoId, 'main'))?.sha || null;

      // Resolve merge policy
      const PROJECTS = getProjects();
      const project = PROJECTS[envelope.project_id];
      const policy = resolveMergePolicy(project);

      // Merge mission branch into main
      const mergeResult = await mergeBranch(repoId, branch, 'main', policy, agentId || 'brain');

      if (mergeResult.status === 'AWAITING_APPROVAL') {
        log('INFO', `Git: merge ${branch} → main requires approval (gated policy)`);
        // Park merge parameters for later resume
        envelope.context = envelope.context || {};
        envelope.context.pending_merge = {
          repoId,
          sourceBranch: branch,
          targetBranch: 'main',
          missionSha: commitResult.sha,
          mainBefore,
          parkedAt: now(),
        };
        return null;
      }

      if (mergeResult.status !== 'merged') {
        const conflicts = mergeResult.conflicts || [];
        log('WARN', `Git: merge ${branch} → main returned ${mergeResult.status}` +
          (conflicts.length ? ` — conflicting files: ${conflicts.join(', ')}` : '') +
          ' (mission work is committed on the branch but NOT merged to main)');
        // Stamp the failure so it's visible/queryable rather than silently swallowed.
        envelope.context = envelope.context || {};
        envelope.context.merge_failed = {
          status: mergeResult.status,
          reason: mergeResult.reason || null,
          conflicts,
          branch,
          at: now(),
        };
        return null;
      }

      log('INFO', `Git: merged ${branch} → main (sha: ${mergeResult.sha?.slice(0, 8)})`);

      // Build changed-paths manifest (A4)
      const mergedSha = mergeResult.sha;
      let changedPaths;
      try {
        const { execSync } = await import('child_process');
        // Clone the merged main to compute diff
        const tmpDir = `/tmp/manifest-${Date.now()}`;
        await cloneRepo(repoId, 'main', tmpDir);
        if (mainBefore) {
          changedPaths = execSync(`git diff --name-only ${mainBefore}..${mergedSha}`, { cwd: tmpDir, timeout: 10000, encoding: 'utf8' }).split('\n').filter(Boolean);
        } else {
          changedPaths = execSync(`git ls-tree -r --name-only ${mergedSha}`, { cwd: tmpDir, timeout: 10000, encoding: 'utf8' }).split('\n').filter(Boolean);
        }
        try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
      } catch (e) {
        log('WARN', `Changed-path computation failed, using empty list: ${e.message}`);
        changedPaths = [];
      }

      const gitManifest = await buildManifest(repoId, 'main', changedPaths, { summary: title });

      // Dashboard GCS attachment upload (CP4)
      if (envelope.source_channel === 'dashboard' && changedPaths && changedPaths.length > 0) {
        try {
          const MAX_EXPORT_FILES = 20;
          const exportPaths = changedPaths.slice(0, MAX_EXPORT_FILES).map(p => `${sharedDir}/${p}`);
          if (changedPaths.length > MAX_EXPORT_FILES) {
            log('WARN', `Attachment export capped at ${MAX_EXPORT_FILES} of ${changedPaths.length} changed files`);
          }
          const { uploadArtifacts } = await import('./artifact-share.mjs');
          const attachments = await uploadArtifacts(exportPaths, { scope: `missions/${envelope.id}`, log });
          if (attachments && attachments.length > 0) {
            envelope.context = envelope.context || {};
            envelope.context.attachments_export = attachments;
            log('INFO', `Uploaded ${attachments.length} attachment(s) for dashboard delivery`);
          }
        } catch (uploadErr) {
          log('WARN', `Dashboard attachments upload failed: ${uploadErr.message}`);
        }
      }

      // Set the canonical artifact manifest on envelope context (A5)
      if (gitManifest) {
        envelope.context = envelope.context || {};
        envelope.context.artifacts = gitManifest;
      }

      // Also update project context with latest manifest
      if (project && gitManifest) {
        project.context = project.context || {};
        project.context.artifacts = gitManifest;
        PROJECTS[envelope.project_id] = project;
        try {
          const token = await getGceToken();
          if (token) {
            const projUrl = `${FIRESTORE_BASE}/projects/${envelope.project_id}?updateMask.fieldPaths=context`;
            await fetch(projUrl, {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { context: firestoreEncode(project.context) } }),
            });
          }
        } catch (e) {
          log('WARN', `Failed to update project artifacts context: ${e.message}`);
        }
      }

      log('INFO', `Published git artifacts for mission ${envelope.id} (${changedPaths.length} changed files)`);
      return gitManifest;
    } catch (e) {
      log('WARN', `publish failed: ${e.message}`);
      return null;
    }
  }

  return {
    /** Initialize shared workspace for an envelope. */
    initWorkspace,
    /** Clean up shared workspace after completion. */
    cleanupWorkspace,
    /** Commit+push checkpoint-level changes to git ether. */
    commitAndSync,
    /** Publish shared/ artifacts via git substrate. */
    publish,
    /** Resolve merge policy for a project. */
    resolveMergePolicy,
  };
}
