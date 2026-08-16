// corekit/system/resolve-imports.mjs — does the installed tree actually link? (repo-only tooling)
//
// The repo tree and the installed tree are not the same shape. `agent-brain.mjs`
// lives at `corekit/daemon/` in the repo and at `bin/` on a VM, and its imports
// are written for the VM: `../corekit/lib/gce-auth.mjs`. From the repo that
// resolves to `corekit/corekit/lib/`, which has never existed. The daemons are
// therefore unloadable from a checkout, and CI's syntax check cannot see it —
// parsing a file does not resolve its imports.
//
// So a broken import is currently found by a VM failing to start. This resolves
// the graph the way node will: build the dest tree from the manifests, walk
// every installed module, and follow each relative specifier from its dest.
//
// It also models the two things install.sh does to make that tree work — the
// `lib -> corekit/lib` bridge symlink, and directory-index resolution — because
// a checker that ignores them would report failures node does not have.
//
// Not manifested: this inspects the repo, so it never ships to a VM.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest, fragmentsFor, ROLE_FRAGMENTS } from './install-surface.mjs';

/**
 * Symlinks install.sh creates after copying files.
 *
 * bin/ daemon code is flattened, but some modules import `../../lib/x.mjs`
 * while the modules install to `corekit/lib/`. install.sh bridges the two with
 * a symlink. Older agents carried it from an earlier install and kept it across
 * upgrades, so only FRESH deploys regressed when it went missing — the failure
 * mode this whole file exists to make visible.
 */
export const LAYOUT_LINKS = Object.freeze({ lib: 'corekit/lib' });

/** Every relative import/export specifier in a module, with its line number. */
export function relativeSpecifiers(source) {
  const out = [];
  const lines = String(source).split('\n');
  const pattern = /(?:^|[\s;])(?:import|export)\b[^'"\n]*?from\s*['"](\.[^'"]*)['"]|import\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      out.push({ spec: m[1] || m[2], line: i + 1 });
    }
  });
  return out;
}

/** Collapse `a/b/../c` to `a/c` without touching the filesystem. */
export function normalize(path) {
  const parts = [];
  for (const seg of String(path).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/** Rewrite a dest path through the layout symlinks, longest prefix first. */
export function followLinks(path, links = LAYOUT_LINKS) {
  for (const [link, target] of Object.entries(links).sort((a, b) => b[0].length - a[0].length)) {
    if (path === link) return target;
    if (path.startsWith(`${link}/`)) return `${target}/${path.slice(link.length + 1)}`;
  }
  return path;
}

/**
 * Resolve one specifier from an importing dest path against a set of dests.
 *
 * Mirrors node's ESM resolution for the cases this tree uses: an exact file, or
 * a directory containing index.mjs. Extensionless bare paths are NOT resolved,
 * because node does not resolve them for ESM either.
 */
export function resolveFrom(importerDest, spec, destSet, links = LAYOUT_LINKS) {
  const base = importerDest.split('/').slice(0, -1).join('/');
  const target = normalize(`${base}/${spec}`);
  for (const candidate of [target, `${target}/index.mjs`]) {
    if (destSet.has(candidate)) return candidate;
    const linked = followLinks(candidate, links);
    if (destSet.has(linked)) return linked;
  }
  return null;
}

/** dest -> repo src for one role bundle, as install.sh would lay it down. */
export function bundleTree(repoRoot, role, jobs = []) {
  const hasFile = (rel) => existsSync(join(repoRoot, rel));
  const tree = new Map();
  for (const fragment of fragmentsFor(role, jobs, { hasFile })) {
    const full = join(repoRoot, fragment);
    if (!existsSync(full)) continue;
    for (const { src, dest } of parseManifest(readFileSync(full, 'utf8'))) {
      tree.set(dest.replace(/\?$/, ''), src);
    }
  }
  return tree;
}

/**
 * Every unresolvable import in an installed bundle.
 *
 * Returns `{ dest, src, spec, line }` per broken edge — the installed path, the
 * repo file to fix, and where in it.
 */
export function brokenImports(repoRoot, tree) {
  const destSet = new Set(tree.keys());
  const broken = [];
  for (const [dest, src] of tree) {
    if (!dest.endsWith('.mjs')) continue;
    const full = join(repoRoot, src);
    if (!existsSync(full)) continue;
    for (const { spec, line } of relativeSpecifiers(readFileSync(full, 'utf8'))) {
      if (!resolveFrom(dest, spec, destSet)) broken.push({ dest, src, spec, line });
    }
  }
  return broken;
}

/** The same question asked of the repo tree: can a checkout load this module? */
export function brokenInRepo(repoRoot, srcPaths) {
  const broken = [];
  for (const src of srcPaths) {
    const full = join(repoRoot, src);
    if (!src.endsWith('.mjs') || !existsSync(full)) continue;
    for (const { spec, line } of relativeSpecifiers(readFileSync(full, 'utf8'))) {
      const target = normalize(`${src.split('/').slice(0, -1).join('/')}/${spec}`);
      const hit = [target, `${target}/index.mjs`].some((c) => existsSync(join(repoRoot, c)));
      if (!hit) broken.push({ src, spec, line });
    }
  }
  return broken;
}

// CLI: report both trees.
if (process.argv[1]?.endsWith('resolve-imports.mjs')) {
  const repoRoot = process.argv[2] || process.cwd();
  let bad = 0;
  for (const role of Object.keys(ROLE_FRAGMENTS)) {
    const tree = bundleTree(repoRoot, role);
    const broken = brokenImports(repoRoot, tree);
    console.log(`${role}: ${tree.size} installed files, ${broken.length} unresolvable import(s)`);
    for (const b of broken) console.log(`  ${b.src}:${b.line}  ${b.spec}   (installed at ${b.dest})`);
    bad += broken.length;
  }
  process.exit(bad ? 1 : 0);
}
