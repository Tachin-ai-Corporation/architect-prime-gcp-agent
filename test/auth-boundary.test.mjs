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
  const src = read('app/src/middleware.ts');

  assert.match(src, /function isSetupSurface/, 'setup mode must be an explicit, bounded allowlist');
  assert.doesNotMatch(
    src,
    /if \(!clientId\) \{\s*\n\s*return NextResponse\.next\(\);/,
    'setup mode must not allow every path through'
  );
  assert.match(
    src,
    /if \(!clientId\) \{[\s\S]{0,400}?if \(isSetupSurface\(pathname\)\) return NextResponse\.next\(\);/,
    'setup mode must gate on the setup surface'
  );
  assert.match(
    src,
    /if \(!clientId\) \{[\s\S]{0,600}?status: 401/,
    'a non-setup API path in setup mode must 401'
  );
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
