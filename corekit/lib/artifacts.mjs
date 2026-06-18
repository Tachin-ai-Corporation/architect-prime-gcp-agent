// corekit/lib/artifacts.mjs — Shared workspace & Drive artifact management
// Extracted from agent-brain.mjs Phase 3
//
// Manages the lifecycle of per-mission shared workspaces (shared/{envelopeId}/)
// and publishes work products to Google Drive on mission completion.
//
// All external state (Firestore, config, projects, auth) injected via deps.

import { getGceToken } from './gce-auth.mjs';

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
 * @param {string}   deps.config.agentEmail    - e.g. 'devops-agent-stan@tachin.ag'
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

  // ---- Internal state ----
  let _artifactsRootFolderId = null;

  /** ISO timestamp */
  function now() {
    return new Date().toISOString();
  }

  // =========================================================================
  //  Prime config (artifacts_root_folder_id)
  // =========================================================================

  /**
   * Load artifacts_root_folder_id from the app-level config/settings doc.
   * Called at startup and periodically to pick up dashboard config changes.
   */
  async function loadConfig() {
    try {
      const token = await getGceToken();
      if (!token) return;
      const url = `${FIRESTORE_BASE}/config/settings`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const fields = data.fields || {};
      const rootId = fields.artifacts_root_folder_id?.stringValue || null;
      if (rootId !== _artifactsRootFolderId) {
        _artifactsRootFolderId = rootId;
        log('INFO', `Artifacts root folder: ${rootId || '(not configured)'}`);
      }
    } catch (e) {
      log('WARN', `loadConfig error: ${e.message}`);
    }
  }

  /**
   * Get the current artifacts root folder ID.
   * @returns {string|null} Drive folder ID or null if not configured
   */
  function getArtifactsRootId() {
    return _artifactsRootFolderId;
  }

  // =========================================================================
  //  Shared workspace management
  // =========================================================================

  /**
   * Initialize a shared workspace directory for an envelope.
   * Creates `{coreDir}/shared/{envelopeId}/` via shell.
   *
   * @param {string} envelopeId - Envelope ID to create workspace for
   */
  async function initWorkspace(envelopeId) {
    try {
      const { execSync } = await import('child_process');
      execSync(`mkdir -p ${coreDir}/shared/${envelopeId}`, { timeout: 3000 });
    } catch (e) {
      log('WARN', `Failed to init shared workspace for ${envelopeId}: ${e.message}`);
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
  //  Drive folder provisioning
  // =========================================================================

  /**
   * Ensure a project has a Drive folder. Creates one under the artifacts root
   * if needed. For the agent's "general" project, uses "root" (My Drive).
   *
   * @param {string} projectId - Project to ensure folder for
   * @returns {Promise<string|null>} Drive folder ID, 'root', or null
   */
  async function ensureProjectFolder(projectId) {
    const PROJECTS = getProjects();
    const DEFAULT_PROJECT_ID = getDefaultProjectId();

    if (!projectId || !PROJECTS[projectId]) return null;
    const project = PROJECTS[projectId];
    const ctx = project.context || {};

    // Already has a Drive folder
    if (project.drive_folder_id) return project.drive_folder_id;
    if (ctx.drive_folder?.ref) return ctx.drive_folder.ref;

    // General project uses agent's My Drive root
    if (projectId === DEFAULT_PROJECT_ID || projectId.endsWith('/general')) {
      return 'root';
    }

    // No artifacts root configured — can't provision
    if (!_artifactsRootFolderId) {
      log('DEBUG', `No artifacts_root_folder_id configured — skipping Drive folder for ${projectId}`);
      return null;
    }

    try {
      const { execSync: exec } = await import('child_process');
      const projName = (project.name || projectId).replace(/["']/g, '');

      // Create project folder under root
      const mkdirOut = exec(
        `${coreDir}/bin/drive-mkdir "${projName}" --parent ${_artifactsRootFolderId}`,
        { timeout: 30_000, cwd: coreDir, encoding: 'utf8' }
      ).trim();

      // Parse folder ID from output (drive-mkdir outputs JSON with folderId)
      let folderId = null;
      try {
        const parsed = JSON.parse(mkdirOut);
        folderId = parsed.folderId || parsed.id || null;
      } catch {
        // Fallback: extract folder ID from text output
        const match = mkdirOut.match(/([a-zA-Z0-9_-]{20,})/);
        folderId = match ? match[1] : null;
      }

      if (!folderId) {
        log('WARN', `Failed to parse Drive folder ID from drive-mkdir output: ${mkdirOut.slice(0, 200)}`);
        return null;
      }

      // Update project context with new Drive folder
      project.context = project.context || {};
      project.context.drive_folder = {
        kind: 'drive_folder',
        ref: folderId,
        name: `Project: ${projName}`,
        summary: `Shared artifact storage for ${projName}`,
        url: `https://drive.google.com/drive/folders/${folderId}`,
        updatedAt: now(),
        updatedBy: 'brain',
      };
      PROJECTS[projectId] = project;

      // Persist to Firestore
      const token = await getGceToken();
      if (token) {
        const projUrl = `${FIRESTORE_BASE}/projects/${projectId}?updateMask.fieldPaths=context`;
        await fetch(projUrl, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { context: firestoreEncode(project.context) } }),
        });
      }

      log('INFO', `Project Drive folder provisioned: ${projName} → ${folderId}`);

      // Pre-share with fleet agents (best-effort)
      try {
        const fleetToken = await getGceToken();
        if (fleetToken && primeId) {
          const fleetUrl = `${FIRESTORE_BASE}/primes/${primeId}/fleet`;
          const fleetResp = await fetch(fleetUrl, {
            headers: { 'Authorization': `Bearer ${fleetToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (fleetResp.ok) {
            const fleetData = await fleetResp.json();
            for (const doc of (fleetData.documents || [])) {
              const fleetAgentEmail = doc.fields?.email?.stringValue;
              if (fleetAgentEmail && fleetAgentEmail !== agentEmail) {
                try {
                  exec(`${coreDir}/bin/drive-share ${folderId} --email ${fleetAgentEmail} --role writer`, { timeout: 15_000, cwd: coreDir });
                  log('DEBUG', `Shared project folder with ${fleetAgentEmail}`);
                } catch { /* best-effort */ }
              }
            }
          }
        }
      } catch (e) {
        log('DEBUG', `Fleet pre-share skipped: ${e.message}`);
      }

      return folderId;
    } catch (e) {
      log('WARN', `ensureProjectFolder failed for ${projectId}: ${e.message}`);
      return null;
    }
  }

  // =========================================================================
  //  Artifact publishing
  // =========================================================================

  /**
   * Publish artifacts from shared/{missionId}/ to Drive on mission completion.
   * Creates {project-folder}/{prime-name}/{agent-name}/ subfolder structure.
   *
   * @param {object} envelope - Mission envelope to publish artifacts for
   * @returns {Promise<Array<{name: string, driveId: string, url: string, size: number}>>}
   *   Array of published artifact descriptors (empty if none)
   */
  async function publish(envelope) {
    if (!envelope || envelope.type !== 'M') return [];

    const PROJECTS = getProjects();

    // Check if shared/ has files
    let files = [];
    try {
      const { readdirSync, statSync } = await import('fs');
      const sharedDir = `${coreDir}/shared/${envelope.id}`;
      try {
        files = readdirSync(sharedDir).filter(f => {
          try {
            return statSync(`${sharedDir}/${f}`).isFile();
          } catch { return false; }
        });
      } catch {
        return []; // No shared dir or empty
      }
    } catch {
      return [];
    }

    if (files.length === 0) return [];

    // Get project Drive folder
    const projectFolderId = await ensureProjectFolder(envelope.project_id);
    if (!projectFolderId) {
      log('DEBUG', `No Drive folder for project ${envelope.project_id} — skipping artifact publish`);
      return [];
    }

    try {
      const { execSync: exec } = await import('child_process');
      const { statSync } = await import('fs');

      // Create prime/agent subfolder structure
      const primeName = (primeId || 'unknown').replace(/["']/g, '');
      const agentName = (agentId || 'unknown').replace(/["']/g, '');

      let targetFolderId = projectFolderId;
      if (projectFolderId !== 'root') {
        // Create {prime-name}/ subfolder
        try {
          const primeOut = exec(
            `${coreDir}/bin/drive-mkdir "${primeName}" --parent ${projectFolderId}`,
            { timeout: 30_000, cwd: coreDir, encoding: 'utf8' }
          ).trim();
          const primeParsed = JSON.parse(primeOut).folderId || JSON.parse(primeOut).id;
          if (primeParsed) {
            // Create {agent-name}/ subfolder under prime
            const agentOut = exec(
              `${coreDir}/bin/drive-mkdir "${agentName}" --parent ${primeParsed}`,
              { timeout: 30_000, cwd: coreDir, encoding: 'utf8' }
            ).trim();
            targetFolderId = JSON.parse(agentOut).folderId || JSON.parse(agentOut).id || primeParsed;
          }
        } catch (e) {
          log('WARN', `Subfolder creation failed, publishing to project root: ${e.message}`);
        }
      }

      // Upload each file
      const artifacts = [];
      for (const file of files) {
        try {
          const filePath = `${coreDir}/shared/${envelope.id}/${file}`;
          const fileSize = statSync(filePath).size;
          const uploadOut = exec(
            `${coreDir}/bin/drive-upload "${filePath}" ${targetFolderId}`,
            { timeout: 60_000, cwd: coreDir, encoding: 'utf8' }
          ).trim();

          let fileId = null, webViewLink = null;
          try {
            const parsed = JSON.parse(uploadOut);
            fileId = parsed.fileId || parsed.id;
            webViewLink = parsed.webViewLink || parsed.url || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null);
          } catch {
            const match = uploadOut.match(/([a-zA-Z0-9_-]{20,})/);
            fileId = match ? match[1] : null;
            webViewLink = fileId ? `https://drive.google.com/file/d/${fileId}/view` : null;
          }

          if (fileId) {
            artifacts.push({ name: file, driveId: fileId, url: webViewLink, size: fileSize });
            log('INFO', `Artifact published: ${file} → ${fileId}`);
          }
        } catch (e) {
          log('WARN', `Failed to upload artifact ${file}: ${e.message}`);
        }
      }

      if (artifacts.length === 0) return [];

      // Auto-share with project owner
      const project = PROJECTS[envelope.project_id];
      if (project?.owner && project.owner !== agentEmail) {
        try {
          exec(
            `${coreDir}/bin/drive-share ${targetFolderId} --email ${project.owner} --role reader`,
            { timeout: 15_000, cwd: coreDir }
          );
          log('INFO', `Artifacts shared with project owner: ${project.owner}`);
        } catch (e) {
          log('DEBUG', `Auto-share with owner skipped: ${e.message}`);
        }
      }

      // Update envelope context with artifact manifest
      envelope.context = envelope.context || {};
      envelope.context.artifacts = {
        kind: 'artifact_manifest',
        summary: `${artifacts.length} artifact(s) published to Drive`,
        drive_folder: targetFolderId,
        drive_url: `https://drive.google.com/drive/folders/${targetFolderId}`,
        files: artifacts,
        updatedAt: now(),
        updatedBy: 'brain',
      };

      // Also update project context with latest artifacts (merge)
      if (project) {
        project.context = project.context || {};
        const existing = project.context.artifacts?.files || [];
        project.context.artifacts = {
          kind: 'artifact_manifest',
          summary: `${existing.length + artifacts.length} artifact(s) total`,
          drive_folder: projectFolderId !== 'root' ? projectFolderId : targetFolderId,
          drive_url: projectFolderId !== 'root' ? `https://drive.google.com/drive/folders/${projectFolderId}` : undefined,
          files: [...existing, ...artifacts],
          updatedAt: now(),
          updatedBy: agentId,
        };
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

      log('INFO', `Published ${artifacts.length} artifacts to Drive for mission ${envelope.id}`);
      return artifacts;
    } catch (e) {
      log('WARN', `publish failed: ${e.message}`);
      return [];
    }
  }

  return {
    /** Load artifacts_root_folder_id from prime config. */
    loadConfig,
    /** Get current artifacts root folder ID. */
    getArtifactsRootId,
    /** Initialize shared workspace for an envelope. */
    initWorkspace,
    /** Clean up shared workspace after completion. */
    cleanupWorkspace,
    /** Ensure a project has a Drive folder. */
    ensureProjectFolder,
    /** Publish shared/ artifacts to Drive. */
    publish,
  };
}
