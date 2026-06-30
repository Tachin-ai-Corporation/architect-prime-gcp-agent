#!/usr/bin/env node
// backfill-prime-id.mjs — Add prime_id field to existing top-level documents
// that were migrated without it. Reads from primes/*/subcollections to determine
// which prime_id each doc belongs to, then patches the top-level doc.
//
// Usage:
//   GCP_PROJECT_ID=architect-prime-beta node scripts/backfill-prime-id.mjs           # dry-run
//   GCP_PROJECT_ID=architect-prime-beta node scripts/backfill-prime-id.mjs --apply   # apply

const DRY_RUN = !process.argv.includes('--apply');
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!GCP_PROJECT_ID) { console.error('GCP_PROJECT_ID required'); process.exit(1); }

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)/documents`;
const COLLECTIONS = ['work', 'processes', 'plans', 'approvals', 'skill-proposals'];

async function getToken() {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (r.ok) return (await r.json()).access_token;
  } catch {}
  const { execSync } = await import('child_process');
  return execSync('gcloud auth print-access-token --quiet', { encoding: 'utf8' }).trim();
}

async function listDocs(path, token, pageToken = '') {
  const url = `${FIRESTORE_BASE}/${path}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) { if (r.status === 404) return { documents: [] }; throw new Error(`List ${path}: ${r.status}`); }
  return r.json();
}

async function getAllDocs(path, token) {
  const docs = []; let pt = '';
  do { const d = await listDocs(path, token, pt); docs.push(...(d.documents || [])); pt = d.nextPageToken || ''; } while (pt);
  return docs;
}

async function patchField(docPath, fieldName, value, token) {
  const url = `${FIRESTORE_BASE}/${docPath}?updateMask.fieldPaths=${fieldName}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [fieldName]: { stringValue: value } } }),
  });
  if (!r.ok) throw new Error(`Patch ${docPath}: ${r.status}`);
}

function docId(fullPath) { return fullPath.split('/').pop(); }

async function main() {
  console.log(`\nBackfill prime_id — ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}\n`);
  const token = await getToken();

  // Step 1: Build a map of docId → primeId from old subcollections
  const primeDocs = await getAllDocs('primes', token);
  const primeIds = primeDocs.map(d => docId(d.name));
  console.log(`Found ${primeIds.length} primes: ${primeIds.join(', ')}\n`);

  const ownership = {}; // docId → primeId
  for (const pid of primeIds) {
    for (const col of COLLECTIONS) {
      const docs = await getAllDocs(`primes/${pid}/${col}`, token);
      for (const doc of docs) {
        ownership[docId(doc.name)] = pid;
      }
    }
  }
  console.log(`Built ownership map: ${Object.keys(ownership).length} docs\n`);

  // Step 2: Scan top-level collections, patch docs missing prime_id
  let patched = 0, skipped = 0, errors = 0;
  for (const col of COLLECTIONS) {
    const docs = await getAllDocs(col, token);
    const missing = docs.filter(d => !d.fields?.prime_id);
    if (missing.length === 0) { console.log(`  ${col}: all ${docs.length} docs have prime_id`); continue; }
    console.log(`  ${col}: ${missing.length}/${docs.length} docs need prime_id`);

    for (const doc of missing) {
      const id = docId(doc.name);
      const pid = ownership[id];
      if (!pid) { console.log(`    ⚠ ${id}: no ownership found, skipping`); errors++; continue; }

      if (DRY_RUN) {
        console.log(`    📋 WOULD PATCH ${col}/${id} → prime_id=${pid}`);
        patched++;
      } else {
        try {
          await patchField(`${col}/${id}`, 'prime_id', pid, token);
          patched++;
          if (patched % 50 === 0) console.log(`    ... patched ${patched}`);
        } catch (e) { console.error(`    ✗ ${id}: ${e.message}`); errors++; }
      }
    }
  }

  console.log(`\nDone: patched=${patched}, skipped=${skipped}, errors=${errors}\n`);
  if (errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
