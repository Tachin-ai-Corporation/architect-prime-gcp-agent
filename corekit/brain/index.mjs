// corekit/brain/index.mjs — Neural Gateway HTTP Server
// Original module
// Used by agent-brain.mjs (gateway consumer) and agent-ears.mjs (liveness pre-flight)
//
// Listens on port 18789, implements the exact same API contract that
// agent-brain.mjs and agent-ears.mjs expect:
//
//   POST /v1/chat/completions  — OpenAI-compatible inference
//   GET  /v1/models            — Health/liveness (used by agent-brain pre-flight)
//   GET  /healthz              — Liveness probe
//   GET  /ready                — Readiness probe (checks providers)
//   GET  /status               — Brain status
//
// The model field carries the agent route: "brain/cortex", "brain/motor", etc.
// Agent-brain.mjs parses the agent ID from this route.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initRouter, getProviderStatus } from './router.mjs';
import { runAgentTurnSyncWithFallback } from './loop.mjs';
import { loadAgentConfig, getBrainConfig, getContracts } from './config.mjs';
import { getFilteredTools } from './tools.mjs';
import { listSessions } from './context.mjs';
import { handleHealth } from './health.mjs';

// ---- Read body helper ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ---- Gateway token auth ----
const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
let GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
if (!GATEWAY_TOKEN) {
  const tokenPath = join(CORE_DIR, '.gateway-token');
  if (existsSync(tokenPath)) {
    GATEWAY_TOKEN = readFileSync(tokenPath, 'utf8').trim();
  }
}

function checkAuth(req) {
  if (!GATEWAY_TOKEN) return true; // no token configured = allow all
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${GATEWAY_TOKEN}`;
}

// ---- Parse agent ID from model route ----
// agent-brain.mjs sends model: "brain/cortex", "brain/motor", etc.
// We accept: "brain/cortex", legacy formats, or just "cortex"
function parseAgentId(modelRoute) {
  if (!modelRoute) return 'cortex';
  const parts = modelRoute.split('/');
  return parts.length > 1 ? parts[parts.length - 1] : modelRoute;
}

// ---- Initialize ----
const config = getBrainConfig();
console.log(`[brain] Config:`, JSON.stringify(config));

await initRouter({
  project: config.project,
  googleLocation: config.googleLocation,
  anthropicLocation: config.anthropicLocation,
});

// ---- Request counter ----
let reqCount = 0;

// ---- HTTP Server ----
const server = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health checks (/healthz, /ready)
  if (req.method === 'GET' && handleHealth(req.url, res)) return;

  // /v1/models — used by agent-brain.mjs as liveness pre-flight check
  if (req.method === 'GET' && req.url === '/v1/models') {
    const providers = getProviderStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: Object.entries(providers).map(([id, info]) => ({
        id,
        object: 'model',
        owned_by: 'brain',
        available: info.available,
        location: info.location,
      })),
    }));
    return;
  }

  // /status — debug info
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptime: process.uptime(),
      requests: reqCount,
      sessions: listSessions(),
      providers: getProviderStatus(),
      config: { port: config.port, project: config.project },
    }));
    return;
  }

  // ---- /v1/chat/completions — OpenAI-compatible inference endpoint ----
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    // Auth check
    if (!checkAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }));
      return;
    }

    reqCount++;
    const rid = reqCount;

    try {
      const body = JSON.parse(await readBody(req));
      const {
        model: modelRoute,
        messages = [],
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
      } = body;

      const agentId = parseAgentId(modelRoute);
      console.log(`[brain] #${rid} route=${modelRoute} agent=${agentId} msgs=${messages.length}`);

      // Load agent config
      const agentConfig = loadAgentConfig(agentId);

      // Get tools for this agent (undefined = no tools, not empty object)
      const rawTools = getFilteredTools(agentConfig.allowedTools);
      const tools = rawTools && Object.keys(rawTools).length > 0 ? rawTools : undefined;

      // Separate system messages from the rest. SESSION_CONTEXT_PLAN Phase 2:
      // multiple system messages are preserved as separate BLOCKS (stable
      // first, volatile MEMORY last) so the stable prefix can carry a 1h
      // cache breakpoint; content-parts arrays flatten to their text.
      const contentToString = c => Array.isArray(c) ? c.map(p => p?.text || '').join('\n\n') : (c || '');
      const systemMessages = messages.filter(m => m.role === 'system');
      const systemBlocks = systemMessages.map(m => contentToString(m.content)).filter(Boolean);
      const systemPrompt = systemBlocks.join('\n') || agentConfig.systemPrompt;
      const chatMessages = messages.filter(m => m.role !== 'system');

      // Run inference (Anthropic uses streaming internally; response is collected before returning)
      const result = await runAgentTurnSyncWithFallback({
        modelString: agentConfig.model,
        fallbackModel: agentConfig.fallbackModel,
        systemPrompt,
        systemBlocks: systemBlocks.length > 0 ? systemBlocks : undefined,
        messages: chatMessages,
        tools,
        maxSteps: agentConfig.maxSteps,
        maxTokens: maxTokens || agentConfig.maxTokens || 8192,
        temperature: temperature ?? agentConfig.temperature ?? 0.3,
        topP: topP ?? agentConfig.topP ?? 0.95,
        agentId,
      });

      const u = result.usage || {};
      console.log(`[brain] #${rid} completed (${result.text.length} chars, in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'} cached=${u.cachedContentTokenCount ?? 0} cache_write=${u.cacheCreationTokenCount ?? 0} steps=${u.steps ?? 1} provider=${u.provider || '?'})`);

      // Return OpenAI-compatible response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-brain-${rid}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: agentConfig.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: result.text,
          },
          finish_reason: result.finishReason || 'stop',
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    } catch (err) {
      console.error(`[brain] #${rid} error:`, err.message);

      const statusCode = err.statusCode || 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: err.message,
          type: 'brain_error',
          code: statusCode,
        },
      }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[brain] Listening on 127.0.0.1:${config.port}`);
  console.log(`[brain] Project: ${config.project}`);
  console.log(`[brain] Google: ${config.googleLocation} | Anthropic: ${config.anthropicLocation}`);
  if (GATEWAY_TOKEN) console.log(`[brain] Auth: token-based`);
  else console.log(`[brain] Auth: disabled (no gateway token)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[brain] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[brain] SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
