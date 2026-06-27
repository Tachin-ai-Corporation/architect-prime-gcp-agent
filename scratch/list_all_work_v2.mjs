import { readFileSync } from 'fs';
import { getGceToken } from '/opt/corekit/corekit/lib/gce-auth.mjs';

const GCP_PROJECT = 'architect-prime-beta';
const PRIME_ID = 'candicejr';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;

async function main() {
  const token = await getGceToken();
  const url = `${FIRESTORE_URL}/primes/${PRIME_ID}/work?pageSize=300`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error('HTTP Error:', res.status, await res.text());
    return;
  }
  const data = await res.json();
  const docs = data.documents || [];
  
  console.log(`Found ${docs.length} total work documents:`);
  
  // Sort docs by name to keep them in order
  docs.sort((a, b) => a.name.localeCompare(b.name));
  
  for (const doc of docs) {
    const name = doc.name.split('/').pop();
    const f = doc.fields || {};
    const type = f.type?.stringValue || '?';
    const status = f.status?.stringValue || '?';
    const owner = f.owner?.stringValue || '?';
    const title = f.title?.stringValue || '';
    console.log(`  ${name}: type=${type} status=${status} owner=${owner} title="${title}"`);
  }
}
main().catch(console.error);
