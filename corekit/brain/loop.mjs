// corekit/brain/loop.mjs — Agent Inference Loop
//
// Core inference loop using direct client SDKs for Google and Anthropic.
// Resolves the model, performs turns, executes tools, and returns the result.

import { getGoogleClient, getAnthropicClient, parseModel } from './router.mjs';
import { toGoogleSchema } from './tools.mjs';
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

// ---- Loop guard: detect stuck tool-calling loops ----
const DUPLICATE_NUDGE = 3;
const DUPLICATE_TERMINATE = 5;
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
const SKILLS_DIR = process.env.SKILLS_DIR || '/opt/corekit/skills';

function buildSkillCatalogPrompt() {
  if (!existsSync(SKILLS_DIR)) return '';
  const entries = [];
  try {
    for (const name of readdirSync(SKILLS_DIR)) {
      const jsonPath = `${SKILLS_DIR}/${name}/skill.json`;
      if (!existsSync(jsonPath)) continue;
      try {
        const m = JSON.parse(readFileSync(jsonPath, 'utf8'));
        entries.push(`- ${m.name || name} (${m.id || name}): ${m.when_to_use || m.description || ''}`);
      } catch {}
    }
  } catch {}
  if (entries.length === 0) return '';
  return `\n\n## Available Skills\nBefore using any command tool, read the relevant SKILL.md:\n${entries.map(e => {
    const id = e.match(/- .*?\(([^)]+)\)/)?.[1] || '';
    return `${e}\n  → readFile ${SKILLS_DIR}/${id}/SKILL.md`;
  }).join('\n')}\n\nDo NOT guess skill paths. Only the paths listed above exist.\n`;
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

    // Regular text messages
    const role = msg.role === 'assistant' ? 'model' : 'user';
    result.push({
      role,
      parts: [{ text: msg.content || '' }]
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

    return {
      role,
      content: msg.content || ''
    };
  });
}

/**
 * Execute tool-calling loop using Google GenAI SDK.
 */
async function runGoogleTurnSync({ modelId, systemPrompt, messages, tools, maxSteps, maxTokens = 8192, temperature = 0.3, topP = 0.95 }) {
  const ai = getGoogleClient();
  const localHistory = [...messages];
  let step = 0;
  let text = '';
  let finalFinishReason = 'stop';
  const turnToolCalls = [];

  const googleTools = tools ? [{
    functionDeclarations: Object.values(tools).map(t => ({
      name: t.name,
      description: t.description,
      parameters: toGoogleSchema(t.schema)
    }))
  }] : undefined;

  // Layer D: Inject skill catalog into system prompt for execution agents
  if (tools) {
    const catalog = getSkillCatalog();
    if (catalog) systemPrompt = systemPrompt + catalog;
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
          systemInstruction: systemPrompt,
          tools: googleTools,
          temperature,
          maxOutputTokens: maxTokens,
          topP,
        }
      }),
      `Google ${modelId} step ${step}`
    );

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
    }

    step++;
  }

  // Append ground-truth tool execution log — cannot be fabricated by the LLM
  if (turnToolCalls.length > 0) {
    const toolLog = turnToolCalls.map(tc =>
      `[TOOL] ${tc.toolName}(${JSON.stringify(tc.args).substring(0, 200)}) → ${(
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
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: finalFinishReason,
  };
}

/**
 * Execute tool-calling loop using Anthropic Messages SDK.
 */
async function runAnthropicTurnSync({ modelId, systemPrompt, messages, tools, maxSteps, maxTokens = 8192, temperature = 0.3, topP = 0.95 }) {
  const client = getAnthropicClient();
  const localHistory = [...messages];
  let step = 0;
  let text = '';
  let finalFinishReason = 'stop';
  const turnToolCalls = [];

  const anthropicTools = tools ? Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema
  })) : undefined;

  // Layer D: Inject skill catalog into system prompt for execution agents
  if (tools) {
    const catalog = getSkillCatalog();
    if (catalog) systemPrompt = systemPrompt + catalog;
  }

  const guard = new LoopGuard();

  while (step < maxSteps) {
    const anthropicMessages = convertMessagesToAnthropic(localHistory);

    // CP9: Prompt caching — structure system as content block with cache_control if enabled
    const promptCachingEnabled = CONTRACTS.vertex?.anthropic_prompt_caching === true;
    const systemPayload = promptCachingEnabled
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;

    console.log(`[loop] Calling Anthropic Claude ${modelId} (step ${step}/${maxSteps})...`);
    const response = await retryWithBackoff(
      () => client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPayload,
        messages: anthropicMessages,
        tools: anthropicTools,
        temperature,
        top_p: topP,
      }),
      `Anthropic ${modelId} step ${step}`
    );

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
    }

    step++;
  }

  // Append ground-truth tool execution log — cannot be fabricated by the LLM
  if (turnToolCalls.length > 0) {
    const toolLog = turnToolCalls.map(tc =>
      `[TOOL] ${tc.toolName}(${JSON.stringify(tc.args).substring(0, 200)}) → ${(
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
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: finalFinishReason,
  };
}

/**
 * Unified non-streaming agent turn.
 */
export async function runAgentTurnSync({
  modelString,
  systemPrompt,
  messages,
  tools,
  maxSteps = 12,
  maxTokens = 8192,
  temperature = 0.3,
  topP = 0.95,
}) {
  const { prefix, modelId } = parseModel(modelString);

  if (prefix === 'vertex-anthropic') {
    return await runAnthropicTurnSync({ modelId, systemPrompt, messages, tools, maxSteps, maxTokens, temperature, topP });
  } else {
    return await runGoogleTurnSync({ modelId, systemPrompt, messages, tools, maxSteps, maxTokens, temperature, topP });
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
      console.warn(`[loop] primary model failed (${err.message}), trying fallback: ${opts.fallbackModel}`);
      return await runAgentTurnSync({ ...opts, modelString: opts.fallbackModel });
    }
    throw err;
  }
}
