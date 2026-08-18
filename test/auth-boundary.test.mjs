// test/auth-boundary.test.mjs — the control plane fails closed
//
// Three regressions this locks down, all found at v2026.08.15.1.0:
//
//   1. `POST /api/primes/[id]/fleet/update-status` was exempted from the session
//      middleware and documented a gateway-token check it never performed — any
//      caller who could reach the Cloud Run URL could set any agent's status.
//   2. Setup mode (`GOOGLE_CLIENT_ID` unset) allowed *every* path, so an
//      unconfigured deployment exposed all tenant reads and mutations.
//   3. The neural gateway's `checkAuth` returned `true` when no token was
//      configured — an unauthenticated LLM funnel that logged "Auth: disabled".
//
// These are source-level assertions rather than live HTTP calls: the property
// being protected is "the code cannot be written the unsafe way again", and it
// must hold in CI with no GCP credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

// ── 1. The one session-exempt route carries machine authentication ─────

test('fleet/update-status verifies a workload identity token', () => {
  const src = read('app/src/app/api/primes/[id]/fleet/update-status/route.ts');

  assert.match(src, /requireMachineAuth/, 'route must call requireMachineAuth');
  assert.match(
    src,
    /const auth = await requireMachineAuth\([\s\S]{0,120}?\);\s*\n\s*if \(!auth\.authenticated\) return auth\.response;/,
    'the machine-auth guard must run before any work and short-circuit on failure'
  );
  assert.match(src, /isAgentServiceAccount/, 'route must restrict the caller to fleet/prime service accounts');
});

test('a workload may only report its own agent status', () => {
  const src = read('app/src/app/api/primes/[id]/fleet/update-status/route.ts');
  assert.match(src, /fleet-\$\{agent\}@/, 'the asserted SA must be matched against the reported agent');
  assert.match(src, /status: 403/, 'a mismatched workload must be refused');
});

test('machine auth pins audience, issuer, and tenant project — and fails closed', () => {
  const src = read('app/src/lib/machine-auth.ts');

  assert.match(src, /verifyIdToken\(\{ idToken: [^,]+, audience \}\)/, 'audience must be pinned at verification');
  assert.match(src, /GOOGLE_ISSUERS\.has\(payload\.iss/, 'issuer must be checked');
  assert.match(src, /email_verified !== true/, 'email_verified must be required');
  assert.match(src, /iam\.gserviceaccount\.com/, 'caller must be a service account in the tenant project');

  // Every early exit must deny — no path may return authenticated:true on a
  // missing precondition (the shape of the original defect).
  assert.doesNotMatch(
    src,
    /if \(![A-Za-z]+\)[\s\S]{0,80}?return \{ authenticated: true/,
    'a missing precondition must never yield an authenticated result'
  );
  assert.match(src, /if \(!project\)[\s\S]{0,200}?return deny\(/, 'missing tenant project must deny');
  assert.match(src, /if \(!audience\)[\s\S]{0,200}?return deny\(/, 'missing audience must deny');
});

test('the fleet VM sends an audience-bound identity token', () => {
  const src = read('infra/bootstrap/fleet-bootstrap.sh');

  assert.match(
    src,
    /service-accounts\/default\/identity\?audience=\$\{DASHBOARD_URL\}/,
    'the VM must mint an identity token bound to the dashboard audience'
  );
  assert.match(src, /Authorization: Bearer \$\{ID_TOKEN\}/, 'the token must be sent on the callback');
  assert.match(
    src,
    /if \[\[ -z "\$ID_TOKEN" \]\]/,
    'a VM that cannot mint a token must skip the call, not call unauthenticated'
  );
});

// ── 2. Setup mode is bounded ───────────────────────────────────────────

test('setup mode is narrowed to the onboarding surface', () => {
  // Was a regex over middleware source, asserting the exact shape of an
  // `if (!clientId)` block. It broke the moment that block was improved to add a
  // bootstrap-token gate — a test that fails when the code gets better is
  // measuring the wrong thing, which is why the audit called for API-aware
  // boundary checks instead of line matching.
  //
  // The allowlist is still asserted structurally, because a bounded surface is
  // the property that matters. The DECISION is asserted against the pure module
  // in test/setup-gate.test.mjs, where it can be exercised rather than read.
  const src = read('app/src/middleware.ts');

  assert.match(src, /function isSetupSurface/, 'setup mode must be an explicit, bounded allowlist');
  assert.doesNotMatch(
    src,
    /if \(!clientId\) \{[\s\S]{0,40}?return NextResponse\.next\(\);/,
    'setup mode must not allow every path through'
  );
  // The gate is consulted, and the wizard is not reachable without the token.
  assert.match(src, /setupGate\(/, 'middleware must consult the setup gate');
  assert.match(src, /bootstrapTokenMatches\(/, 'the setup surface must require the bootstrap token');
  assert.match(src, /gate\.state === "locked"/, 'a deployment with no auth and no token must lock');
});

test('the setup gate locks rather than opening, and both enforcers agree', async () => {
  // The property the audit asked for: missing auth configuration must LOCK the
  // application, not create a public administrative mode.
  const { setupGate } = await import('../app/src/lib/setup-gate.ts');
  assert.equal(setupGate({}).state, 'locked');
  assert.equal(setupGate({ SETUP_BOOTSTRAP_TOKEN: 'z'.repeat(40) }).state, 'bootstrap');
  assert.equal(setupGate({ GOOGLE_CLIENT_ID: 'x' }).state, 'configured');

  // Defence in depth: the handler that can rewrite OAuth config, read Secret
  // Manager and update the running service must check the token ITSELF, not rely
  // on a middleware matcher staying correct.
  const route = read('app/src/app/api/setup/oauth/route.ts');
  assert.match(route, /bootstrapTokenMatches\(/,
    'setup/oauth must verify the bootstrap token in the handler, not only in middleware');
});

test('update-status is the only session-exempt API path', () => {
  const src = read('app/src/middleware.ts');
  const exemptFn = /function isSessionExempt[\s\S]*?\n\}/.exec(src);
  assert.ok(exemptFn, 'isSessionExempt must exist');

  const apiExemptions = (exemptFn[0].match(/"\/api\/[^"]*"|\/api\/[a-z-]+/g) || []).filter(
    (s) => !s.includes('/api/auth')
  );
  assert.deepEqual(
    apiExemptions,
    [],
    'no /api path may be session-exempt by prefix; the one machine route is matched by suffix and carries its own auth'
  );
  assert.match(src, /pathname\.endsWith\("\/fleet\/update-status"\)/);
});

// ── 3. The neural gateway fails closed ─────────────────────────────────

test('the neural gateway refuses to start without a token', () => {
  const src = read('corekit/brain/index.mjs');

  assert.doesNotMatch(
    src,
    /if \(!GATEWAY_TOKEN\) return true/,
    'checkAuth must never allow all callers when no token is configured'
  );
  assert.match(src, /if \(!GATEWAY_TOKEN\) \{[\s\S]{0,400}?process\.exit\(78\)/, 'a missing token must abort startup');
  assert.doesNotMatch(src, /Auth: disabled/, 'there is no unauthenticated gateway mode to advertise');
});

test('gateway token comparison is constant-time', () => {
  const src = read('corekit/brain/index.mjs');
  assert.match(src, /diff \|= auth\.charCodeAt\(i\) \^ expected\.charCodeAt\(i\)/);
  assert.doesNotMatch(src, /return auth === `Bearer \$\{GATEWAY_TOKEN\}`/);
});

// ── 4. No bootstrap script prints a secret ─────────────────────────────

test('bootstrap scripts never echo the gateway token', () => {
  for (const rel of ['infra/bootstrap/fleet-bootstrap.sh', 'infra/bootstrap/prime-bootstrap.sh']) {
    const src = read(rel);
    const lines = src.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!/^\s*(echo|printf|info|warn)\b/.test(line)) continue;
      // Writing the token into its 0600 file is the point; printing it to
      // stdout is what lands it in the serial console.
      if (/>\s*"?\$\{?CORE_DIR/.test(line)) continue;
      const raw = /\$\{MY_TOKEN\}|\$MY_TOKEN\b/.test(line);
      const hashed = /sha256sum/.test(line);
      assert.ok(
        !raw || hashed,
        `${rel}:${i + 1} prints the gateway token in cleartext — print a fingerprint instead:\n  ${line.trim()}`
      );
    }
  }
});

// ── Secrets do not travel as build arguments ───────────────────────────
//
// The dashboard's self-upgrade route submits a Cloud Build config, and a build
// config is persisted in build history and readable by anyone with
// build-viewer access. It used to re-send NEXTAUTH_SECRET — the session-signing
// key, sufficient on its own to mint a valid cookie for this dashboard — as a
// `--update-env-vars` argument.
//
// It was reading its own environment to do it, which is circular: those values
// are in the process because they are already on the service, and
// `--update-env-vars` MERGES, leaving unmentioned values untouched. So the
// re-listing changed nothing except who could read the secret.

test('the upgrade route sends no secret in its build config', () => {
  const src = readFileSync(join(REPO, 'app', 'src', 'app', 'api', 'upgrade', 'route.ts'), 'utf8');

  // Ignore prose: a comment explaining the removal must not read as a violation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const name of ['NEXTAUTH_SECRET', 'DWD_CLIENT_ID', 'GOOGLE_CLIENT_ID']) {
    assert.ok(!code.includes(name),
      `${name} appears in the upgrade route's code. A Cloud Build config is persisted and ` +
      `readable; --update-env-vars merges, so an existing value needs no re-sending.`);
  }
});

test('the deploy step still merges rather than replacing the environment', () => {
  // The removal above is only safe BECAUSE the flag merges. If this ever becomes
  // --set-env-vars, dropping those values would wipe them from the service.
  const src = readFileSync(join(REPO, 'app', 'src', 'app', 'api', 'upgrade', 'route.ts'), 'utf8');
  assert.ok(src.includes('--update-env-vars'), 'the deploy must merge env vars');
  assert.ok(!src.includes('--set-env-vars'),
    '--set-env-vars REPLACES the whole environment; with the pass-through removed that would ' +
    'delete NEXTAUTH_SECRET from the running service and invalidate every session');
});
