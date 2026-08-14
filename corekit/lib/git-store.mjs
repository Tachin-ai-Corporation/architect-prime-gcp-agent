// corekit/lib/git-store.mjs — Tenant-internal git artifact substrate
// Transport: git bundles over GCS (objects) + Firestore (refs) with CAS.
// Invariants: objects-before-ref push ordering (C-18), compare-and-swap
// ref advancement (C-16), content-addressed bundles (idempotent writes).
//
// Public API:
//   ensureRepo, cloneRepo, fetchBranch, pushBranch, readRef, listRefs,
//   mergeBranch, gc, buildManifest, sanitizeRepoId, allocateVersion
//
// CLI: node git-store.mjs <cmd> [args...] — prints JSON to stdout,
//      logs to stderr with [git-store] prefix.

import { getGceToken } from './gce-auth.mjs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { tmpdir } from 'os';

// ── Logging ────────────────────────────────────────────────────────────
const log = (...args) => console.error('[git-store]', ...args);

// ── Config ─────────────────────────────────────────────────────────────
let _config = null;

function loadConfig() {
  if (_config) return _config;
  const coreDir = process.env.CORE_DIR || '/opt/corekit';
  const contractsPath = join(coreDir, 'corekit', 'contracts.json');
  let contracts;
  try {
    contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  } catch {
    // Fallback: try repo-relative path
    const repoPath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..', 'infra', 'contracts.json');
    contracts = JSON.parse(readFileSync(repoPath, 'utf8'));
  }
  const git = contracts.git || {};
  const gcpProject = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
  // Resolve ${TENANT} placeholder
  const bucket = (git.bucket || '').replace('${TENANT}', gcpProject);
  _config = {
    bucket,
    prefix: git.prefix || 'git/',
    defaultBranch: git.defaultBranch || 'main',
    maxPushRetries: git.maxPushRetries || 5,
    gcBundleThreshold: git.gcBundleThreshold || 25,
    gcpProject,
  };
  return _config;
}

// ── Store injection seam (for local tests) ─────────────────────────────
// Module-level store object — holds GCS/Firestore implementations.
// Default: real GCS/Firestore REST calls. Tests can override via _setTestStore().
let _store = null; // null = use real implementations below

/**
 * Inject a test store implementation. Set to null to restore defaults.
 * The store object must implement: { gcsPut, gcsGet, gcsExists, gcsDelete,
 *   firestoreRead, firestoreWrite, firestoreDelete, firestoreList }
 * @param {object|null} store
 */
export function _setTestStore(store) { _store = store; }

/**
 * Inject test config, bypassing contracts.json loading.
 * @param {object|null} config - config object or null to restore auto-load
 */
export function _setTestConfig(config) { _config = config; }

// ── GCS REST helpers ───────────────────────────────────────────────────

async function gcsPut(bucket, objectName, data) {
  if (_store) return _store.gcsPut(bucket, objectName, data);
  const token = await getGceToken();
  const encodedName = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodedName}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: data,
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GCS PUT failed: ${resp.status} ${text}`);
  }
  return await resp.json();
}

async function gcsGet(bucket, objectName) {
  if (_store) return _store.gcsGet(bucket, objectName);
  const token = await getGceToken();
  const encodedName = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedName}?alt=media`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    const text = await resp.text();
    throw new Error(`GCS GET failed: ${resp.status} ${text}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function gcsExists(bucket, objectName) {
  if (_store) return _store.gcsExists(bucket, objectName);
  const token = await getGceToken();
  const encodedName = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedName}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

async function gcsDelete(bucket, objectName) {
  if (_store) return _store.gcsDelete(bucket, objectName);
  const token = await getGceToken();
  const encodedName = encodeURIComponent(objectName);
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodedName}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok || resp.status === 404;
}

// ── Firestore REST helpers (with CAS) ──────────────────────────────────

function firestoreBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function firestoreRead(projectId, docPath) {
  if (_store) return _store.firestoreRead(projectId, docPath);
  const token = await getGceToken();
  const url = `${firestoreBase(projectId)}/${docPath}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    // A6 fix: surface real errors instead of silently returning null
    const text = await resp.text();
    throw new Error(`Firestore read failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const doc = await resp.json();
  return doc;
}

async function firestoreWrite(projectId, docPath, fields, precondition) {
  if (_store) return _store.firestoreWrite(projectId, docPath, fields, precondition);
  const token = await getGceToken();
  // Use the Firestore commit API for CAS with preconditions
  const base = firestoreBase(projectId);
  const docName = `projects/${projectId}/databases/(default)/documents/${docPath}`;

  const write = {
    update: {
      name: docName,
      fields,
    },
  };

  if (precondition) {
    write.currentDocument = precondition;
  }
  // Firestore :commit endpoint is at the database level, not documents
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const resp = await fetch(commitUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes: [write] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 409 || text.includes('FAILED_PRECONDITION') || text.includes('ALREADY_EXISTS')) {
      return { ok: false, reason: 'PRECONDITION_FAILED', detail: text };
    }
    throw new Error(`Firestore commit failed: ${resp.status} ${text}`);
  }
  return { ok: true, result: await resp.json() };
}

async function firestoreDelete(projectId, docPath) {
  if (_store) return _store.firestoreDelete(projectId, docPath);
  const token = await getGceToken();
  const url = `${firestoreBase(projectId)}/${docPath}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

async function firestoreList(projectId, collectionPath) {
  if (_store) return _store.firestoreList(projectId, collectionPath);
  const token = await getGceToken();
  const url = `${firestoreBase(projectId)}/${collectionPath}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.documents || [];
}

// ── Encoding helpers ───────────────────────────────────────────────────

function encodeStringValue(s) { return { stringValue: s }; }
function encodeIntValue(n) { return { integerValue: String(n) }; }
function encodeArrayOfStrings(arr) {
  return { arrayValue: { values: arr.map(s => ({ stringValue: s })) } };
}
function decodeStringValue(v) { return v?.stringValue || null; }
function decodeArrayOfStrings(v) {
  return (v?.arrayValue?.values || []).map(item => item.stringValue || '');
}

// ── Git helpers ────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const cmd = `git ${args}`;
  const result = execSync(cmd, {
    cwd: opts.cwd || process.cwd(),
    timeout: opts.timeout || 60_000,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  });
  return result.trim();
}

function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function makeTmpDir(prefix = 'git-store-') {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Object path helpers ────────────────────────────────────────────────

function bundleObjectPath(config, repoId, bundleSha) {
  return `${config.prefix}${repoId}/bundles/${bundleSha}.bundle`;
}

function repoDocPath(repoId) {
  return `git_repos/${repoId}`;
}

function refDocPath(repoId, branch) {
  // Firestore doc IDs can't contain /; encode branch separators
  const safeBranch = branch.replace(/\//g, '__');
  return `git_repos/${repoId}/refs/${safeBranch}`;
}

// ── Input validation (A8) ──────────────────────────────────────────────

const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;

/**
 * Sanitize a raw project ID into a valid repoId.
 * Lowercases, replaces non-alphanumeric chars with hyphens, trims.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeRepoId(raw) {
  if (!raw) throw new Error('repoId is required');
  return raw.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unnamed';
}

function validateRepoId(repoId) {
  if (!REPO_ID_RE.test(repoId)) {
    throw new Error(`Invalid repoId: "${repoId}" — must match ${REPO_ID_RE}`);
  }
}

function validateBranch(branch) {
  if (!BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch: "${branch}" — must match ${BRANCH_RE}`);
  }
}

/**
 * Allocate a deterministic daily version index.
 * Reads the commit log on targetRef for today's commits and returns the
 * next available index (1-based).
 * @param {string} gitDir - path to local git working tree
 * @param {string} targetRef - ref to scan (e.g. 'main')
 * @param {Date} [date] - date to allocate for (default: now)
 * @returns {number}
 */
export function allocateVersion(gitDir, targetRef, date) {
  const d = date || new Date();
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '.');
  const escapedDate = dateStr.replace(/\./g, '\\.');
  const pattern = `^v${escapedDate}\\.(\\d+)\\.`;
  try {
    const since = `${d.toISOString().slice(0, 10)}T00:00:00Z`;
    const logOutput = git(`log ${targetRef} --since="${since}" --format=%s`, { cwd: gitDir });
    const indices = logOutput.split('\n').filter(Boolean)
      .map(s => s.match(new RegExp(pattern))?.[1])
      .filter(Boolean).map(Number);
    return Math.max(0, ...indices) + 1;
  } catch { return 1; }
}

// ══════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════════════

/**
 * Ensure a repo document exists. Idempotent.
 * @param {string} repoId
 * @param {object} [opts]
 * @param {string} [opts.mergePolicy='auto']
 * @returns {Promise<object>} repo doc data
 */
export async function ensureRepo(repoId, opts = {}) {
  validateRepoId(repoId);
  const config = loadConfig();
  const mergePolicy = opts.mergePolicy || 'auto';
  const docPath = repoDocPath(repoId);
  const now = new Date().toISOString();

  // Check if repo already exists
  const existing = await firestoreRead(config.gcpProject, docPath);
  if (existing && existing.fields) {
    log('ensureRepo: repo already exists:', repoId);
    return {
      id: repoId,
      default_branch: decodeStringValue(existing.fields.default_branch) || config.defaultBranch,
      merge_policy: decodeStringValue(existing.fields.merge_policy) || mergePolicy,
      created_at: decodeStringValue(existing.fields.created_at),
      updated_at: decodeStringValue(existing.fields.updated_at),
    };
  }

  // Create repo doc (precondition: must not exist)
  const fields = {
    id: encodeStringValue(repoId),
    default_branch: encodeStringValue(config.defaultBranch),
    merge_policy: encodeStringValue(mergePolicy),
    created_at: encodeStringValue(now),
    updated_at: encodeStringValue(now),
  };

  const result = await firestoreWrite(config.gcpProject, docPath, fields, { exists: false });
  if (!result.ok) {
    // Race: another caller created it; re-read
    log('ensureRepo: concurrent create, re-reading:', repoId);
    const reread = await firestoreRead(config.gcpProject, docPath);
    if (reread?.fields) {
      return {
        id: repoId,
        default_branch: decodeStringValue(reread.fields.default_branch) || config.defaultBranch,
        merge_policy: decodeStringValue(reread.fields.merge_policy) || mergePolicy,
        created_at: decodeStringValue(reread.fields.created_at),
        updated_at: decodeStringValue(reread.fields.updated_at),
      };
    }
  }

  log('ensureRepo: created:', repoId);
  return {
    id: repoId,
    default_branch: config.defaultBranch,
    merge_policy: mergePolicy,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Read a branch ref.
 * @param {string} repoId
 * @param {string} branch
 * @returns {Promise<{sha: string, bundle_keys: string[], updateTime: string}|null>}
 */
export async function readRef(repoId, branch) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const docPath = refDocPath(repoId, branch);
  const doc = await firestoreRead(config.gcpProject, docPath);
  if (!doc || !doc.fields) return null;
  return {
    sha: decodeStringValue(doc.fields.sha),
    bundle_keys: decodeArrayOfStrings(doc.fields.bundle_keys),
    updateTime: doc.updateTime || null,
  };
}

/**
 * List all refs for a repo.
 * @param {string} repoId
 * @returns {Promise<Array<{branch: string, sha: string}>>}
 */
export async function listRefs(repoId) {
  validateRepoId(repoId);
  const config = loadConfig();
  const collectionPath = `git_repos/${repoId}/refs`;
  const docs = await firestoreList(config.gcpProject, collectionPath);
  return docs.map(doc => {
    const id = doc.name.split('/').pop();
    const branch = id.replace(/__/g, '/');
    return {
      branch,
      sha: decodeStringValue(doc.fields?.sha),
    };
  });
}

/**
 * Fetch a branch into a local git dir. Downloads and unbundles
 * any bundle_keys not yet applied locally.
 * @param {string} repoId
 * @param {string} branch
 * @param {string} gitDir - path to local git working tree
 * @returns {Promise<{sha: string|null, appliedBundles: string[]}>}
 */
export async function fetchBranch(repoId, branch, gitDir) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const ref = await readRef(repoId, branch);
  if (!ref) return { sha: null, appliedBundles: [] };

  const appliedBundles = [];
  const tmpDir = makeTmpDir('fetch-');

  try {
    for (const bundleKey of ref.bundle_keys) {
      const bundlePath = join(tmpDir, `${bundleKey}.bundle`);
      const objectPath = bundleObjectPath(config, repoId, bundleKey);

      // Download bundle from GCS
      const bundleData = await gcsGet(config.bucket, objectPath);
      if (!bundleData) {
        // A7 fix: hard-fail on missing bundles — chain is broken
        throw new Error(`BUNDLE_MISSING: ${objectPath} — chain is broken, cannot advance ref`);
      }
      writeFileSync(bundlePath, bundleData);

      // Verify bundle integrity
      try {
        git(`bundle verify "${bundlePath}"`, { cwd: gitDir });
      } catch (e) {
        // Bundle may reference commits we already have — try unbundling anyway
        log('WARN', `Bundle verify warning (proceeding): ${e.message?.slice(0, 100)}`);
      }

      // Unbundle
      try {
        git(`bundle unbundle "${bundlePath}"`, { cwd: gitDir });
        appliedBundles.push(bundleKey);
      } catch (e) {
        log('WARN', `Bundle unbundle warning: ${e.message?.slice(0, 100)}`);
      }
    }

    // A1 fix: write to private remote-tracking ref — never touch refs/heads/{branch}
    // directly (doing so on a checked-out branch orphans local commits).
    if (ref.sha) {
      const safeRef = `refs/git-store/remote/${branch}`;
      try {
        git(`update-ref "${safeRef}" ${ref.sha}`, { cwd: gitDir });
      } catch (e) {
        log('WARN', `update-ref to remote ref failed: ${e.message?.slice(0, 100)}`);
      }
    }
  } finally {
    // Cleanup tmp
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
  }

  return { sha: ref.sha, appliedBundles };
}

/**
 * Clone a repo into a new directory.
 * @param {string} repoId
 * @param {string} branch
 * @param {string} destDir
 * @returns {Promise<{repoId: string, branch: string, sha: string|null, dir: string}>}
 */
export async function cloneRepo(repoId, branch, destDir) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const resolvedDir = resolve(destDir);

  // Init a new git repo if the dir doesn't exist or isn't a git repo
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
  }
  if (!existsSync(join(resolvedDir, '.git'))) {
    git('init', { cwd: resolvedDir });
    // Set default branch
    git(`checkout -b "${branch}"`, { cwd: resolvedDir });
  }

  // Fetch the branch (writes to refs/git-store/remote/{branch})
  const { sha } = await fetchBranch(repoId, branch, resolvedDir);

  if (sha) {
    // Clone is the one path where we DO advance refs/heads — via checkout.
    // fetchBranch wrote the remote SHA to refs/git-store/remote/{branch}.
    try {
      git(`checkout -B "${branch}" ${sha}`, { cwd: resolvedDir });
    } catch {
      try {
        git(`reset --hard ${sha}`, { cwd: resolvedDir });
      } catch (e) {
        log('WARN', `checkout/reset failed: ${e.message?.slice(0, 100)}`);
      }
    }
  }

  return { repoId, branch, sha, dir: resolvedDir };
}

/**
 * Push local commits to the ether. Objects-before-ref ordering.
 * Returns NON_FAST_FORWARD if the ref was advanced by another agent.
 * @param {string} repoId
 * @param {string} branch
 * @param {string} gitDir
 * @param {string} actor - agent identity for attribution
 * @returns {Promise<{status: 'pushed'|'up_to_date'|'NON_FAST_FORWARD', sha: string|null}>}
 */
export async function pushBranch(repoId, branch, gitDir, actor) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();

  // Step 1: Read remote ref + capture updateTime for CAS
  const ref = await readRef(repoId, branch);
  const remoteSha = ref?.sha || null;
  const bundleKeys = ref?.bundle_keys || [];
  const updateTime = ref?.updateTime || null;

  // Get local HEAD
  let localHead;
  try {
    localHead = git('rev-parse HEAD', { cwd: gitDir });
  } catch {
    return { status: 'up_to_date', sha: null };
  }

  // Step 3: Nothing to push if identical
  if (localHead === remoteSha) {
    return { status: 'up_to_date', sha: localHead };
  }

  // Step 2: Verify fast-forward
  if (remoteSha) {
    try {
      git(`merge-base --is-ancestor ${remoteSha} HEAD`, { cwd: gitDir });
    } catch {
      return { status: 'NON_FAST_FORWARD', sha: localHead };
    }
  }

  // Step 4: Create the delta bundle
  const tmpDir = makeTmpDir('push-');
  const bundlePath = join(tmpDir, 'push.bundle');
  try {
    if (remoteSha) {
      git(`bundle create "${bundlePath}" ${remoteSha}..HEAD`, { cwd: gitDir });
    } else {
      git(`bundle create "${bundlePath}" ${branch}`, { cwd: gitDir });
    }
  } catch (e) {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
    throw new Error(`Bundle creation failed: ${e.message}`);
  }

  const bundleSha = sha256File(bundlePath);
  const objectPath = bundleObjectPath(config, repoId, bundleSha);

  try {
    // Step 5: Objects first — upload bundle to GCS (skip if exists)
    const exists = await gcsExists(config.bucket, objectPath);
    if (!exists) {
      const bundleData = readFileSync(bundlePath);
      await gcsPut(config.bucket, objectPath, bundleData);
      log('push: bundle uploaded:', bundleSha.slice(0, 12));
    } else {
      log('push: bundle already exists:', bundleSha.slice(0, 12));
    }

    // Step 6: Ref second — atomic CAS
    const newBundleKeys = [...bundleKeys, bundleSha];
    const now = new Date().toISOString();
    const refPath = refDocPath(repoId, branch);
    const fields = {
      sha: encodeStringValue(localHead),
      bundle_keys: encodeArrayOfStrings(newBundleKeys),
      updated_at: encodeStringValue(now),
      updated_by: encodeStringValue(actor),
    };

    // CAS precondition: match updateTime (existing ref) or exists:false (new ref)
    const precondition = updateTime
      ? { updateTime }
      : { exists: false };

    const result = await firestoreWrite(config.gcpProject, refPath, fields, precondition);

    if (!result.ok) {
      // Step 7: CAS failed — someone else advanced the ref
      log('push: CAS failed (non-fast-forward):', result.reason);
      return { status: 'NON_FAST_FORWARD', sha: localHead };
    }

    log('push: ref advanced:', branch, '->', localHead.slice(0, 12));
    return { status: 'pushed', sha: localHead };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
  }
}

/**
 * Push with automatic fetch+rebase retry on non-fast-forward.
 * @param {string} repoId
 * @param {string} branch
 * @param {string} gitDir
 * @param {string} actor
 * @returns {Promise<{status: 'pushed'|'up_to_date'|'failed', sha: string|null, attempts: number}>}
 */
export async function pushWithRetry(repoId, branch, gitDir, actor) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const maxRetries = config.maxPushRetries;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await pushBranch(repoId, branch, gitDir, actor);

    if (result.status !== 'NON_FAST_FORWARD') {
      return { ...result, attempts: attempt };
    }

    log(`push: attempt ${attempt}/${maxRetries} got NON_FAST_FORWARD, fetching + rebasing...`);

    // Fetch latest (writes to refs/git-store/remote/{branch})
    await fetchBranch(repoId, branch, gitDir);

    // A1 fix: rebase local commits onto the fetched remote tip (private ref).
    // fetchBranch wrote the latest SHA to refs/git-store/remote/{branch} —
    // never to refs/heads/{branch} — so rebase against the private ref.
    const remoteRef = `refs/git-store/remote/${branch}`;
    try {
      git(`rebase "${remoteRef}"`, { cwd: gitDir });
    } catch (e) {
      // If rebase fails, abort and report
      try { git('rebase --abort', { cwd: gitDir }); } catch { /* ignore */ }
      log('push: rebase failed:', e.message?.slice(0, 100));
      return { status: 'failed', sha: null, attempts: attempt };
    }

    // Small randomized backoff
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
  }

  return { status: 'failed', sha: null, attempts: maxRetries };
}

/**
 * Merge source branch into target branch.
 * @param {string} repoId
 * @param {string} sourceBranch
 * @param {string} targetBranch
 * @param {'auto'|'gated'} policy
 * @param {string} actor
 * @returns {Promise<{status: 'merged'|'AWAITING_APPROVAL'|'failed', sha: string|null}>}
 */
export async function mergeBranch(repoId, sourceBranch, targetBranch, policy, actor) {
  validateRepoId(repoId);
  validateBranch(sourceBranch);
  validateBranch(targetBranch);
  if (policy === 'gated') {
    log('merge: gated policy — returning AWAITING_APPROVAL');
    return { status: 'AWAITING_APPROVAL', sha: null };
  }

  const config = loadConfig();
  // A14 fix: use real agent email if available
  const actorEmail = process.env.AGENT_USER_EMAIL || `${actor}@agent`;
  const mergeEnv = {
    GIT_AUTHOR_NAME: actor,
    GIT_AUTHOR_EMAIL: actorEmail,
    GIT_COMMITTER_NAME: actor,
    GIT_COMMITTER_EMAIL: actorEmail,
  };

  const tmpDir = makeTmpDir('merge-');
  try {
    // Merge with retry: if the target moves during merge, re-fetch + re-merge.
    for (let mergeAttempt = 0; mergeAttempt < config.maxPushRetries; mergeAttempt++) {
      // Clone target branch fresh (or re-fetch on retry)
      if (mergeAttempt === 0) {
        await cloneRepo(repoId, targetBranch, tmpDir);
      } else {
        // Re-fetch target and reset to remote tip
        await fetchBranch(repoId, targetBranch, tmpDir);
        const remoteRef = `refs/git-store/remote/${targetBranch}`;
        try {
          git(`checkout -B "${targetBranch}" "${remoteRef}"`, { cwd: tmpDir });
        } catch {
          log('merge: failed to reset to remote target after re-fetch');
          return { status: 'failed', sha: null };
        }
      }

      // Fetch the source branch
      await fetchBranch(repoId, sourceBranch, tmpDir);
      const sourceRef = `refs/git-store/remote/${sourceBranch}`;

      // Try fast-forward first
      let merged = false;
      try {
        git(`merge --ff-only "${sourceRef}"`, { cwd: tmpDir });
        merged = true;
      } catch {
        // Fall back to merge commit
        try {
          git(`merge "${sourceRef}" --no-edit -m "Merge ${sourceBranch} into ${targetBranch}"`, {
            cwd: tmpDir,
            env: mergeEnv,
          });
          merged = true;
        } catch (e) {
          // Capture WHICH files conflicted BEFORE aborting — a bare "failed" is unactionable.
          let conflicts = [];
          try {
            conflicts = git('diff --name-only --diff-filter=U', { cwd: tmpDir })
              .split('\n').map(s => s.trim()).filter(Boolean);
          } catch { /* ignore */ }
          log('merge: conflict:', `${e.message?.slice(0, 80)}` +
            (conflicts.length ? ` [conflicting files: ${conflicts.join(', ').slice(0, 200)}]` : ''));
          try { git('merge --abort', { cwd: tmpDir }); } catch { /* ignore */ }
          return { status: 'failed', sha: null, reason: 'conflict', conflicts };
        }
      }

      if (!merged) return { status: 'failed', sha: null };

      // Push the merged target branch
      const pushResult = await pushBranch(repoId, targetBranch, tmpDir, actor);
      if (pushResult.status === 'pushed' || pushResult.status === 'up_to_date') {
        const mergedSha = git('rev-parse HEAD', { cwd: tmpDir });
        return { status: 'merged', sha: mergedSha };
      }

      if (pushResult.status !== 'NON_FAST_FORWARD') {
        return { status: 'failed', sha: null };
      }

      // Target was advanced concurrently — retry merge on next iteration
      log(`merge: target advanced during merge (attempt ${mergeAttempt + 1}), retrying...`);
    }

    return { status: 'failed', sha: null };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
  }
}

/**
 * Garbage-collect: consolidate bundle chain into a single full bundle.
 * @param {string} repoId
 * @param {string} branch
 * @returns {Promise<{sha: string|null, bundle_keys: string[]}>}
 */
export async function gc(repoId, branch) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const ref = await readRef(repoId, branch);
  if (!ref || ref.bundle_keys.length <= 1) {
    return { sha: ref?.sha || null, bundle_keys: ref?.bundle_keys || [] };
  }

  log('gc: consolidating', ref.bundle_keys.length, 'bundles for', `${repoId}/${branch}`);

  const tmpDir = makeTmpDir('gc-');
  try {
    // Clone full branch
    await cloneRepo(repoId, branch, tmpDir);

    // Create full bundle
    const fullBundlePath = join(tmpDir, 'full.bundle');
    git(`bundle create "${fullBundlePath}" ${branch}`, { cwd: tmpDir });
    const fullBundleSha = sha256File(fullBundlePath);
    const objectPath = bundleObjectPath(config, repoId, fullBundleSha);

    // Upload full bundle
    const exists = await gcsExists(config.bucket, objectPath);
    if (!exists) {
      const bundleData = readFileSync(fullBundlePath);
      await gcsPut(config.bucket, objectPath, bundleData);
    }

    // CAS the ref to single bundle
    const refPath = refDocPath(repoId, branch);
    const fields = {
      sha: encodeStringValue(ref.sha),
      bundle_keys: encodeArrayOfStrings([fullBundleSha]),
      updated_at: encodeStringValue(new Date().toISOString()),
      updated_by: encodeStringValue('gc'),
    };
    const result = await firestoreWrite(config.gcpProject, refPath, fields, { updateTime: ref.updateTime });

    if (!result.ok) {
      log('gc: CAS failed (ref was modified during gc), skipping');
      return { sha: ref.sha, bundle_keys: ref.bundle_keys };
    }

    // Delete old bundles (only after CAS success)
    const oldBundleKeys = ref.bundle_keys.filter(k => k !== fullBundleSha);
    for (const key of oldBundleKeys) {
      const oldPath = bundleObjectPath(config, repoId, key);
      await gcsDelete(config.bucket, oldPath);
    }

    log('gc: consolidated to 1 bundle:', fullBundleSha.slice(0, 12));
    return { sha: ref.sha, bundle_keys: [fullBundleSha] };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
  }
}

/**
 * Build an artifact manifest for changed files at a commit.
 * @param {string} repoId
 * @param {string} branch
 * @param {string[]} changedPaths - files to include (if empty, includes all tracked files)
 * @param {object} [opts]
 * @param {string} [opts.summary] - manifest summary
 * @returns {Promise<object>} manifest conforming to §1.6
 */
export async function buildManifest(repoId, branch, changedPaths, opts = {}) {
  validateRepoId(repoId);
  validateBranch(branch);
  const config = loadConfig();
  const tmpDir = makeTmpDir('manifest-');

  try {
    await cloneRepo(repoId, branch, tmpDir);
    const commitSha = git('rev-parse HEAD', { cwd: tmpDir });

    // Resolve file list
    const paths = changedPaths && changedPaths.length > 0
      ? changedPaths
      : git('ls-tree -r --name-only HEAD', { cwd: tmpDir }).split('\n').filter(Boolean);

    const files = [];
    for (const p of paths) {
      const fullPath = join(tmpDir, p);
      if (!existsSync(fullPath)) continue;
      try {
        const blobSha = git(`hash-object "${fullPath}"`, { cwd: tmpDir });
        const size = statSync(fullPath).size;
        files.push({ path: p, blob_sha: blobSha, size });
      } catch { /* skip */ }
    }

    return {
      kind: 'artifact_manifest',
      summary: opts.summary || `${files.length} file(s) in ${repoId}/${branch}`,
      repo: repoId,
      branch,
      commit: commitSha,
      files,
    };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`, { timeout: 5000 }); } catch { /* ignore */ }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  CLI DISPATCH
// ══════════════════════════════════════════════════════════════════════

async function main() {
  const [,, cmd, ...args] = process.argv;

  const commands = {
    async ensure() {
      const repoId = args[0];
      if (!repoId) throw new Error('Usage: ensure <repoId> [--merge-policy auto|gated]');
      const policy = args.indexOf('--merge-policy') >= 0 ? args[args.indexOf('--merge-policy') + 1] : 'auto';
      const result = await ensureRepo(repoId, { mergePolicy: policy });
      return result;
    },

    async clone() {
      const repoId = args[0];
      if (!repoId || repoId.startsWith('--')) throw new Error('Usage: clone <repoId> [--ref <branch>] [--dir <path>]');
      // Parse --ref/--dir by flag. Positional forms (clone <repo> [<branch>] [<dir>]) still work,
      // but a token starting with '--' is NEVER a positional value — that is what made
      // `clone <repo> --dir X` (no --ref) mis-read branch as "--dir".
      const refIdx = args.indexOf('--ref');
      const dirIdx = args.indexOf('--dir');
      const posBranch = (args[1] && !args[1].startsWith('--')) ? args[1] : null;
      const posDir = (args[2] && !args[2].startsWith('--')) ? args[2] : null;
      const branch = (refIdx >= 0 ? args[refIdx + 1] : posBranch) || loadConfig().defaultBranch;
      const dir = (dirIdx >= 0 ? args[dirIdx + 1] : posDir) || `./${repoId}`;
      const result = await cloneRepo(repoId, branch, dir);
      return result;
    },

    async fetch() {
      const repoId = args[0];
      const branch = args[1] || loadConfig().defaultBranch;
      const gitDir = args[2] || '.';
      if (!repoId) throw new Error('Usage: fetch <repoId> <branch> [gitDir]');
      const result = await fetchBranch(repoId, branch, gitDir);
      return result;
    },

    async push() {
      const repoId = args[0];
      const branch = args[1] || loadConfig().defaultBranch;
      const gitDir = args[2] || '.';
      const actor = args[3] || process.env.AGENT_ID || 'unknown';
      if (!repoId) throw new Error('Usage: push <repoId> <branch> [gitDir] [actor]');
      const result = await pushWithRetry(repoId, branch, gitDir, actor);
      return result;
    },

    async merge() {
      const repoId = args[0];
      const source = args[1];
      const target = args[2] || loadConfig().defaultBranch;
      const policy = args[3] || 'auto';
      const actor = args[4] || process.env.AGENT_ID || 'unknown';
      if (!repoId || !source) throw new Error('Usage: merge <repoId> <source> [target] [policy] [actor]');
      const result = await mergeBranch(repoId, source, target, policy, actor);
      return result;
    },

    async gc_cmd() {
      const repoId = args[0];
      const branch = args[1] || loadConfig().defaultBranch;
      if (!repoId) throw new Error('Usage: gc <repoId> [branch]');
      const result = await gc(repoId, branch);
      return result;
    },

    async manifest() {
      const repoId = args[0];
      const branch = args[1] || loadConfig().defaultBranch;
      const paths = args.slice(2);
      if (!repoId) throw new Error('Usage: manifest <repoId> [branch] [paths...]');
      const result = await buildManifest(repoId, branch, paths);
      return result;
    },

    async 'read-ref'() {
      const repoId = args[0];
      const branch = args[1] || loadConfig().defaultBranch;
      if (!repoId) throw new Error('Usage: read-ref <repoId> [branch]');
      const result = await readRef(repoId, branch);
      return result || { sha: null, bundle_keys: [] };
    },

    async 'list-refs'() {
      const repoId = args[0];
      if (!repoId) throw new Error('Usage: list-refs <repoId>');
      const result = await listRefs(repoId);
      return result;
    },
  };

  // Alias gc -> gc_cmd
  commands.gc = commands.gc_cmd;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(JSON.stringify({
      commands: Object.keys(commands).filter(k => k !== 'gc_cmd'),
      usage: 'node git-store.mjs <command> [args...]',
    }, null, 2));
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`[git-store] Unknown command: ${cmd}`);
    console.error('[git-store] Available:', Object.keys(commands).filter(k => k !== 'gc_cmd').join(', '));
    process.exit(1);
  }

  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`[git-store] ERROR: ${e.message}`);
    process.exit(1);
  }
}

// Run CLI if invoked directly
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('git-store.mjs') ||
  process.argv[1].endsWith('git-store')
);
if (isDirectRun) {
  main().catch(e => {
    console.error(`[git-store] FATAL: ${e.message}`);
    process.exit(1);
  });
}
