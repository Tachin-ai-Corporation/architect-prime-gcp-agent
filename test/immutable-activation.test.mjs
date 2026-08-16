// test/immutable-activation.test.mjs — C-35: only an immutable source is activatable
//
// Before v2026.08.15 every activation path could install a moving target:
//   - `install.sh`      defaulted CORE_REF to "main"
//   - `upgrade-corekit` warned "could not resolve SHA, using branch name" and continued
//   - `fleet-deploy`    defaulted coreRef to "main" three separate ways
//   - the control plane cloned `--branch main` and tagged the image `:latest`
//   - the Prime startup stub fell back to `|| echo main`
//   - contract validation was a warning on both install and upgrade, then
//     services restarted anyway
//
// Two VMs "on main" could hold different code while reporting the same ref, and
// a failed validation still went live. These assertions keep every channel
// resolved at its entry boundary and every gate fatal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const SHA_RE = String.raw`\^\[0-9a-f\]\{40\}\$`;

// ── install.sh is the structural gate ──────────────────────────────────

test('install.sh refuses any ref that is not a full commit SHA', () => {
  const src = read('infra/install.sh');

  assert.doesNotMatch(src, /CORE_REF="\$\{CORE_REF:-main\}"/, 'no branch default');
  assert.match(src, /CORE_REF="\$\{CORE_REF:-\}"/, 'CORE_REF must have no default');
  assert.match(
    src,
    new RegExp(String.raw`if \[\[ ! "\$CORE_REF" =~ ${SHA_RE} \]\]; then[\s\S]{0,400}?exit 1`),
    'a non-SHA CORE_REF must abort the install'
  );
  assert.match(src, /if \[\[ -z "\$CORE_REF" \]\]; then[\s\S]{0,300}?exit 1/, 'an empty CORE_REF must abort');
});

test('install.sh treats contract validation as fatal by default', () => {
  const src = read('infra/install.sh');

  assert.doesNotMatch(
    src,
    /warn "Contract validation found issues \(non-fatal/,
    'validation must not be advisory'
  );
  assert.match(src, /INSTALL_VALIDATE="\$\{INSTALL_VALIDATE:-fatal\}"/, 'default is fatal');
  assert.match(src, /die "Contract validation failed\./, 'a failed validation must abort');
  assert.match(
    src,
    /die "validate-contracts is not installed/,
    'a missing validator must abort — an unverifiable install is not a passing one'
  );
});

// ── Every channel boundary resolves before use ─────────────────────────

test('both bootstrap scripts resolve their channel to a commit or abort', () => {
  for (const rel of ['infra/bootstrap/fleet-bootstrap.sh', 'infra/bootstrap/prime-bootstrap.sh']) {
    const src = read(rel);
    assert.match(src, /resolve_core_ref\(\)/, `${rel} must resolve its ref`);
    assert.match(
      src,
      new RegExp(String.raw`if \[\[ ! "\$RESOLVED_REF" =~ ${SHA_RE} \]\]; then[\s\S]{0,400}?exit 1`),
      `${rel} must abort when the ref cannot be resolved`
    );
    // The resolver must run before CORE_BASE is built from it.
    const resolveAt = src.indexOf('RESOLVED_REF="$(resolve_core_ref');
    const baseAt = src.indexOf('CORE_BASE="https://raw.githubusercontent.com');
    assert.ok(resolveAt > -1 && baseAt > resolveAt, `${rel} must resolve before building CORE_BASE`);
  }
});

test('both bootstrap scripts gate on contract validation before reporting online', () => {
  // This test used to require the gate BEFORE any `systemctl start`, which is
  // what C-19 sounded like and what the scripts did. It was also unsatisfiable:
  // the runtime check asserts the four daemons are active, so a gate that runs
  // before they start can only fail. Every fresh deploy died there for a month
  // while this test stayed green — it was asserting the ordering that caused it.
  //
  // What C-19 actually protects is that a VM whose contracts do not hold must
  // not present itself as a working agent. So the gate runs after the services
  // start, stops them when it fails, and always precedes the online report.
  for (const rel of ['infra/bootstrap/fleet-bootstrap.sh', 'infra/bootstrap/prime-bootstrap.sh']) {
    const src = read(rel);
    assert.match(src, /INSTALL_VALIDATE="defer"/, `${rel} defers install-time validation`);

    const gateAt = src.indexOf('"$VALIDATE" --runtime');
    const installAt = src.indexOf('for svc in agent-ears agent-mouth agent-brain agent-introspect');
    assert.ok(gateAt > -1, `${rel} must have a runtime validation gate`);
    assert.ok(installAt > -1, `${rel} must install the daemon units`);
    assert.ok(
      gateAt > installAt,
      `${rel}: the gate asserts those daemons are active, so it must run after they are installed`
    );

    const afterGate = src.slice(gateAt, gateAt + 600);
    assert.match(
      afterGate, /systemctl stop/,
      `${rel} must stop the services it started when validation fails`
    );
    assert.match(
      afterGate, /C-19/,
      `${rel} must name the contract it is enforcing`
    );
  }

  // The fleet script is the one that reports online; Prime's status path differs.
  const fleet = read('infra/bootstrap/fleet-bootstrap.sh');
  assert.ok(
    fleet.indexOf('"$VALIDATE" --runtime') < fleet.indexOf('\\"status\\":\\"online\\"'),
    'a VM whose contracts do not hold must not report itself online'
  );
});

test('upgrade-corekit aborts rather than falling back to a branch name', () => {
  const src = read('corekit/system/upgrade-corekit');

  assert.doesNotMatch(
    src,
    /could not resolve SHA for \$\{ref\}, using branch name/,
    'the branch-name fallback must be gone'
  );
  assert.match(
    src,
    /Refusing to upgrade from a mutable ref \(C-35\)[\s\S]{0,120}?exit 1/,
    'an unresolvable ref must abort the upgrade'
  );
});

test('upgrade-corekit does not restart services after a failed validation', () => {
  const src = read('corekit/system/upgrade-corekit');

  assert.doesNotMatch(src, /⚠️  Contract validation found issues/, 'validation must not be advisory');
  assert.match(src, /Services were NOT restarted/, 'a failed validation must abort before restart');

  const validateAt = src.indexOf('Running contract validation');
  const restartAt = src.indexOf('Restart services');
  assert.ok(validateAt > -1 && restartAt > validateAt, 'validation must precede the restart block');
});

test('fleet-deploy resolves the inherited ref or refuses to deploy', () => {
  const src = read('corekit/fleet/fleet-deploy');

  assert.doesNotMatch(src, /^CORE_REF="main"$/m, 'no branch default');
  assert.doesNotMatch(src, /coreRef \/\/ "main"/, 'no branch fallback when reading STATE.json');
  assert.match(src, /Refusing to guess/, 'a missing ref must abort');
  assert.match(
    src,
    /refusing to deploy from a mutable ref \(C-35\)/,
    'an unresolvable ref must abort the deploy'
  );
});

// ── Control plane ──────────────────────────────────────────────────────

test('the control-plane upgrade deploys a commit-tagged image, never :latest', () => {
  const src = read('app/src/app/api/upgrade/route.ts');

  assert.doesNotMatch(src, /control-plane:latest/, 'a mutable image tag is not activatable');
  assert.match(src, /const image = `\$\{imageRepo\}:\$\{deploySha\}`/, 'the image tag is the source commit');
  assert.doesNotMatch(src, /"--branch", deployRef/, 'the build must not clone a branch tip');
  assert.match(src, /git fetch -q --depth=1 origin \$\{deploySha\}/, 'the build fetches the exact commit');
  assert.match(
    src,
    /test "\$\(git rev-parse HEAD\)" = "\$\{deploySha\}"/,
    'the build verifies it checked out the intended commit'
  );
  assert.match(
    src,
    /if \(!deploySha\) \{[\s\S]{0,400}?status: 502/,
    'an unresolvable channel must fail the request, not deploy something else'
  );
});

test('the Prime deploy route stamps a commit SHA into VM metadata', () => {
  const src = read('app/src/app/api/primes/[id]/deploy/route.ts');

  assert.doesNotMatch(src, /\{ key: "core_ref", value: "main" \}/, 'metadata must not carry a branch');
  assert.match(src, /\{ key: "core_ref", value: coreRef \}/);
  assert.match(src, /async function resolveChannelToSha/, 'the route must resolve the channel');
  assert.match(src, /Refusing to deploy from a mutable ref/, 'resolution failure must throw');
});

test('the Prime startup stub has no branch fallback', () => {
  const src = read('app/src/app/api/primes/[id]/deploy/route.ts');

  assert.doesNotMatch(src, /attributes\/core_ref" \|\| echo main/, 'no `|| echo main` fallback');
  assert.match(
    src,
    /Refusing to bootstrap/,
    'a startup stub that cannot read an immutable ref must abort'
  );
});
