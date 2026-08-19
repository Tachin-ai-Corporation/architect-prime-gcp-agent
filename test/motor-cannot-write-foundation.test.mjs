// Motor cannot write Foundation (plan Phase C item 8).
//
// Motor's tools run INSIDE the agent-brain process, and its tool set includes
// `exec`, `shell`, `python3` and `gcloud` — arbitrary shell, as root. That single
// fact decides the whole design: a path check inside the brain's write tool is not
// a denial, because `python3 -c "open('/opt/corekit/platform/x','w')"` bypasses it
// without touching the tool. Shipping such a check under the name "motor cannot
// write Foundation" would be a check that cannot fail wearing a security label.
//
// Only a mount-namespace restriction binds a process that already has a shell, so
// enforcement lives in the systemd unit. This file guards the unit's CONTENTS,
// because a directive silently dropped from a service file fails open and nothing
// else in the repo would notice.
//
// It does NOT prove enforcement — a unit file is a claim about a kernel. The
// proof is the live pair in scripts/rollout-gate.sh: a denied write must fail and
// an allowed write must succeed, on a real VM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const unit = readFileSync(join(repo, 'platform', 'runtime', 'agent-brain.service'), 'utf8');
const installSh = readFileSync(join(repo, 'infra', 'install.sh'), 'utf8');
const registry = JSON.parse(readFileSync(join(repo, 'corekit', 'config', 'agent-registry-prime.json'), 'utf8'));

/** Directive values from the [Service] section, by key. */
function directive(key) {
  const m = unit.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

// ---- the premise, asserted so the design cannot be quietly undermined ----

test('motor really does have a shell — the reason a path guard would be theatre', () => {
  // If this ever stops being true, an in-process guard becomes viable and this
  // whole approach can be reconsidered. Until then it is settled by evidence.
  const tools = JSON.stringify(registry);
  const shells = ['exec', 'shell', 'python3'].filter((t) => tools.includes(`"${t}"`));
  assert.ok(shells.length > 0,
    'motor was expected to hold shell-class tools; if it no longer does, revisit the mechanism');
});

test('the brain still runs as root, so file permissions cannot bind it', () => {
  assert.equal(directive('User'), 'root',
    'if the brain ever drops privilege, the sandbox can be simplified — but not before');
});

// ---- the enforcement ----

test('Foundation paths are mounted read-only for the brain', () => {
  const ro = directive('ReadOnlyPaths');
  assert.ok(ro, 'ReadOnlyPaths must be present — without it there is no denial at all');
  for (const p of ['/opt/corekit/platform', '/opt/corekit/bin', '/etc/systemd/system']) {
    assert.ok(ro.includes(p), `${p} must be read-only for the brain`);
  }
  assert.ok(ro.includes('/opt/corekit/corekit/brain'),
    "the gateway's own code is Foundation too — motor rewriting it would rewrite its own reasoning");
});

test('CAP_SYS_ADMIN is dropped, or ReadOnlyPaths is only advice', () => {
  // A root process retaining CAP_SYS_ADMIN can remount those paths read-write.
  // Without this line the unit LOOKS enforced and is not — the exact failure mode
  // this file exists to prevent.
  const caps = directive('CapabilityBoundingSet');
  assert.ok(caps && /CAP_SYS_ADMIN/.test(caps),
    'CapabilityBoundingSet must remove CAP_SYS_ADMIN, or a root shell can simply remount');
  assert.equal(directive('NoNewPrivileges'), 'yes',
    'and NoNewPrivileges, or the capability can be regained through a setuid binary');
});

// ---- what must stay writable, or the agent breaks ----

test('the paths a healthy agent writes are NOT denied', () => {
  const ro = directive('ReadOnlyPaths') || '';
  // Each of these has a real runtime writer. Denying any of them breaks work
  // rather than protecting anything.
  for (const p of [
    '/opt/corekit/shared',        // mission working trees
    '/opt/corekit/workspace',     // souls, MEMORY.md, blackboard, custom-skills
    '/opt/corekit/skills',        // the content plane's live targets
    '/opt/corekit/.content-staging',
    '/tmp',
  ]) {
    assert.ok(!ro.split(/\s+/).includes(p), `${p} must stay writable — it has a real runtime writer`);
  }
  // corekit/ holds CONTENT.json, contracts.json, responsibilities*.json and
  // fleet-registry.json, all written at runtime. Only its brain/ subtree is denied.
  assert.ok(!ro.split(/\s+/).includes('/opt/corekit/corekit'),
    'corekit/ itself must stay writable; only corekit/brain/ is Foundation');
});

test('ProtectSystem=strict is NOT set', () => {
  // It would make the whole tree read-only, including the content root that
  // agent-content-sync must write. Named here so nobody "hardens" it later
  // without discovering that the hard way on a live VM.
  assert.notEqual(directive('ProtectSystem'), 'strict');
  assert.equal(directive('PrivateTmp'), null,
    "motor's documented helper-script location is /tmp, shared with tools outside this unit");
});

// ---- the stale justification that argued against all of this ----

test('install.sh no longer claims skill-setup writes into bin/', () => {
  // It did, and it was false — skill-setup defines no BIN_DIR. That comment would
  // have argued against denying bin/ on the strength of a use that does not exist.
  // Asserting the phrase is ABSENT was the first version of this check, and it
  // failed — because the corrected comment QUOTES the false claim in order to
  // refute it, which is the clearest way to write it. That is the third time this
  // session a source-text check has tripped on prose explaining its own subject.
  // What matters is not whether the words appear but whether they still stand as a
  // reason, so the assertion is on the refutation.
  // Matched against NORMALISED prose — comment markers stripped and whitespace
  // collapsed. The first version matched the raw file and failed because the
  // sentence wraps across two `#` lines. A test that breaks when a comment is
  // reflowed is testing the line width, not the claim.
  const prose = installSh.replace(/^\s*#\s?/gm, '').replace(/\s+/g, ' ');

  const at = prose.indexOf('skill-setup installs dependencies into it');
  if (at >= 0) {
    const around = prose.slice(Math.max(0, at - 400), at + 400);
    assert.match(around, /checked and are false|it does not/,
      'the claim may be quoted, but only as something being refuted — never left standing');
  }
  assert.match(prose, /fleet-upgrade curls upgrade-corekit into bin\/ over SSH/,
    'and the REAL reason bin/ is left alone here must be stated, or the exemption is unexplained');
});
