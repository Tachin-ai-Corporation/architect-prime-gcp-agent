// corekit/lib/dwd-auth.mjs — Domain-Wide Delegation OAuth2 token cache
// Extracted from agent-ears.mjs / agent-mouth.mjs Phase 4
// Used by ears (Gmail/GChat polling) and mouth (GChat delivery)
//
// DWD is fundamentally different from GCE metadata tokens:
// - Signs a JWT via IAM signJwt API
// - Exchanges JWT for access token via Google OAuth2
// - Impersonates a specific user (the service account's delegated user)

import { getGceToken } from './gce-auth.mjs';

let _cache = { token: null, expiresAt: 0 };

/**
 * Get a DWD (Domain-Wide Delegation) access token.
 * Signs a JWT using IAM signJwt, exchanges for OAuth2 token.
 * Caches the token (~58 min TTL) and auto-refreshes when expired.
 *
 * @param {object} config
 * @param {string} config.signerServiceAccount - SA email for JWT signing (iss). Falls back to VM SA if empty.
 * @param {string} config.subjectEmail - User email to impersonate (sub)
 * @param {string} config.scopes - Space-separated OAuth scopes
 * @returns {Promise<string>} OAuth2 access token
 */
export async function getDwdToken(config) {
  if (_cache.token && Date.now() < _cache.expiresAt) {
    return _cache.token;
  }

  const { signerServiceAccount, subjectEmail, scopes } = config;

  // Get a GCE token for the IAM signJwt call itself
  const gceToken = await getGceToken();

  // Resolve signer SA: explicit config or fall back to VM default SA
  let signerSa = signerServiceAccount;
  if (!signerSa) {
    const metaBase = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
    signerSa = await fetch(`${metaBase}/email`, { headers: { 'Metadata-Flavor': 'Google' } }).then(r => r.text());
  }

  // Build JWT claim
  const now = Math.floor(Date.now() / 1000);
  const claim = JSON.stringify({
    iss: signerSa,
    sub: subjectEmail,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });

  // Sign the JWT via IAM
  const signUrl = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${signerSa}:signJwt`;
  const signRes = await fetch(signUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gceToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: claim }),
  });
  if (!signRes.ok) {
    const err = await signRes.text();
    throw new Error(`signJwt failed (${signRes.status}): ${err.slice(0, 200)}`);
  }
  const { signedJwt } = await signRes.json();

  // Exchange signed JWT for an access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`DWD token exchange failed: ${tokenData.error_description || tokenData.error}`);
  }

  _cache.token = tokenData.access_token;
  _cache.expiresAt = Date.now() + 3500_000;
  return _cache.token;
}
