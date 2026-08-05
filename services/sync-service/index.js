// index.js — Sync operations: full sync, smart delta sync, single-file upload
//
// Smart sync: lists Drive folder, compares modifiedTime against in-memory cache,
// downloads + uploads ONLY changed files. When nothing changes, completes in <1s.
// Full sync: re-downloads everything, reconciles GCS deletions. Used on startup
// and periodic reconciliation.

const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'default-sync-bucket';
const ROOT_FOLDER_ID = process.env.DRIVE_FOLDER_ID || 'YOUR_DRIVE_FOLDER_ID';

// ── Shared clients (singleton) ──────────────────────────────────────────────

let _drive = null;
function getDrive() {
  if (!_drive) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    _drive = google.drive({ version: 'v3', auth });
  }
  return _drive;
}

function getBucket() {
  return storage.bucket(BUCKET_NAME);
}

// ── File modification cache ─────────────────────────────────────────────────
// gcsPath → { fileId, modifiedTime }
// Built during full sync, maintained during smart sync.

const fileCache = new Map();
function getFileCache() { return fileCache; }

// ── List all items in a single Drive folder ─────────────────────────────────

async function listFolder(drive, folderId) {
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    if (res.data.files) items.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

// ── Traverse folder tree, collect all files with paths ──────────────────────

async function collectFiles(drive, rootFolderId) {
  const files = [];
  const ignored = [];

  async function traverse(folderId, pathPrefix) {
    const items = await listFolder(drive, folderId);
    for (const item of items) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        await traverse(item.id, pathPrefix + item.name + '/');
      } else if (folderId === rootFolderId) {
        ignored.push(item.name);
      } else {
        files.push({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          modifiedTime: item.modifiedTime,
          gcsPath: pathPrefix + item.name
        });
      }
    }
  }

  await traverse(rootFolderId, '');
  return { files, ignored };
}

// ── Upload one file from Drive → GCS ────────────────────────────────────────

async function uploadFile(drive, bucket, fileId, fileName, mimeType, gcsPath) {
  let contentType = mimeType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.html')) contentType = 'text/html';
  else if (lower.endsWith('.css'))  contentType = 'text/css';
  else if (lower.endsWith('.js'))   contentType = 'application/javascript';
  else if (lower.endsWith('.md'))   contentType = 'text/markdown';
  else if (lower.endsWith('.json')) contentType = 'application/json';

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    response.data
      .pipe(bucket.file(gcsPath).createWriteStream({
        resumable: false,
        metadata: { contentType }
      }))
      .on('error', reject)
      .on('finish', resolve);
  });
}

// ── SMART SYNC ──────────────────────────────────────────────────────────────
// Lists all files, compares modifiedTime against cache, syncs only changed.
// When nothing changed: ~1 API call, <1 second.
// When 1 file changed: ~1 API call + 1 download + 1 upload, <3 seconds.

async function smartSync(folderId) {
  const drive = getDrive();
  const bucket = getBucket();
  folderId = folderId || ROOT_FOLDER_ID;

  const { files, ignored } = await collectFiles(drive, folderId);
  const currentPaths = new Set();
  const synced = [];

  for (const file of files) {
    currentPaths.add(file.gcsPath);
    const cached = fileCache.get(file.gcsPath);
    if (cached && cached.modifiedTime === file.modifiedTime) continue;

    console.log(`Syncing ${file.gcsPath}`);
    try {
      await uploadFile(drive, bucket, file.id, file.name, file.mimeType, file.gcsPath);
      fileCache.set(file.gcsPath, { fileId: file.id, modifiedTime: file.modifiedTime });
      synced.push(file.gcsPath);
    } catch (err) {
      console.error(`Error syncing ${file.gcsPath}:`, err.message);
    }
  }

  // Delete files that disappeared from Drive
  const deleted = [];
  for (const [gcsPath] of fileCache) {
    if (!currentPaths.has(gcsPath)) {
      console.log(`Deleting orphaned: ${gcsPath}`);
      try {
        await bucket.file(gcsPath).delete();
        deleted.push(gcsPath);
      } catch (err) { /* ignore delete failures */ }
      fileCache.delete(gcsPath);
    }
  }

  // Ensure all current files are in cache
  for (const file of files) {
    if (!fileCache.has(file.gcsPath)) {
      fileCache.set(file.gcsPath, { fileId: file.id, modifiedTime: file.modifiedTime });
    }
  }

  return { synced, deleted, ignored, unchanged: files.length - synced.length, totalTracked: fileCache.size };
}

// ── FULL SYNC ───────────────────────────────────────────────────────────────
// Downloads everything. Reconciles GCS deletions. Used on startup and every
// 5 minutes for drift correction.

async function fullSync(folderId) {
  const drive = getDrive();
  const bucket = getBucket();
  folderId = folderId || ROOT_FOLDER_ID;

  const { files, ignored } = await collectFiles(drive, folderId);
  fileCache.clear();
  const synced = [];

  for (const file of files) {
    console.log(`Syncing ${file.gcsPath}`);
    try {
      await uploadFile(drive, bucket, file.id, file.name, file.mimeType, file.gcsPath);
      fileCache.set(file.gcsPath, { fileId: file.id, modifiedTime: file.modifiedTime });
      synced.push(file.gcsPath);
    } catch (err) {
      console.error(`Error syncing ${file.gcsPath}:`, err.message);
    }
  }

  // Reconcile: delete GCS files not in Drive
  console.log('Reconciling deleted files in GCS...');
  const [allGcsFiles] = await bucket.getFiles();
  const syncedSet = new Set(synced);
  const deleted = [];
  for (const gcsFile of allGcsFiles) {
    if (!syncedSet.has(gcsFile.name)) {
      console.log(`Deleting orphaned: ${gcsFile.name}`);
      try {
        await gcsFile.delete();
        deleted.push(gcsFile.name);
      } catch (err) { /* ignore */ }
    }
  }

  console.log(`Sync-all completed for folderId: ${folderId}`);
  return { syncedFiles: synced, ignoredFiles: ignored, deletedFiles: deleted, bucket: BUCKET_NAME };
}

// ── Legacy Express handler (single-file sync) ──────────────────────────────

exports.syncService = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const fileId = req.body.fileId || req.query.fileId;
    if (!fileId) return res.status(400).send('Missing fileId');

    const drive = getDrive();
    const bucket = getBucket();
    const meta = await drive.files.get({ fileId, fields: 'name, mimeType' });
    const fileName = meta.data.name;

    await uploadFile(drive, bucket, fileId, fileName, meta.data.mimeType, fileName);
    res.status(200).json({ message: 'Sync successful', file: fileName, bucket: BUCKET_NAME });
  } catch (error) {
    console.error('Error in syncService:', error);
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
};

// ── Exports ─────────────────────────────────────────────────────────────────

exports.smartSync = smartSync;
exports.fullSync = fullSync;
exports.getDrive = getDrive;
exports.getFileCache = getFileCache;
exports.ROOT_FOLDER_ID = ROOT_FOLDER_ID;
exports.BUCKET_NAME = BUCKET_NAME;
