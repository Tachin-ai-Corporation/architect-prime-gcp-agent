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
      const { execSync } = await import('child_process');

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
        log('DEBUG', `commitAndSync: nothing to commit for ${envelopeId}`);
        // Guard: unborn HEAD on empty repos throws fatal; detect and return cleanly
        const headCheck = execSync('git rev-parse --verify -q HEAD 2>/dev/null || echo unborn', { cwd: sharedDir, timeout: 3000, encoding: 'utf8' }).trim();
        if (headCheck === 'unborn') {
          return { committed: false, synced: true, sha: null, unborn: true };
        }
        return { committed: false, synced: true, sha: headCheck };
      }

      // Set agent identity
      const agentName = agentId || 'brain';
      const agentMail = agentEmail || `${agentName}@agent`;
      execSync(`git config user.name "${agentName}"`, { cwd: sharedDir, timeout: 3000 });
      execSync(`git config user.email "${agentMail}"`, { cwd: sharedDir, timeout: 3000 });

      // Commit
      execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: sharedDir, timeout: 10000 });
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
        log('WARN', `Git: merge ${branch} → main returned ${mergeResult.status}`);
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
          const { uploadArtifacts } = await import('./artifact-share.mjs');
          const absPaths = changedPaths.map(p => `${sharedDir}/${p}`);
          const attachments = await uploadArtifacts(absPaths, { log });
          if (attachments && attachments.length > 0) {
            envelope.context = envelope.context || {};
            envelope.context.attachments_export = attachments;
            log('INFO', `Uploaded ${attachments.length} attachments for dashboard message: ${JSON.stringify(attachments)}`);
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
