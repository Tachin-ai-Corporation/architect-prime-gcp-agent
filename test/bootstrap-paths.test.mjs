// test/bootstrap-paths.test.mjs — the path an upgrade never exercises.
//
// A fresh deploy runs infra/bootstrap/*.sh; an upgrade does not. So a bootstrap
// script that reads a file the manifests stopped installing keeps working on
// every existing agent and fails only on the next hire — and by then the change
// that broke it is weeks back. That failure mode is on record here: hiring tom
// surfaced four regressions of exactly this shape, all invisible to upgrades.
//
// The scripts also fail quietly by design in places — `[[ -f "$SVC" ]] && cp`,
// `cp … 2>/dev/null || true` — which is correct for genuinely optional files and
// catastrophic for required ones. An agent whose four daemon units were silently
// skipped boots, reports healthy, and does nothing.
//
// So this checks every ${CORE_DIR} path a bootstrap reads against what the
// manifests actually install, and requires anything not installed to be
// explicitly declared as runtime-generated.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseManifest, fragmentsFor, platformJobs } from '../corekit/system/install-surface.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hasFile = (rel) => existsSync(join(repoRoot, rel));

/**
 * Paths a bootstrap reads that no manifest installs, each with the reason.
 *
 * Every entry is written at runtime by an earlier bootstrap step or by the
 * agent itself. Listing them is the point: an unlisted path that no manifest
 * installs is a file the script expects and nothing produces.
 */
const RUNTIME_GENERATED = Object.freeze({
  '.gateway-token': 'written by bootstrap before the gateway starts',
  '.identity-lock': 'written by bootstrap once identity is resolved',
  'corekit/chat-config.json': 'rendered from chat-config.json.tmpl during bootstrap',
  'corekit/prime-config.json': 'written by prime-bootstrap from instance metadata',
  'corekit/brain': 'the gateway module directory — its files are manifested individually',
  'corekit/': 'the install root itself',
  bin: 'the install root itself',
  shared: 'runtime scratch, created by bootstrap',
  workspace: 'organ workspace, seeded no-clobber',
  'workspace-': 'organ workspace prefix, built by string concatenation',
});

/** Every dest any bundle installs. */
function allDests() {
  const dests = new Set();
  const bundles = [['prime', []], ['fleet', []], ...platformJobs(repoRoot).map((j) => ['fleet', [j]])];
  for (const [role, jobs] of bundles) {
    for (const frag of fragmentsFor(role, jobs, { hasFile })) {
      const full = join(repoRoot, frag);
      if (!existsSync(full)) continue;
      for (const { dest } of parseManifest(readFileSync(full, 'utf8'))) {
        dests.add(dest.replace(/\?$/, ''));
      }
    }
  }
  return dests;
}

/** Every `${CORE_DIR}/…` path referenced by the bootstrap scripts. */
function bootstrapPaths() {
  const dir = join(repoRoot, 'infra', 'bootstrap');
  const found = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sh'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/\$\{CORE_DIR\}\/([A-Za-z0-9_./-]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

describe('bootstrap paths — the fresh-deploy path', () => {
  const dests = allDests();
  const refs = bootstrapPaths();

  it('finds the bootstrap scripts and a real dest set', () => {
    assert.ok(refs.size > 10, `only ${refs.size} CORE_DIR references found — the scan is broken`);
    assert.ok(dests.size > 200, `only ${dests.size} manifest dests found — the scan is broken`);
  });

  it('every path a bootstrap reads is installed or declared runtime-generated', () => {
    const orphans = [];
    for (const [path, file] of refs) {
      if (dests.has(path)) continue;
      if (RUNTIME_GENERATED[path]) continue;
      // A directory reference is fine when the manifests install into it.
      if ([...dests].some((d) => d.startsWith(`${path}/`))) continue;
      orphans.push(`${path}  (read by ${file})`);
    }
    assert.deepEqual(
      orphans, [],
      'these are read on a fresh deploy and installed by nothing. An upgrade will never ' +
      'notice, because an upgrade does not run bootstrap:\n' + orphans.join('\n'),
    );
  });

  it('the runtime-generated list has no entries that are now manifested', () => {
    // Kept honest in both directions. Claiming a file is generated at runtime
    // when a manifest installs it hides a real dependency behind a note, which
    // is how the list stops describing anything.
    const stale = Object.keys(RUNTIME_GENERATED).filter((p) => dests.has(p));
    assert.deepEqual(stale, [], `these are installed by a manifest now — drop them: ${stale.join(', ')}`);
  });

  it('the four daemon units a fresh agent needs are installed to where bootstrap looks', () => {
    // The copy loop is `[[ -f "$SVC_SRC" ]] && cp`. A missing unit is skipped in
    // silence, and the agent boots healthy with no brain.
    for (const svc of ['agent-ears', 'agent-mouth', 'agent-brain', 'agent-introspect']) {
      assert.ok(
        dests.has(`corekit/${svc}.service`),
        `bootstrap copies corekit/${svc}.service, but no manifest installs it there`,
      );
    }
  });

  it('the content-sync timer and its unit are both installed', () => {
    // The timer is what makes an agent reconcile at all; it is copied with
    // `2>/dev/null || true`, so a missing unit leaves the agent permanently
    // pinned to its manifest defaults with nothing logged.
    assert.ok(dests.has('corekit/agent-content-sync.timer'), 'the sync timer is not installed');
    assert.ok(dests.has('corekit/agent-content-sync.service'), 'the sync unit is not installed');
  });

  it('every bin/ tool a bootstrap invokes is installed to bin/', () => {
    const missing = [];
    for (const [path, file] of refs) {
      if (!path.startsWith('bin/') || path === 'bin') continue;
      if (!dests.has(path)) missing.push(`${path}  (invoked by ${file})`);
    }
    assert.deepEqual(missing, [], 'bootstrap invokes tools that are not installed:\n' + missing.join('\n'));
  });
});
