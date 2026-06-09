// corekit/lib/gce-auth.mjs — GCE metadata OAuth2 token cache
// Extracted from agent-brain.mjs Phase 0A
// Used by all daemons and lib modules that talk to GCP services.

let _cache = { token: null, expiresAt: 0 };
const REFRESH_MARGIN_MS = 30_000;

/**
 * Get a valid GCE metadata OAuth2 access token.
 * Caches the token and auto-refreshes when near expiry.
 * @returns {Promise<string>} OAuth2 access token
 */
export async function getGceToken() {
  if (_cache.token && Date.now() < _cache.expiresAt - REFRESH_MARGIN_MS) {
    return _cache.token;
  }
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) }
  );
  if (!resp.ok) throw new Error(`GCE metadata token fetch failed: HTTP ${resp.status}`);
  const data = await resp.json();
  _cache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return _cache.token;
}
