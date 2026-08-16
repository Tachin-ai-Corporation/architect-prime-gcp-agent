// corekit/system/install-surface.mjs — what a VM actually receives (repo-only tooling)
//
// A manifest line is `<repo src> <vm dest>`. Only the left side is a repo path.
// That asymmetry is the whole reason this file exists: the repo tree can be
// reorganised freely — folders renamed, files moved, packages split — and every
// deployed agent should receive byte-identical content, because the dest column
// never moved.
//
// "Should" is a claim. This turns it into an arithmetic one: resolve each role
// bundle exactly the way install.sh does, hash dest→content, and fold the whole
// bundle into a single tree digest. If a restructure changes a digest, it moved
// something a VM can see, and that is no longer a restructure.
//
// It also answers a question that predates the move. base.txt carries a comment
// about `secret-read` — two manifests once installed DIFFERENT scripts to the
// SAME dest, and whichever fragment concatenated last silently won, so primes
// and fleet agents resolved secrets differently from the same documented
// command. Concatenation order is not a place to express intent. A collision
// between different content is reported here as a conflict.
//
// Not manifested: this inspects the repo, so it never ships to a VM.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Roles install.sh accepts, and the role fragment each one adds after base. */
export const ROLE_FRAGMENTS = Object.freeze({
  prime: 'role-prime.txt',
  fleet: 'role-fleet.txt',
});

/**
 * Parse one manifest fragment into `{ src, dest, noClobber }` entries.
 *
 * Mirrors install.sh step 2: strip from `#` to end of line, trim, drop blanks.
 * A trailing `?` means no-clobber — install once, never overwrite, never prune.
 * It is part of the line's meaning, so it is parsed rather than ignored.
 */
export function parseManifest(text) {
  const entries = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    entries.push({
      src: parts[0],
      dest: parts[1],
      noClobber: parts[2] === '?' || parts[1].endsWith('?'),
    });
  }
  return entries;
}

/**
 * The ordered fragment list for a role + jobs, as install.sh assembles it.
 *
 * Job fragments resolve operator-first: an operator's own `job-<name>.txt`
 * shadows the platform one of the same name. Modelled here so the surface of a
 * deployment that overrides a job is describable, not just the default fleet.
 */
export function fragmentsFor(role, jobs, { hasFile }) {
  const list = ['infra/manifests/base.txt'];
  const fragment = ROLE_FRAGMENTS[role];
  if (!fragment) throw new Error(`unknown role: ${role}`);
  list.push(`infra/manifests/${fragment}`);
  if (role === 'fleet') {
    for (const job of jobs || []) {
      const operator = `operator/manifests/job-${job}.txt`;
      const platform = `infra/manifests/job-${job}.txt`;
      list.push(hasFile(operator) ? operator : platform);
    }
  }
  return list;
}

/**
 * Resolve a bundle to what lands on the VM.
 *
 * Returns `{ files, conflicts, missing }` where `files` is dest → sha256 of the
 * bytes at that dest. A later fragment overwriting an earlier one with the SAME
 * content is normal layering and is recorded once; overwriting with DIFFERENT
 * content is a conflict, because nothing about the manifest format expresses
 * which of the two was meant to win.
 */
export function resolveBundle(fragments, { readFile }) {
  const files = {};
  const sources = {};
  const conflicts = [];
  const missing = [];

  for (const fragment of fragments) {
    const text = readFile(fragment);
    if (text === null) {
      missing.push({ fragment });
      continue;
    }
    for (const { src, dest } of parseManifest(text)) {
      const clean = dest.replace(/\?$/, '');
      const body = readFile(src);
      if (body === null) {
        missing.push({ fragment, src, dest: clean });
        continue;
      }
      const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
      if (files[clean] && files[clean] !== digest) {
        conflicts.push({ dest: clean, from: sources[clean], to: src });
      }
      files[clean] = digest;
      sources[clean] = src;
    }
  }

  return { files, conflicts, missing };
}

/** One digest over the whole dest surface — path and content both. */
export function bundleDigest(files) {
  const entries = Object.keys(files).sort().map((dest) => [dest, files[dest]]);
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

/** Every job fragment the platform ships, derived from disk rather than listed. */
export function platformJobs(repoRoot) {
  return readdirSync(join(repoRoot, 'infra', 'manifests'))
    .filter((f) => f.startsWith('job-') && f.endsWith('.txt'))
    .map((f) => f.slice('job-'.length, -'.txt'.length))
    .sort();
}

/**
 * Every bundle a deployment can produce: prime, bare fleet, and fleet+job for
 * each job. Two agents of the same role and job receive the same files, so this
 * enumerates the distinct surfaces rather than the possible agents.
 */
export function allBundles(repoRoot) {
  const bundles = [
    { name: 'prime', role: 'prime', jobs: [] },
    { name: 'fleet', role: 'fleet', jobs: [] },
  ];
  for (const job of platformJobs(repoRoot)) {
    bundles.push({ name: `fleet+${job}`, role: 'fleet', jobs: [job] });
  }
  return bundles;
}

/** Read helper bound to a repo root; returns null for absent paths. */
export function repoReader(repoRoot) {
  return (rel) => {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) return null;
    return readFileSync(full);
  };
}

/**
 * The full install surface of a repo tree: every bundle, its digest, its file
 * count, and anything unresolved.
 */
export function installSurface(repoRoot) {
  const readFile = repoReader(repoRoot);
  const hasFile = (rel) => existsSync(join(repoRoot, rel));
  const out = {
    _generated: 'corekit/system/install-surface.mjs — do not edit; regenerate when the installed surface intentionally changes',
    bundles: {},
  };

  for (const { name, role, jobs } of allBundles(repoRoot)) {
    const fragments = fragmentsFor(role, jobs, { hasFile });
    const { files, conflicts, missing } = resolveBundle(fragments, { readFile });
    out.bundles[name] = {
      digest: bundleDigest(files),
      fileCount: Object.keys(files).length,
      conflicts,
      missing,
    };
  }
  return out;
}

// CLI: print the surface, or diff it against a committed lock.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
    process.argv[1]?.endsWith('install-surface.mjs')) {
  const repoRoot = process.argv[2] || process.cwd();
  const surface = installSurface(repoRoot);
  console.log(JSON.stringify(surface, null, 2));
}
