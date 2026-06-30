#!/usr/bin/env node
// migrate-to-project-rooted.mjs — Move work artifacts from primes/{primeId}/…
// to deployment-rooted top-level collections.
//
// Collections migrated:
//   primes/{primeId}/work/*        → work/*
//   primes/{primeId}/processes/*   → processes/*
//   primes/{primeId}/plans/*       → plans/*
//   primes/{primeId}/approvals/*   → approvals/*
//   primes/{primeId}/skill-proposals/* → skill-proposals/* (if exists)
//
// Usage:
//   node migrate-to-project-rooted.mjs                  # dry-run (default)
//   node migrate-to-project-rooted.mjs --apply           # copy to top-level
//   node migrate-to-project-rooted.mjs --cleanup         # delete old subcollections
//
// The script is idempotent — re-running --apply skips docs that already exist
// at the target. --cleanup only deletes docs that have a verified copy.

const DRY_RUN = !process.argv.includes('--apply') && !process.argv.includes('--cleanup');
const CLEANUP = process.argv.includes('--cleanup');
const MODE = CLEANUP ? 'CLEANUP' : DRY_RUN ? 'DRY-RUN' : 'APPLY';

// ── Config ────────────────────────────────────────────────
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!GCP_PROJECT_ID) {
  console.error('ERROR: GCP_PROJECT_ID env var required');
  process.exit(1);
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents`;

// Collections to migrate from primes/{primeId}/ to top-level
const COLLECTIONS_TO_MIGRATE = ['work', 'processes', 'plans', 'approvals', 'skill-proposals'];

// Fields to stamp on migrated work documents
const STAMP_FIELDS = ['owner', 'prime_id'];

// ── Auth ──────────────────────────────────────────────────
async function getToken() {
  try {
    // Try GCE metadata first
    const resp = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (resp.ok) {
      const { access_token } = await resp.json();
      return access_token;
    }
  } catch {}

  // Fall back to gcloud CLI
  const { execSync } = await import('child_process');
  return execSync('gcloud auth print-access-token --quiet', { encoding: 'utf8' }).trim();
}

// ── Firestore helpers ─────────────────────────────────────
async function listDocuments(path, token, pageToken = '') {
  const url = `${FIRESTORE_BASE}/${path}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    if (resp.status === 404) return { documents: [], nextPageToken: '' };
    const text = await resp.text();
    throw new Error(`List ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function readDocument(path, token) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function writeDocument(path, fields, token) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Write ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function deleteDocument(path, token) {
  const url = `${FIRESTORE_BASE}/${path}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(`Delete ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
}

// ── List all primes ───────────────────────────────────────
async function listPrimes(token) {
  const primeIds = [];
  let pageToken = '';
  do {
    const data = await listDocuments('primes', token, pageToken);
    for (const doc of (data.documents || [])) {
      // Extract prime ID from full path
      const parts = doc.name.split('/');
      primeIds.push(parts[parts.length - 1]);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return primeIds;
}

// ── Paginate all docs in a subcollection ──────────────────
async function getAllDocs(collectionPath, token) {
  const docs = [];
  let pageToken = '';
  do {
    const data = await listDocuments(collectionPath, token, pageToken);
    for (const doc of (data.documents || [])) {
      docs.push(doc);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

// ── Extract doc ID from full Firestore path ───────────────
function docId(fullPath) {
  const parts = fullPath.split('/');
  return parts[parts.length - 1];
}

// ── Extract field value from Firestore REST format ────────
function fieldValue(fields, key) {
  if (!fields || !fields[key]) return null;
  const f = fields[key];
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? f.doubleValue ?? null;
}

// ── Main migration logic ─────────────────────────────────
async function migrate() {
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Firestore Re-root Migration — MODE: ${MODE}`);
  console.log(`  Project: ${GCP_PROJECT_ID}`);
  console.log(`══════════════════════════════════════════════════\n`);

  const token = await getToken();
  const primes = await listPrimes(token);
  console.log(`Found ${primes.length} primes: ${primes.join(', ')}\n`);

  const stats = {
    scanned: 0,
    copied: 0,
    skipped: 0,  // already exists at target
    deleted: 0,
    errors: 0,
  };

  for (const primeId of primes) {
    console.log(`\n── Prime: ${primeId} ──────────────────────────`);

    for (const collection of COLLECTIONS_TO_MIGRATE) {
      const sourcePath = `primes/${primeId}/${collection}`;
      const docs = await getAllDocs(sourcePath, token);

      if (docs.length === 0) {
        console.log(`  ${collection}: (empty)`);
        continue;
      }

      console.log(`  ${collection}: ${docs.length} documents`);

      for (const doc of docs) {
        stats.scanned++;
        const id = docId(doc.name);
        const targetPath = `${collection}/${id}`;

        if (CLEANUP) {
          // Verify the copy exists before deleting
          const existing = await readDocument(targetPath, token);
          if (!existing) {
            console.log(`    ⚠ SKIP DELETE ${id} — no copy at ${targetPath}`);
            stats.errors++;
            continue;
          }
          console.log(`    🗑 DELETE ${sourcePath}/${id}`);
          await deleteDocument(`${sourcePath}/${id}`, token);
          stats.deleted++;
          continue;
        }

        // Check if target already exists
        const existing = await readDocument(targetPath, token);
        if (existing) {
          stats.skipped++;
          continue;
        }

        // Prepare fields — stamp owner and prime_id if missing (for work)
        const fields = { ...doc.fields };
        if (collection === 'work') {
          if (!fields.prime_id) {
            fields.prime_id = { stringValue: primeId };
          }
          // owner should already be set by the brain; if not, try to infer
          if (!fields.owner && fields.source_meta?.mapValue?.fields?.delegated_to?.stringValue) {
            fields.owner = { stringValue: fields.source_meta.mapValue.fields.delegated_to.stringValue };
          }
        }

        if (DRY_RUN) {
          const ownerVal = fieldValue(fields, 'owner');
          console.log(`    📋 WOULD COPY ${id} → ${targetPath}${ownerVal ? ` (owner: ${ownerVal})` : ''}`);
          stats.copied++;
        } else {
          try {
            await writeDocument(targetPath, fields, token);
            stats.copied++;
            if (stats.copied % 50 === 0) {
              console.log(`    ... copied ${stats.copied} so far`);
            }
          } catch (err) {
            console.error(`    ✗ ERROR copying ${id}: ${err.message}`);
            stats.errors++;
          }
        }
      }
    }
  }

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Migration ${MODE} complete`);
  console.log(`  Scanned:  ${stats.scanned}`);
  console.log(`  Copied:   ${stats.copied}`);
  console.log(`  Skipped:  ${stats.skipped} (already at target)`);
  console.log(`  Deleted:  ${stats.deleted}`);
  console.log(`  Errors:   ${stats.errors}`);
  console.log(`══════════════════════════════════════════════════\n`);

  if (stats.errors > 0) {
    process.exit(1);
  }
}

migrate().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
