// corekit/lib/artifact-share.mjs — Exposes uploadArtifacts(absPaths, opts) to upload local files to the GCS git bucket under an artifacts/ prefix.
import fs from 'fs';
import path from 'path';
import { getGceToken } from './gce-auth.mjs';

const CONTRACTS = JSON.parse(fs.readFileSync(
  new URL('../../infra/contracts.json', import.meta.url),
  'utf8'
));

const GCP_PROJECT = process.env.GCP_PROJECT || '';
const BUCKET = (CONTRACTS.git.bucket || '').replace('${TENANT}', GCP_PROJECT);
const PREFIX = CONTRACTS.git.artifacts_prefix || 'artifacts/';
const MAX_MB = CONTRACTS.git.max_artifact_mb || 20;

/**
 * Upload local files to GCS under the artifacts/ prefix.
 * @param {string[]} absPaths - List of absolute file paths to upload.
 * @param {object} [opts] - Optional parameters.
 * @param {Function} [opts.log] - Logger function.
 * @returns {Promise<Array<{ name: string, url: string, size: number, gcsPath: string }>>} List of uploaded artifact descriptors.
 */
export async function uploadArtifacts(absPaths, opts = {}) {
  const log = opts.log || console.log;
  const results = [];

  if (!BUCKET) {
    log('WARN', 'uploadArtifacts: No GCS bucket configured in contracts.json');
    return results;
  }

  const token = await getGceToken().catch(err => {
    log('ERROR', `uploadArtifacts auth failure: ${err.message}`);
    return null;
  });

  if (!token) {
    log('WARN', 'uploadArtifacts: No auth token available, skipping upload');
    return results;
  }

  for (const absPath of absPaths) {
    try {
      if (!fs.existsSync(absPath)) {
        log('WARN', `uploadArtifacts: file does not exist: ${absPath}`);
        continue;
      }

      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        log('WARN', `uploadArtifacts: skipping directory: ${absPath}`);
        continue;
      }

      const sizeMb = stat.size / (1024 * 1024);
      if (sizeMb > MAX_MB) {
        log('WARN', `uploadArtifacts: file ${absPath} exceeds maximum size of ${MAX_MB}MB (${sizeMb.toFixed(2)}MB)`);
        continue;
      }

      const basename = path.basename(absPath);
      // Generate a unique directory name using current timestamp to avoid collision
      const timestamp = new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '').slice(0, 14);
      const objectName = `${PREFIX}${timestamp}_${basename}`;

      log('INFO', `uploadArtifacts: uploading ${basename} (${stat.size} bytes) to gs://${BUCKET}/${objectName}`);

      const data = fs.readFileSync(absPath);
      const encodedName = encodeURIComponent(objectName);
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodedName}`;

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
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      await resp.json();
      log('INFO', `uploadArtifacts: successfully uploaded ${basename} to gs://${BUCKET}/${objectName}`);

      results.push({
        name: basename,
        size: stat.size,
        gcsPath: objectName,
      });
    } catch (err) {
      log('ERROR', `uploadArtifacts: failed to upload ${absPath}: ${err.message}`);
    }
  }

  return results;
}
