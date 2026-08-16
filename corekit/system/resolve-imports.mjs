// corekit/system/resolve-imports.mjs — does the installed tree actually link? (repo-only tooling)
//
// The repo tree and the installed tree are not the same shape. `agent-brain.mjs`
// lives at `corekit/daemon/` in the repo and at `bin/` on a VM, and its imports
// are written for the VM: `../platform/security/gce-auth.mjs`. From the repo
// that resolves to `corekit/platform/…`, which does not exist. The daemons are
// therefore unloadable from a checkout, and CI's syntax check cannot see it —
// parsing a file does not resolve its imports.
//
// So a broken import is currently found by a VM failing to start. This resolves
// the graph the way node will: build the dest tree from the manifests, walk
// every installed module, and follow each relative specifier from its dest.
//
// It models directory-index resolution, and symlinks, because a checker blind
// to what install.sh does would report failures node does not have. The symlink
// table is empty now — see LAYOUT_LINKS for why that is the interesting part.
//
// Not manifested: this inspects the repo, so it never ships to a VM.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest, fragmentsFor, ROLE_FRAGMENTS } from './install-surface.mjs';

/**
 * Symlinks install.sh creates after copying files. There are none.
 *
 * There used to be one: `lib -> corekit/lib`, bridging bin/ code that imported
 * `../../lib/x.mjs` to modules installed at `corekit/lib/`. Agents carried it
 * forward across upgrades, so only FRESH deploys regressed when it was missing
 * — exactly the failure mode this file exists to make visible.
 *
 * Every module now installs under `platform/` at the path it occupies in the
 * repo, and importers name that path. The mechanism is kept because resolution
 * through a link is a real thing to model, and an empty table is a claim worth
 * being able to break.
 */
export const LAYOUT_LINKS = Object.freeze({});

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
    const full = join(repoRoot, src);
    if (!existsSync(full)) continue;
    let source;
    try { source = readFileSync(full, 'utf8'); } catch { continue; }
    // Extension is not what makes a file a module. `corekit/system/fleet-config`
    // is an ES module with a shebang and no suffix; filtering on `.mjs` skipped
    // it, and the platform/ move broke exactly those two files while this
    // checker reported a clean tree.
    if (!isModule(dest, source)) continue;
    for (const { spec, line } of relativeSpecifiers(source)) {
      if (!resolveFrom(dest, spec, destSet)) broken.push({ dest, src, spec, line });
    }
  }
  return broken;
}

/** True when a file is JS that node will resolve imports for. */
export function isModule(path, source) {
  if (/\.(mjs|js|ts)$/.test(path)) return true;
  if (/\.(sh|md|json|txt|service|timer|tmpl|png|ico|css)$/.test(path)) return false;
  // No suffix: a node shebang, or an import/export at the start of a line.
  return /^#!.*\bnode\b/.test(source) || /(?:^|\n)\s*(?:import|export)\s/.test(source);
}

/** The same question asked of the repo tree: can a checkout load this module? */
export function brokenInRepo(repoRoot, srcPaths) {
  const broken = [];
  for (const src of srcPaths) {
    const full = join(repoRoot, src);
    if (!existsSync(full)) continue;
    let source;
    try { source = readFileSync(full, 'utf8'); } catch { continue; }
    if (!isModule(src, source)) continue;
    for (const { spec, line } of relativeSpecifiers(source)) {
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
