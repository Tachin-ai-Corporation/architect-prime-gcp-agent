#!/usr/bin/env node
// vertex-claude-proxy.mjs — Anthropic Messages API → Vertex AI rawPredict
//
// Runs inside the OpenClaw container alongside agent-ears, agent-mouth, etc.
// Accepts requests from OpenClaw's custom "vertex-claude" provider on
// localhost:18790 and forwards them to Vertex AI's rawPredict endpoint.
//
// Zero npm dependencies. Uses Node built-in http + global fetch.

import { createServer } from 'http';
import { appendFileSync } from 'fs';

const PORT = 18790;
const REGION = process.env.CLOUD_ML_REGION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const PROJECT = process.env.GCP_PROJECT_ID || process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
const LOG_FILE = '/var/log/vertex-claude-proxy.log';

// ---- Logging ----
function log(msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), svc: 'vertex-claude-proxy', msg, ...meta }) + '\n';
  process.stderr.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ---- GCE Metadata Token (same pattern as agent-introspect, agent-ears, etc.) ----
let _token = null, _expiry = 0;
async function getToken() {
  if (_token && Date.now() < _expiry) return _token;
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) throw new Error(`Metadata token fetch failed: ${res.status}`);
  const data = await res.json();
  _token = data.access_token;
  _expiry = Date.now() + (data.expires_in - 120) * 1000;
  return _token;
}

// ---- Request Counter ----
let reqCount = 0;

// ---- HTTP Server ----
const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', requests: reqCount, project: PROJECT, region: REGION }));
    return;
  }

  // Only accept POST /v1/messages (Anthropic Messages API)
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: 'POST /v1/messages only' } }));
    return;
  }

  reqCount++;
  const rid = reqCount;

  try {
    // Read request body
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const model = body.model || 'claude-sonnet-4-6';
    log('Request', { rid, model, maxTokens: body.max_tokens });

    // Get GCE auth token
    const token = await getToken();

    // Build rawPredict request body
    // Anthropic Messages API → rawPredict: model goes in URL, anthropic_version required
    const rawBody = { ...body };
    delete rawBody.model;  // model is in the URL path, not the body
    if (!rawBody.anthropic_version) {
      rawBody.anthropic_version = 'vertex-2023-10-16';
    }

    // Vertex AI rawPredict endpoint
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/anthropic/models/${model}:rawPredict`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rawBody),
    });

    const contentType = upstream.headers.get('content-type') || 'application/json';
    const respBody = await upstream.text();

    if (!upstream.ok) {
      log('Upstream error', { rid, model, status: upstream.status, body: respBody.substring(0, 500) });
    } else {
      log('Success', { rid, model, status: upstream.status });
    }

    // Forward response as-is
    res.writeHead(upstream.status, { 'Content-Type': contentType });
    res.end(respBody);
  } catch (err) {
    log('Proxy error', { rid, error: err.message });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: err.message },
    }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('Started', { port: PORT, project: PROJECT, region: REGION });
});
