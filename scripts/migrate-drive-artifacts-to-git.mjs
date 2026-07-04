#!/usr/bin/env node
// scripts/migrate-drive-artifacts-to-git.mjs — One-shot migration helper
// Ensures every project has a git artifact repo. If the repo is empty AND the
// project has Drive artifacts, downloads them for manual initial commit.
//
// Usage: node scripts/migrate-drive-artifacts-to-git.mjs [--dry-run]

import { ensureRepo, readRef, sanitizeRepoId } from '../corekit/lib/git-store.mjs';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const gcpProject = process.env.GCP_PROJECT_ID;
  if (!gcpProject) {
    console.error('ERROR: GCP_PROJECT_ID must be set');
    process.exit(1);
  }
  console.log(`Migration mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  // Fetch all projects from Firestore
  const token = (await import('../corekit/lib/gce-auth.mjs')).getGceToken();
  // ... (use fetch to list projects from Firestore)

  const base = `https://firestore.googleapis.com/v1/projects/${gcpProject}/databases/(default)/documents`;
  const resp = await fetch(`${base}/projects`, {
    headers: { 'Authorization': `Bearer ${await token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    console.error(`Failed to list projects: ${resp.status}`);
    process.exit(1);
  }
  const data = await resp.json();
  const projects = data.documents || [];

  let ensured = 0, skipped = 0, needsMigration = 0;
  for (const doc of projects) {
    const projectId = doc.name.split('/').pop();
    const repoId = sanitizeRepoId(projectId);
    const mergePolicy = doc.fields?.merge_policy?.stringValue || 'auto';
    const hasDriveArtifacts = doc.fields?.context?.mapValue?.fields?.drive_folder?.mapValue?.fields?.ref?.stringValue;

    console.log(`\n--- Project: ${projectId} (repo: ${repoId}) ---`);

    if (dryRun) {
      console.log(`  [DRY RUN] Would ensureRepo(${repoId}, { mergePolicy: '${mergePolicy}' })`);
    } else {
      try {
        await ensureRepo(repoId, { mergePolicy });
        ensured++;
      } catch (e) {
        console.error(`  ERROR ensureRepo: ${e.message}`);
        continue;
      }
    }

    // Check if repo already has a main ref
    try {
      const ref = await readRef(repoId, 'main');
      if (ref?.sha) {
        console.log(`  Already has main ref: ${ref.sha.slice(0, 12)} — skipping`);
        skipped++;
        continue;
      }
    } catch { /* no ref */ }

    if (hasDriveArtifacts) {
      console.log(`  ⚠ Has Drive artifacts but no git main — needs manual migration`);
      console.log(`    Drive folder: ${hasDriveArtifacts}`);
      needsMigration++;
    } else {
      console.log(`  Empty repo, no Drive artifacts — OK`);
    }
  }

  console.log(`\n=== Summary ===${dryRun ? ' (DRY RUN)' : ''} ===`);
  console.log(`  Repos ensured: ${ensured}`);
  console.log(`  Already populated (skipped): ${skipped}`);
  console.log(`  Needs manual migration: ${needsMigration}`);
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
