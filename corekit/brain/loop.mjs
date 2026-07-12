// corekit/brain/loop.mjs — Agent Inference Loop
//
// Core inference loop using direct client SDKs for Google and Anthropic.
// Resolves the model, performs turns, executes tools, and returns the result.

import { getGoogleClient, getAnthropicClient, parseModel } from './router.mjs';
import { toGoogleSchema } from './tools.mjs';
import { computeBreakpointLayout, estimateTokens } from '../lib/prompt-blocks.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
let contractsPath = join(CORE_DIR, 'corekit', 'contracts.json');
if (!existsSync(contractsPath)) {
  contractsPath = join(__dirname, '..', '..', 'infra', 'contracts.json');
}

let CONTRACTS = {};
try {
  if (existsSync(contractsPath)) {
    CONTRACTS = JSON.parse(readFileSync(contractsPath, 'utf8'));
  }
} catch (e) {
  console.log('[loop] WARN: contracts.json not loaded: ' + e.message);
}

// ---- Prompt caching configuration (SESSION_CONTEXT_PLAN Phase 2, C-7) ----
// Live-verified 2026-07-11: claude-opus-4-6 @ us-east5 accepts cache_control
// ttl '1h' (billed under cache_creation.ephemeral_1h_input_tokens) with a
// ~4,096-token caching floor; Gemini explicit cachedContent enforces 1h TTLs
// exactly with a ~2,048-token floor. 1h is load-bearing, not an optimization:
// a single motor task can outlive the 5m default TTL.
const VERTEX_CFG = CONTRACTS.vertex || {};
const CACHE_TTL_STABLE = VERTEX_CFG.anthropic_cache_ttl_stable || '1h';
const CACHE_TTL_MISSION = VERTEX_CFG.anthropic_cache_ttl_mission || '1h';
const MSG_BREAKPOINTS_ENABLED = VERTEX_CFG.anthropic_cache_message_breakpoints === true;
const SESSION_AFFINITY_ENABLED = VERTEX_CFG.anthropic_session_affinity === true;
const GEMINI_EXPLICIT_CACHE = VERTEX_CFG.gemini_explicit_cache === true;
const GEMINI_CACHE_TTL_S = VERTEX_CFG.gemini_explicit_cache_ttl_seconds || 3600;

// '5m' is the provider default — omit the ttl field for maximum compatibility.
function cacheControl(ttl) {
  return ttl && ttl !== '5m' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

// Resolve system content: prefer caller-supplied blocks (stable block first),
// fall back to the single systemPrompt string. The skill catalog (boot-stable)
// is appended to the FIRST block so the stable prefix stays byte-identical.
function resolveSystemBlocks(systemBlocks, systemPrompt, catalog) {
  const blocks = (Array.isArray(systemBlocks) && systemBlocks.length > 0)
    ? [...systemBlocks]
    : [systemPrompt || ''];
  if (catalog) blocks[0] = blocks[0] + catalog;
  return blocks.filter(b => typeof b === 'string' && b.length > 0);
}

// Terminal tools carry their payload THROUGH the tool log (verdict.mjs parses it) —
// they get a generous cap; ordinary tools keep the tight one.
const TERMINAL_LOG_TOOLS = new Set(['report_pass', 'report_fail', 'request_probe']);
const argLogCap = (name) => (TERMINAL_LOG_TOOLS.has(name) ? 4000 : 200);

// ---- Retry with exponential backoff for rate-limited model calls ----
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

async function retryWithBackoff(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.status === 429 || err?.code === 429
        || err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
      if (!is429 || attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.log(`[loop] ${label}: 429 rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---- Usage accumulation (SESSION_CONTEXT_PLAN Phase 0) ----
// Both SDKs report real token counts per call; the turn loop makes one billed
// call per step, so usage is summed across steps. last_step_input_tokens is
// the final step's full prompt size — the context-size signal downstream
// compaction thresholds key off. The finalized shape is dual-keyed: OpenAI
// names plus the aliases agent-brain.mjs telemetry already reads
// (promptTokenCount / candidatesTokenCount / cachedContentTokenCount).
function newUsageAccumulator(provider) {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    lastStepInputTokens: 0,
    steps: 0,
    provider,
  };
}

function addGoogleUsage(acc, usageMetadata) {
  if (!usageMetadata) return;
  acc.promptTokens += usageMetadata.promptTokenCount || 0;
  acc.completionTokens += usageMetadata.candidatesTokenCount || 0;
  acc.cachedReadTokens += usageMetadata.cachedContentTokenCount || 0;
  acc.lastStepInputTokens = usageMetadata.promptTokenCount || acc.lastStepInputTokens;
  acc.steps++;
}

function addAnthropicUsage(acc, usage) {
  if (!usage) return;
  // Anthropic reports uncached input, cache reads, and cache writes separately;
  // the attended prompt is their sum (matches Gemini's promptTokenCount semantics).
  const stepInput = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  acc.promptTokens += stepInput;
  acc.completionTokens += usage.output_tokens || 0;
  acc.cachedReadTokens += usage.cache_read_input_tokens || 0;
  acc.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
  acc.lastStepInputTokens = stepInput || acc.lastStepInputTokens;
  acc.steps++;
}

function finalizeUsage(acc) {
  return {
    prompt_tokens: acc.promptTokens,
    completion_tokens: acc.completionTokens,
    total_tokens: acc.promptTokens + acc.completionTokens,
    promptTokenCount: acc.promptTokens,
    candidatesTokenCount: acc.completionTokens,
    cachedContentTokenCount: acc.cachedReadTokens,
    cacheCreationTokenCount: acc.cacheWriteTokens,
    last_step_input_tokens: acc.lastStepInputTokens,
    steps: acc.steps,
    provider: acc.provider,
  };
}

// ---- Loop guard: detect stuck tool-calling loops ----
const DUPLICATE_NUDGE = CONTRACTS?.gateway?.duplicate_nudge_threshold || 3;
const DUPLICATE_TERMINATE = CONTRACTS?.gateway?.duplicate_terminate_threshold || 4;
const ERROR_NUDGE = 5;
const ERROR_TERMINATE = 8;
const ERROR_PATTERNS = ['ERROR:', 'No such file', 'command not found',
  'Permission denied', 'not found', 'ENOENT'];

class LoopGuard {
  constructor() {
    this.callCounts = new Map();
    this.toolNameCounts = new Map();
    this.consecutiveErrors = 0;
    this.nudgedDuplicate = false;
    this.nudgedErrors = false;
    this._nudgedSemantic = false;
    this._terminated = false;
  }

  check(toolName, args, result) {
    const sig = `${toolName}:${JSON.stringify(args)}`;
    const count = (this.callCounts.get(sig) || 0) + 1;
    this.callCounts.set(sig, count);

    const nameCount = (this.toolNameCounts.get(toolName) || 0) + 1;
    this.toolNameCounts.set(toolName, nameCount);

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
    const isError = ERROR_PATTERNS.some(p => resultStr.includes(p));
    if (isError) { this.consecutiveErrors++; }
    else { this.consecutiveErrors = 0; this.nudgedErrors = false; }

    if (count >= DUPLICATE_TERMINATE) {
      this._terminated = true;
      const argsStr = JSON.stringify(args);
      const report = JSON.stringify({
        stuck_tool: toolName,
        stuck_args: argsStr.length > 200 ? argsStr.substring(0, 200) + '…' : argsStr,
        total_calls: this._totalCalls(),
        unique_signatures: this.callCounts.size,
      });
      return { action: 'terminate',
        message: `[LOOP DETECTED] You called ${toolName} with the same arguments ${count} times. The result is not changing. Stopping — report FAILURE with what you observed.\n[STUCK REPORT] ${report}` };
    }
    if (count >= DUPLICATE_NUDGE && !this.nudgedDuplicate) {
      this.nudgedDuplicate = true;
      return { action: 'nudge',
        message: `[WARNING] You've called ${toolName} with identical arguments ${count} times and the result hasn't changed. Stop retrying and either try a different approach or report FAILURE.` };
    }
    if (this.consecutiveErrors >= ERROR_TERMINATE) {
      this._terminated = true;
      return { action: 'terminate',
        message: `[LOOP DETECTED] ${this.consecutiveErrors} consecutive tool calls returned errors. Stopping — report FAILURE with what you observed.` };
    }
    if (this.consecutiveErrors >= ERROR_NUDGE && !this.nudgedErrors) {
      this.nudgedErrors = true;
      return { action: 'nudge',
        message: `[WARNING] ${this.consecutiveErrors} consecutive tool calls have returned errors. If the task cannot be completed, report FAILURE with what you've observed.` };
    }
    if (nameCount >= 8 && !this._nudgedSemantic) {
      this._nudgedSemantic = true;
      return { action: 'nudge',
        message: `[WARNING] You have called ${toolName} ${nameCount} times this turn (with varying arguments). You may be stuck in a semantic loop. Consider a completely different strategy or report FAILURE.` };
    }
    return { action: 'ok' };
  }

  _totalCalls() {
    let n = 0;
    for (const c of this.callCounts.values()) n += c;
    return n;
  }

  getMetrics() {
    let duplicateCalls = 0;
    for (const c of this.callCounts.values()) { if (c > 1) duplicateCalls += c; }
    return {
      totalCalls: this._totalCalls(),
      uniqueSignatures: this.callCounts.size,
      duplicateCalls,
      consecutiveErrors: this.consecutiveErrors,
      terminated: this._terminated,
    };
  }
}

// ---- Skill catalog for execution agents (Layer D) ----
function buildSkillCatalogPrompt() {
  const CORE_DIR = process.env.CORE_DIR || '/opt/corekit';
  const skillsDirs = [join(CORE_DIR, 'skills')];

  // Determine specialty from chat-config.json
  let specialty = '';
  try {
    const cfg = JSON.parse(readFileSync(join(CORE_DIR, 'corekit', 'chat-config.json'), 'utf8'));
    specialty = cfg.specialty || cfg.agentType || '';
  } catch {}
  if (specialty) {
    skillsDirs.push(join(CORE_DIR, 'corekit', 'specialties', specialty, 'skills'));
  }

  // Also scan custom per-agent skills
  const customDir = join(CORE_DIR, 'workspace', 'custom-skills');
  if (existsSync(customDir)) {
    skillsDirs.push(customDir);
  }

  const entries = [];
  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const name of files) {
      const skillDir = join(dir, name);
      const jsonPath = join(skillDir, 'skill.json');
      if (!existsSync(jsonPath)) continue;
      try {
        const m = JSON.parse(readFileSync(jsonPath, 'utf8'));
        entries.push({
          name: m.name || name,
          id: m.id || name,
          when_to_use: m.when_to_use || m.description || '',
          path: join(skillDir, 'SKILL.md'),
        });
      } catch {}
    }
  }

  if (entries.length === 0) return '';
  const lines = entries.map(e =>
    `- ${e.name} (${e.id}): ${e.when_to_use}\n  → readFile ${e.path}`
  );
  return `\n\n## Available Skills\nBefore using any command tool, read the relevant SKILL.md:\n${lines.join('\n')}\n\nDo NOT guess skill paths. Only the paths listed above exist.\n`;
}

let _skillCatalog = null;
function getSkillCatalog() {
  if (_skillCatalog === null) _skillCatalog = buildSkillCatalogPrompt();
  return _skillCatalog;
}

/**
 * Convert standard message history to Google Contents API format.
 */
function convertMessagesToGoogle(messages) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // System messages are handled as systemInstruction, skip here.
    if (msg.role === 'system') continue;

    // Assistant messages with tool calls → model turn with functionCall parts
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      result.push({
        role: 'model',
        parts: msg.toolCalls.map(tc => ({
          functionCall: {
            name: tc.toolName || tc.name,
            args: tc.args,
          }
        }))
      });
      continue;
    }

    // Tool responses → batch consecutive tool messages into a single user turn
    // Gemini requires: N functionCall parts → N functionResponse parts in one turn
    if (msg.role === 'tool') {
      const toolParts = [];
      let j = i;
      while (j < messages.length && messages[j].role === 'tool') {
        const tm = messages[j];
        toolParts.push({
          functionResponse: {
            name: tm.toolName || tm.name,
            response: typeof tm.content === 'object' ? tm.content : { result: tm.content }
          }
        });
        j++;
      }
      result.push({ role: 'user', parts: toolParts });
      i = j - 1; // skip consolidated messages (loop will i++)
      continue;
    }

    // Regular text messages. Content-parts arrays (SESSION_CONTEXT_PLAN
    // Phase 2) concatenate to the identical bytes renderBlocks() produced —
    // exactly what Gemini implicit caching keys on.
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = Array.isArray(msg.content)
      ? msg.content.map(p => p?.text || '').join('\n\n')
      : (msg.content || '');
    result.push({
      role,
      parts: [{ text }]
    });
  }
  return result;
}

/**
 * Convert standard message history to Anthropic Messages API format.
 */
function convertMessagesToAnthropic(messages) {
  return messages.map(msg => {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
          ...msg.toolCalls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.toolName || tc.name,
            input: tc.args
          }))
        ]
      };
    }

    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId || msg.id,
          content: typeof msg.content === 'object' ? JSON.stringify(msg.content) : String(msg.content)
        }]
      };
    }

    // Content-parts arrays pass through as Anthropic text blocks; the
    // daemon-supplied `tier` hint survives for breakpoint placement and is
    // stripped before the request leaves applyMessageBreakpoints().
    if (Array.isArray(msg.content)) {
      return {
        role,
        content: msg.content.map(p => ({ type: 'text', text: p?.text || '', ...(p?.tier ? { tier: p.tier } : {}) })),
      };
    }

    return {
      role,
      content: msg.content || ''
    };
  });
}

/**
 * Place cache_control on the first user message's content parts per the
 * pure layout arithmetic (SESSION_CONTEXT_PLAN Phase 2). Non-standard `tier`
 * hints are stripped here — nothing non-API ever reaches the provider.
 * Logs part token estimates so sub-floor misses (Opus caches only prefixes
 * over ~4,096 tokens) are explainable from telemetry.
 */
function applyMessageBreakpoints(anthropicMessages, { systemBreakpointsUsed }) {
  const first = anthropicMessages.find(m => m.role === 'user' && Array.isArray(m.content));
  for (const msg of anthropicMessages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg === first) {
      const layout = computeBreakpointLayout(msg.content, {
        systemBreakpointsUsed,
        ttlStable: CACHE_TTL_STABLE,
        ttlMission: CACHE_TTL_MISSION,
      });
      const sizes = msg.content.map(p => `${p.tier || 'volatile'}≈${estimateTokens(p.text)}tok`).join(' ');
      console.log(`[loop] cache breakpoints: ${layout.length} message BP(s) [${sizes}]`);
      msg.content = msg.content.map((p, i) => {
        const bp = layout.find(b => b.index === i);
        const clean = { type: 'text', text: p.text };
        return bp ? { ...clean, cache_control: cacheControl(bp.ttl) } : clean;
      });
    } else {
      msg.content = msg.content.map(p => ({ type: 'text', text: p.text }));
    }
  }
}

/**
 * SESSION_CONTEXT_PLAN Phase 5: place ONE rolling cache breakpoint at the
 * session's frozen-prefix boundary (everything the gateway stored before this
 * turn's delta), so the byte-stable transcript prefix is read from provider
 * cache at ~0.1x while only the new delta is billed full price. Replaces
 * applyMessageBreakpoints on continue turns (system BP1 + this = 2, well under
 * the 4 cap). The boundary message may be an assistant STRING turn (a coerced
 * decision) or a USER content-parts array (the open turn / a prior delta) —
 * handle both; tier hints are stripped from every array-content message so
 * nothing non-API reaches the provider.
 */
function applySessionBoundaryBreakpoint(anthropicMessages, boundaryIndex) {
  const idx = boundaryIndex - 1; // last frozen (cached) message
  anthropicMessages.forEach((msg, i) => {
    if (i === idx) {
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(p => ({ type: 'text', text: p.text }));
        parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: cacheControl(CACHE_TTL_MISSION) };
        msg.content = parts;
      } else {
        msg.content = [{ type: 'text', text: msg.content || '', cache_control: cacheControl(CACHE_TTL_MISSION) }];
      }
    } else if (Array.isArray(msg.content)) {
      msg.content = msg.content.map(p => ({ type: 'text', text: p.text }));
    }
  });
  console.log(`[loop] session cache breakpoint at frozen-prefix boundary (msg ${idx}, ttl=${CACHE_TTL_MISSION})`);
}

// ---- Gemini explicit context caching (flag-gated; SESSION_CONTEXT_PLAN Phase 2) ----
// Live-verified mechanism: ai.caches.create() with a 1h TTL, ~2,048-token
// floor, cachedContentTokenCount reports hits. Gateway-side lifecycle only:
// handles keyed by content hash, expired entries recreated, any error falls
// back to the inline path. No daemon state, nothing persisted (B-22 trivial).
const _geminiCaches = new Map(); // hash -> { name, expiresAtMs }

async function getGeminiCachedContent(ai, modelId, systemText, googleTools) {
  const toolsJson = googleTools ? JSON.stringify(googleTools) : '';
  const hash = createHash('sha256').update(`${modelId}\n${systemText}\n${toolsJson}`).digest('hex').substring(0, 16);
  const now = Date.now();
  const hit = _geminiCaches.get(hash);
  if (hit && hit.expiresAtMs > now + 60_000) return hit.name;
  if (estimateTokens(systemText) < 2048) return null; // sub-floor: provider would decline
  const cache = await ai.caches.create({
    model: modelId,
    config: {
      systemInstruction: systemText,
      ...(googleTools ? { tools: googleTools } : {}),
      ttl: `${GEMINI_CACHE_TTL_S}s`,
    },
  });
  _geminiCaches.set(hash, { name: cache.name, expiresAtMs: now + GEMINI_CACHE_TTL_S * 1000 });
  console.log(`[loop] gemini explicit cache created: ${cache.name} (≈${estimateTokens(systemText)}tok, ttl=${GEMINI_CACHE_TTL_S}s)`);
  return cache.name;
}

/**
 * Execute tool-calling loop using Google GenAI SDK.
 */
async function runGoogleTurnSync({ modelId, systemPrompt, systemBlocks, messages, tools, maxSteps, maxTokens = 8192, temperature = 0.3, topP = 0.95 }) {
  const ai = getGoogleClient();
  const localHistory = [...messages];
  let step = 0;
  let text = '';
  let finalFinishReason = 'stop';
  const turnToolCalls = [];
  const usageAcc = newUsageAccumulator('vertex-google');

  const googleTools = tools ? [{
    functionDeclarations: Object.values(tools).map(t => ({
      name: t.name,
      description: t.description,
      parameters: toGoogleSchema(t.schema)
    }))
  }] : undefined;

  // Layer D: Inject skill catalog into system prompt for execution agents.
  // Blocks resolve stable-first; Gemini receives one joined string either way.
  const sysBlocks = resolveSystemBlocks(systemBlocks, systemPrompt, tools ? getSkillCatalog() : '');
  const systemText = sysBlocks.join('\n\n');

  // Flag-gated explicit cache for the stable system prefix (+ tools). Any
  // failure degrades to the inline path — caching is never load-bearing.
  let cachedContentName = null;
  if (GEMINI_EXPLICIT_CACHE) {
    try {
      cachedContentName = await getGeminiCachedContent(ai, modelId, systemText, googleTools);
    } catch (e) {
      console.warn(`[loop] gemini explicit cache unavailable (${e.message}) — inline fallback`);
      cachedContentName = null;
    }
  }

  const guard = new LoopGuard();

  while (step < maxSteps) {
    const googleMessages = convertMessagesToGoogle(localHistory);

    console.log(`[loop] Calling Google Gemini ${modelId} (step ${step}/${maxSteps})...`);
    const response = await retryWithBackoff(
      () => ai.models.generateContent({
        model: modelId,
        contents: googleMessages,
        config: {
          ...(cachedContentName
            ? { cachedContent: cachedContentName }
            : { systemInstruction: systemText, tools: googleTools }),
          temperature,
          maxOutputTokens: maxTokens,
          topP,
        }
      }),
      `Google ${modelId} step ${step}`
    );

    addGoogleUsage(usageAcc, response.usageMetadata);

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const stepText = parts.find(p => p.text)?.text || '';
    if (stepText) {
      text += stepText;
    }

    const stepCalls = parts
      .filter(p => p.functionCall)
      .map(p => ({
        id: p.functionCall.name + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        name: p.functionCall.name,
        args: p.functionCall.args
      }));

    if (stepCalls.length === 0) {
      finalFinishReason = candidate?.finishReason || 'stop';
      break;
    }

    console.log(`[loop] Google model returned ${stepCalls.length} tool call(s):`, stepCalls.map(tc => tc.name));

    // Serialize parallel tool calls: execute only the first, discard the rest.
    // Gemini may return N function calls in one turn, but the Vertex API throws
    // 400 "function response parts != function call parts" if any execution
    // fails or the history reconstruction drifts. Executing one at a time is
    // safer and the model will re-issue remaining calls on subsequent turns.
    if (stepCalls.length > 1) {
      console.log(`[loop] Serializing: executing only first of ${stepCalls.length} parallel tool calls`);
      stepCalls.length = 1;
    }

    localHistory.push({
      role: 'assistant',
      content: stepText || null,
      toolCalls: stepCalls.map(sc => ({
        id: sc.id,
        toolName: sc.name,
        args: sc.args
      }))
    });

    for (const sc of stepCalls) {
      const tool = tools[sc.name];
      let toolResult;

      if (tool) {
        try {
          console.log(`[loop] Executing tool ${sc.name} with args:`, JSON.stringify(sc.args));
          const execution = await tool.execute(sc.args);
          toolResult = execution.result !== undefined ? execution.result : (execution.error || JSON.stringify(execution));
        } catch (err) {
          toolResult = `ERROR: ${err.message}`;
        }
      } else {
        toolResult = `ERROR: Tool "${sc.name}" not found in registry`;
      }

      turnToolCalls.push({
        id: sc.id,
        toolName: sc.name,
        args: sc.args,
        result: toolResult
      });

      localHistory.push({
        role: 'tool',
        name: sc.name,
        id: sc.id,
        content: toolResult
      });

      // Loop guard: detect stuck loops
      const guardResult = guard.check(sc.name, sc.args, toolResult);
      if (guardResult.action === 'terminate') {
        console.log(`[loop] Loop guard: TERMINATING — ${guardResult.message}`);
        text += `\n\n${guardResult.message}`;
        step = maxSteps;
        break;
      }
      if (guardResult.action === 'nudge') {
        console.log(`[loop] Loop guard: nudge injected`);
        localHistory.push({ role: 'user', content: guardResult.message });
      }

      // Phase 4.10: Terminal tool execution checks (report_pass/report_fail/request_probe)
      if (sc.name === 'report_pass' || sc.name === 'report_fail' || sc.name === 'request_probe') {
        console.log(`[loop] Terminal tool ${sc.name} executed. Exiting turn loop.`);
        step = maxSteps;
        break;
      }
    }

    step++;
  }

  // Append ground-truth tool execution log — cannot be fabricated by the LLM
  if (turnToolCalls.length > 0) {
    const toolLog = turnToolCalls.map(tc =>
      `[TOOL] ${tc.toolName}(${JSON.stringify(tc.args).substring(0, argLogCap(tc.toolName))}) → ${(
        typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)
      ).substring(0, 500)}`
    ).join('\n');
    text += `\n\n---\n[TOOL EXECUTION LOG]\n${toolLog}\n[END TOOL LOG]`;

    // Detect tool errors that motor may have masked as SUCCESS
    const hasToolErrors = turnToolCalls.some(tc =>
      typeof tc.result === 'string' && tc.result.startsWith('ERROR:'));
    if (hasToolErrors && /SUCCESS/i.test(text)) {
      text += '\n[WARNING: One or more tool calls returned errors. Verify status accuracy.]';
    }
  }

  return {
    text,
    toolCalls: turnToolCalls,
    usage: finalizeUsage(usageAcc),
    finishReason: finalFinishReason,
  };
}

/**
 * Execute tool-calling loop using Anthropic Messages SDK.
 */
async function runAnthropicTurnSync({ modelId, systemPrompt, systemBlocks, messages, tools, maxSteps, maxTokens = 8192, temperature = 0.3, topP = 0.95, agentId = '', sessionCacheBoundary = 0 }) {
  const client = getAnthropicClient();
  const localHistory = [...messages];
  let step = 0;
  let text = '';
  let finalFinishReason = 'stop';
  const turnToolCalls = [];
  const usageAcc = newUsageAccumulator('vertex-anthropic');

  const anthropicTools = tools ? Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  })) : undefined;

  // Layer D: Inject skill catalog into system prompt for execution agents.
  // Blocks resolve stable-first; MEMORY.md (volatile) rides the second block
  // so its writes stop re-keying the stable prefix (SESSION_CONTEXT_PLAN Phase 2).
  const sysBlocks = resolveSystemBlocks(systemBlocks, systemPrompt, tools ? getSkillCatalog() : '');

  const promptCachingEnabled = CONTRACTS.vertex?.anthropic_prompt_caching === true;
  // BP1 (1h TTL, live-verified) on the stable first block only. Later system
  // blocks (MEMORY.md) stay uncached — their churn is the reason they're last.
  const systemPayload = promptCachingEnabled
    ? sysBlocks.map((text, i) => (i === 0
        ? { type: 'text', text, cache_control: cacheControl(CACHE_TTL_STABLE) }
        : { type: 'text', text }))
    : sysBlocks.join('\n');

  // Session affinity: keep consecutive brain loops on the same backend so
  // cache reads actually hit (live verification: required on load-balanced
  // Vertex endpoints). Stable per agent route per gateway process.
  const requestOptions = SESSION_AFFINITY_ENABLED
    ? { headers: { 'X-Vertex-Ai-Session-Id': `brain-${agentId || 'agent'}-${process.pid}` } }
    : undefined;

  const guard = new LoopGuard();

  while (step < maxSteps) {
    const anthropicMessages = convertMessagesToAnthropic(localHistory);
    if (promptCachingEnabled && MSG_BREAKPOINTS_ENABLED) {
      // On a session continue the frozen transcript prefix is what to cache
      // (one rolling breakpoint at its boundary); otherwise use the Phase-2
      // tier layout on the first user message.
      if (sessionCacheBoundary > 0) {
        applySessionBoundaryBreakpoint(anthropicMessages, sessionCacheBoundary);
      } else {
        applyMessageBreakpoints(anthropicMessages, { systemBreakpointsUsed: 1 });
      }
    }

    console.log(`[loop] Calling Anthropic Claude ${modelId} (step ${step}/${maxSteps})...`);
    const response = await retryWithBackoff(
      async () => {
        // Use streaming to avoid the Anthropic SDK's 10-minute non-streaming
        // timeout. stream().finalMessage() returns the same Message object as
        // create() once the full response is collected.
        // Note: Claude Opus 4.6+ rejects requests with both temperature and
        // top_p. Only send temperature.
        const stream = client.messages.stream({
          model: modelId,
          max_tokens: maxTokens,
          system: systemPayload,
          messages: anthropicMessages,
          tools: anthropicTools,
          temperature,
        }, requestOptions);
        return await stream.finalMessage();
      },
      `Anthropic ${modelId} step ${step}`
    );

    addAnthropicUsage(usageAcc, response.usage);

    const textBlock = response.content.find(b => b.type === 'text');
    const stepText = textBlock ? textBlock.text : '';
    if (stepText) {
      text += stepText;
    }

    const stepCalls = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        name: b.name,
        args: b.input
      }));

    if (stepCalls.length === 0) {
      finalFinishReason = response.stop_reason || 'stop';
      break;
    }

    console.log(`[loop] Anthropic model returned ${stepCalls.length} tool call(s):`, stepCalls.map(tc => tc.name));

    // Serialize parallel tool calls (same rationale as Google path)
    if (stepCalls.length > 1) {
      console.log(`[loop] Serializing: executing only first of ${stepCalls.length} parallel tool calls`);
      stepCalls.length = 1;
    }

    localHistory.push({
      role: 'assistant',
      content: stepText || null,
      toolCalls: stepCalls.map(sc => ({
        id: sc.id,
        toolName: sc.name,
        args: sc.args
      }))
    });

    for (const sc of stepCalls) {
      const tool = tools[sc.name];
      let toolResult;

      if (tool) {
        try {
          console.log(`[loop] Executing tool ${sc.name} with args:`, JSON.stringify(sc.args));
          const execution = await tool.execute(sc.args);
          toolResult = execution.result !== undefined ? execution.result : (execution.error || JSON.stringify(execution));
        } catch (err) {
          toolResult = `ERROR: ${err.message}`;
        }
      } else {
        toolResult = `ERROR: Tool "${sc.name}" not found in registry`;
      }

      turnToolCalls.push({
        id: sc.id,
        toolName: sc.name,
        args: sc.args,
        result: toolResult
      });

      localHistory.push({
        role: 'tool',
        name: sc.name,
        id: sc.id,
        content: toolResult
      });

      // Loop guard: detect stuck loops
      const guardResult = guard.check(sc.name, sc.args, toolResult);
      if (guardResult.action === 'terminate') {
        console.log(`[loop] Loop guard: TERMINATING — ${guardResult.message}`);
        text += `\n\n${guardResult.message}`;
        step = maxSteps;
        break;
      }
      if (guardResult.action === 'nudge') {
        console.log(`[loop] Loop guard: nudge injected`);
        localHistory.push({ role: 'user', content: guardResult.message });
      }

      // Phase 4.10: Terminal tool execution checks (report_pass/report_fail/request_probe)
      if (sc.name === 'report_pass' || sc.name === 'report_fail' || sc.name === 'request_probe') {
        console.log(`[loop] Terminal tool ${sc.name} executed. Exiting turn loop.`);
        step = maxSteps;
        break;
      }
    }

    step++;
  }

  // Append ground-truth tool execution log — cannot be fabricated by the LLM
  if (turnToolCalls.length > 0) {
    const toolLog = turnToolCalls.map(tc =>
      `[TOOL] ${tc.toolName}(${JSON.stringify(tc.args).substring(0, argLogCap(tc.toolName))}) → ${(
        typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)
      ).substring(0, 500)}`
    ).join('\n');
    text += `\n\n---\n[TOOL EXECUTION LOG]\n${toolLog}\n[END TOOL LOG]`;

    // Detect tool errors that motor may have masked as SUCCESS
    const hasToolErrors = turnToolCalls.some(tc =>
      typeof tc.result === 'string' && tc.result.startsWith('ERROR:'));
    if (hasToolErrors && /SUCCESS/i.test(text)) {
      text += '\n[WARNING: One or more tool calls returned errors. Verify status accuracy.]';
    }
  }

  return {
    text,
    toolCalls: turnToolCalls,
    usage: finalizeUsage(usageAcc),
    finishReason: finalFinishReason,
  };
}

/**
 * Unified non-streaming agent turn.
 */
export async function runAgentTurnSync({
  modelString,
  systemPrompt,
  systemBlocks,
  messages,
  tools,
  maxSteps = 12,
  maxTokens = 8192,
  temperature = 0.3,
  topP = 0.95,
  agentId = '',
  sessionCacheBoundary = 0,
}) {
  const { prefix, modelId } = parseModel(modelString);

  if (prefix === 'vertex-anthropic') {
    return await runAnthropicTurnSync({ modelId, systemPrompt, systemBlocks, messages, tools, maxSteps, maxTokens, temperature, topP, agentId, sessionCacheBoundary });
  } else {
    // Google path: the replayed transcript is a byte-stable prefix, so implicit
    // caching rewards it without explicit breakpoints (no cortex on Gemini
    // today anyway — this is the cross-provider fallback path).
    return await runGoogleTurnSync({ modelId, systemPrompt, systemBlocks, messages, tools, maxSteps, maxTokens, temperature, topP });
  }
}

/**
 * Wrapper with fallback chain.
 */
export async function runAgentTurnSyncWithFallback(opts) {
  try {
    return await runAgentTurnSync(opts);
  } catch (err) {
    if (opts.fallbackModel && opts.fallbackModel !== opts.modelString) {
      // Cross-provider fallback re-runs the whole turn: the failed primary
      // attempt's tokens are already billed but its usage object is lost with
      // the throw — the event itself is the double-spend telemetry signal.
      console.warn(`[loop] TELEMETRY fallback_turn primary=${opts.modelString} fallback=${opts.fallbackModel} error="${String(err.message).substring(0, 160)}"`);
      return await runAgentTurnSync({ ...opts, modelString: opts.fallbackModel });
    }
    throw err;
  }
}
