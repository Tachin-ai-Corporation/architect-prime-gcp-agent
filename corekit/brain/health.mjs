// corekit/brain/health.mjs — Health Check Endpoints
//
// /healthz — liveness probe (always 200 if server is up)
// /ready   — readiness probe (checks model provider availability)

import { getProviderStatus } from './router.mjs';

/**
 * Handle health check requests.
 *
 * @param {string} path  Request path (/healthz or /ready)
 * @param {http.ServerResponse} res
 * @returns {boolean}  true if handled
 */
export function handleHealth(path, res) {
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return true;
  }

  if (path === '/ready') {
    const status = getProviderStatus();
    const allReady = Object.values(status).every(s => s.available);
    const code = allReady ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: allReady, providers: status }));
    return true;
  }

  return false;
}
