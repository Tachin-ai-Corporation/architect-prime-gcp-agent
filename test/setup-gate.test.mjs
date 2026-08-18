// test/setup-gate.test.mjs — the first-run setup surface may not be an open door.
//
// A fresh deployment has no OAuth, so the setup wizard cannot be protected by a
// session. It was therefore protected by nothing: on an --allow-unauthenticated
// Cloud Run service with GOOGLE_CLIENT_ID absent, POST /api/setup/oauth accepted
// caller-supplied OAuth credentials, touched Secret Manager, and updated the
// running service. Whoever found the URL first could claim the control plane.
//
// The audit called this P0. It is latent on THIS deployment (OAuth is configured)
// and live on every fork and every fresh install until setup completes, which for
// a public template is the more important of the two.
//
// The rule these tests hold: missing auth configuration LOCKS the app. It does
// not open an administrative mode.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupGate, bootstrapTokenMatches, presentedToken, BOOTSTRAP_HEADER, BOOTSTRAP_QUERY }
  from '../app/src/lib/setup-gate.ts';

const TOKEN = 'a'.repeat(32);

describe('setupGate — the three states, and no fourth', () => {
  it('OAuth configured closes setup entirely', () => {
    assert.deepEqual(setupGate({ GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' }), { state: 'configured' });
    // Even with a token lying around, configured wins — a stale bootstrap token
    // must not reopen the wizard on a live deployment.
    assert.equal(setupGate({ GOOGLE_CLIENT_ID: 'x', SETUP_BOOTSTRAP_TOKEN: TOKEN }).state, 'configured');
  });

  it('no OAuth and no token LOCKS — this is the whole point', () => {
    const g = setupGate({});
    assert.equal(g.state, 'locked');
    assert.match(g.reason, /locked/i, 'the reason must tell an operator what happened');
  });

  it('a blank or whitespace token is no token', () => {
    for (const t of ['', '   ', '\n']) {
      assert.equal(setupGate({ SETUP_BOOTSTRAP_TOKEN: t }).state, 'locked', `'${t}' must not open setup`);
    }
  });

  it('no OAuth plus a token opens the wizard, and only the wizard', () => {
    assert.equal(setupGate({ SETUP_BOOTSTRAP_TOKEN: TOKEN }).state, 'bootstrap');
  });
});

describe('bootstrapTokenMatches — a guessable token is worse than none', () => {
  it('matches an exact token', () => {
    assert.equal(bootstrapTokenMatches(TOKEN, TOKEN), true);
  });

  it('rejects a wrong token of the same length', () => {
    assert.equal(bootstrapTokenMatches('b'.repeat(32), TOKEN), false);
  });

  it('rejects anything short enough to guess, even if it matches', () => {
    // Reads as protection while providing none, which is the failure mode this
    // repo has hit repeatedly in other guards.
    assert.equal(bootstrapTokenMatches('short', 'short'), false);
    assert.equal(bootstrapTokenMatches('a'.repeat(23), 'a'.repeat(23)), false);
    assert.equal(bootstrapTokenMatches('a'.repeat(24), 'a'.repeat(24)), true);
  });

  it('rejects absent, null and undefined rather than treating them as empty-equals-empty', () => {
    assert.equal(bootstrapTokenMatches(null, null), false);
    assert.equal(bootstrapTokenMatches(undefined, TOKEN), false);
    assert.equal(bootstrapTokenMatches(TOKEN, undefined), false);
    assert.equal(bootstrapTokenMatches('', ''), false);
  });

  it('does not accept a prefix or a longer superstring', () => {
    assert.equal(bootstrapTokenMatches(TOKEN.slice(0, 31), TOKEN), false);
    assert.equal(bootstrapTokenMatches(TOKEN + 'a', TOKEN), false);
  });
});

describe('presentedToken — header first, query as the browser fallback', () => {
  const req = (headers, query) => ({
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(query || '') },
  });

  it('reads the header', () => {
    assert.equal(presentedToken(req({ [BOOTSTRAP_HEADER]: TOKEN })), TOKEN);
  });

  it('falls back to the query parameter', () => {
    assert.equal(presentedToken(req({}, `${BOOTSTRAP_QUERY}=${TOKEN}`)), TOKEN);
  });

  it('prefers the header when both are present', () => {
    assert.equal(presentedToken(req({ [BOOTSTRAP_HEADER]: TOKEN }, `${BOOTSTRAP_QUERY}=other`)), TOKEN);
  });

  it('returns null when neither is present, rather than an empty string', () => {
    assert.equal(presentedToken(req({})), null);
  });
});
