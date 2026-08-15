#!/usr/bin/env node
// migrate-to-project-rooted.mjs — Move work artifacts from primes/{primeId}/…
// to deployment-rooted top-level collections.
//
// Collections migrated:
//   primes/{primeId}/work/*        → work/*
//   primes/{primeId}/processes/*   → processes/*
//   primes/{primeId}/approvals/*   → approvals/*
//   primes/{primeId}/skill-proposals/* → skill-proposals/* (if exists)
//
// Usage:
//   node migrate-to-project-rooted.mjs                  # dry-run (default)
//   node migrate-to-project-rooted.mjs --apply           # copy to top-level
//   node migrate-to-project-rooted.mjs --cleanup         # delete old subcollections
//
// The script is idempotent — re-running --apply skips docs that already exist
// at the target. --cleanup deletes a source document ONLY when the target holds
// a content-identical copy (sha256 over the canonicalized field map, excluding
// the fields this migration adds). An ID collision alone is never sufficient
// evidence — see cleanupDecision().

import { createHash } from 'node:crypto';

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
// `plans` was dropped with the Plan primitive (C-14, v2026.08.15) — it was never
// written, so there is nothing to migrate.
const COLLECTIONS_TO_MIGRATE = ['work', 'processes', 'approvals', 'skill-proposals'];

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

// ── Content fingerprinting for safe deletion ──────────────
//
// `--cleanup` used to delete a source document as soon as *something* existed at
// the destination ID. An ID collision is not proof of a copy: a partial write, a
// pre-existing unrelated record, or an interrupted earlier run all present as
// "the target exists", and the source was destroyed on that evidence alone.
//
// Deletion now requires the two documents to carry the same content. The
// comparison excludes exactly the fields this migration is designed to add
// (`prime_id`, and `owner` when it was derived during the copy), so a correctly
// migrated pair still matches.

/** Fields the migration stamps on the target; excluded from the comparison. */
const MIGRATION_ADDED_FIELDS = new Set(['prime_id', 'owner']);

/** Canonical JSON: key order must not change a fingerprint. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonicalize(value[k]);
        return acc;
      }, {});
  }
  return value;
}

export function fingerprintFields(fields) {
  const comparable = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (MIGRATION_ADDED_FIELDS.has(k)) continue;
    comparable[k] = v;
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(comparable))).digest('hex');
}

/**
 * Decide whether a source document may be deleted.
 *
 * @returns {{ safe: boolean, reason: string }}
 */
export function cleanupDecision(sourceFields, targetFields) {
  if (!targetFields) return { safe: false, reason: 'no copy at the target path' };

  const src = fingerprintFields(sourceFields);
  const dst = fingerprintFields(targetFields);
  if (src !== dst) {
    return {
      safe: false,
      reason: `content differs (source ${src.slice(0, 12)} vs target ${dst.slice(0, 12)}) — ` +
        `the target is a different record, not a copy`,
    };
  }
  return { safe: true, reason: `content verified (${src.slice(0, 12)})` };
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
    skipped: 0,      // already exists at target
    collisions: 0,   // cleanup refused: target absent or content differs
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
          // Identity AND content must match before anything is destroyed.
          const existing = await readDocument(targetPath, token);
          const decision = cleanupDecision(doc.fields, existing?.fields);
          if (!decision.safe) {
            console.log(`    ⚠ SKIP DELETE ${id} — ${decision.reason}`);
            stats.collisions++;
            continue;
          }
          console.log(`    🗑 DELETE ${sourcePath}/${id} — ${decision.reason}`);
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

        // Prepare fields — stamp prime_id on all collections for dashboard filtering
        const fields = { ...doc.fields };
        if (!fields.prime_id) {
          fields.prime_id = { stringValue: primeId };
        }
        // owner is work-specific: stamp if missing
        if (collection === 'work') {
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
  if (CLEANUP) console.log(`  Refused:  ${stats.collisions} (unverified — source preserved)`);
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
