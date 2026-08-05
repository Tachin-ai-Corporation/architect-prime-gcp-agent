// sync-core.js — pure, dependency-free sync logic (unit-testable without Drive/GCS).
//
// The smart-sync delta decision and content-type mapping live here so they can be tested
// in isolation. index.js requires these and performs the actual Drive→GCS I/O around them.

/**
 * Map a filename to the Content-Type GCS should serve it with. Drive returns generic
 * mime types (e.g. text/plain for .html), which break rendering — so extensions win.
 * @param {string} name       filename
 * @param {string} [fallback] Drive's reported mimeType, used when no extension matches
 * @returns {string}
 */
function contentTypeFor(name, fallback) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.js')) return 'application/javascript';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  return fallback;
}

/**
 * Given the current Drive file list and the in-memory cache, decide what to upload and
 * what to delete — the heart of a smart (delta) sync.
 *   - upload:   files whose modifiedTime changed, or that aren't cached yet
 *   - delete:   gcsPaths in the cache that no longer exist in Drive
 * Pure: mutates nothing (the caller updates the cache after doing the I/O).
 *
 * @param {Array<{id:string,name:string,mimeType:string,modifiedTime:string,gcsPath:string}>} files
 * @param {Map<string,{fileId:string,modifiedTime:string}>} cache  gcsPath → cache entry
 * @returns {{upload:Array, delete:string[], unchanged:number}}
 */
function planDelta(files, cache) {
  const currentPaths = new Set();
  const upload = [];
  for (const f of files) {
    currentPaths.add(f.gcsPath);
    const cached = cache.get(f.gcsPath);
    if (!cached || cached.modifiedTime !== f.modifiedTime) upload.push(f);
  }
  const del = [];
  for (const gcsPath of cache.keys()) {
    if (!currentPaths.has(gcsPath)) del.push(gcsPath);
  }
  return { upload, delete: del, unchanged: files.length - upload.length };
}

module.exports = { contentTypeFor, planDelta };
