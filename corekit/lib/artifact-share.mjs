// corekit/lib/artifact-share.mjs — upload local files to the GCS git bucket
// under a prime-scoped artifacts/ prefix, for dashboard attachment delivery.
//
// Config resolution mirrors git-store.mjs (the proven writer of this bucket):
// deployed contracts at CORE_DIR/corekit/contracts.json first, repo-dev
// infra/contracts.json as fallback; project from GCP_PROJECT_ID.
// Object layout: {prefix}primes/{primeId}/{scope}/{batch}/{name}
// — the app route enforces the primes/{id}/ segment for tenant isolation.

import { readFileSync, existsSync, statSync, realpathSync } from 'fs';
import { basename, join, dirname } from 'path';
import { hostname } from 'os';
import { getGceToken } from './gce-auth.mjs';

const CORE_DIR = process.env.CORE_ROOT || process.env.CORE_DIR || '/opt/corekit';

const MIME_TABLE = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html',
  '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function sniffMime(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0
    ? (MIME_TABLE[name.substring(dot).toLowerCase()] || 'application/octet-stream')
    : 'application/octet-stream';
}

// Never share credentials, regardless of caller.
function isDenied(absPath) {
  const p = absPath.toLowerCase();
  return p.endsWith('/.gateway-token') || p.includes('/keys/') || p.endsWith('sa-key.json');
}

let _cfg = null;
function loadConfig() {
  if (_cfg) return _cfg;
  let contracts = {};
  try {
    contracts = JSON.parse(readFileSync(join(CORE_DIR, 'corekit', 'contracts.json'), 'utf8'));
  } catch {
    try {
      const repoPath = join(
        dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
        '..', '..', 'infra', 'contracts.json'
      );
      contracts = JSON.parse(readFileSync(repoPath, 'utf8'));
    } catch { /* defaults below */ }
  }
  const git = contracts.git || {};
  const gcpProject = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';
  _cfg = {
    bucket: (git.bucket || '${TENANT}-agent-git').replace('${TENANT}', gcpProject),
    prefix: git.artifacts_prefix || 'artifacts/',
    maxBytes: (git.max_artifact_mb || 20) * 1024 * 1024,
    gcpProject,
  };
  return _cfg;
}

let _primeId = null;
async function resolvePrimeId() {
  if (_primeId) return _primeId;
  if (process.env.PRIME_ID) { _primeId = process.env.PRIME_ID; return _primeId; }
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/attributes/prime_id',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
    );
    if (res.ok) {
      const v = (await res.text()).trim();
      if (v) { _primeId = v; return _primeId; }
    }
  } catch { /* fall through */ }
  _primeId = hostname().replace(/^prime-/, '').replace(/^fleet-/, '');
  return _primeId;
}

/**
 * Upload local files as dashboard-shareable artifacts.
 * @param {string[]} absPaths  absolute file paths
 * @param {object} [opts]
 * @param {string} [opts.scope]  namespace under the prime, e.g. `missions/w-...`
 * @param {Function} [opts.log]  logger(level, msg)
 * @returns {Promise<Array<{name: string, size: number, gcsPath: string}>>}
 */
export async function uploadArtifacts(absPaths, opts = {}) {
  const log = opts.log || (() => {});
  const cfg = loadConfig();
  const results = [];

  if (!cfg.gcpProject) {
    log('WARN', 'uploadArtifacts: GCP_PROJECT_ID unresolved — cannot derive bucket, skipping');
    return results;
  }

  const primeId = await resolvePrimeId();
  if (!primeId) {
    log('WARN', 'uploadArtifacts: prime id unresolved, skipping');
    return results;
  }

  const token = await getGceToken().catch((err) => {
    log('ERROR', `uploadArtifacts auth failure: ${err.message}`);
    return null;
  });
  if (!token) return results;

  const scope = (opts.scope || 'misc').replace(/[^a-zA-Z0-9/_-]/g, '_');
  const batch = Date.now().toString(36);

  for (const raw of absPaths || []) {
    try {
      if (!existsSync(raw)) { log('WARN', `uploadArtifacts: missing ${raw}`); continue; }
      const abs = realpathSync(raw);
      if (isDenied(abs)) { log('WARN', `uploadArtifacts: denied credential path ${raw}`); continue; }
      const st = statSync(abs);
      if (st.isDirectory()) { log('WARN', `uploadArtifacts: skipping directory ${raw}`); continue; }
      if (st.size > cfg.maxBytes) {
        log('WARN', `uploadArtifacts: ${raw} exceeds ${cfg.maxBytes} bytes, skipping`);
        continue;
      }

      const name = basename(abs);
      const objectName = `${cfg.prefix}primes/${primeId}/${scope}/${batch}/${name}`;
      const data = readFileSync(abs);
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${cfg.bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': sniffMime(name) },
        body: data,
        signal: AbortSignal.timeout(120_000),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 160)}`);
      }
      await resp.json();

      log('INFO', `uploadArtifacts: uploaded ${name} (${st.size} B) → gs://${cfg.bucket}/${objectName}`);
      results.push({ name, size: st.size, gcsPath: objectName });
    } catch (err) {
      log('ERROR', `uploadArtifacts: failed ${raw}: ${err.message}`);
    }
  }
  return results;
}
