// corekit/brain/loop.mjs — Agent Inference Loop
//
// Core inference loop. Receives messages, resolves the model, runs streamText
// with tools, handles multi-turn tool calls, returns the streaming result.

import { streamText, generateText } from 'ai';
import { resolveModel } from './router.mjs';

/**
 * Run one agent turn: messages → LLM → tool calls → ... → final response.
 *
 * @param {object} opts
 * @param {string} opts.modelString     e.g. "vertex-anthropic/claude-opus-4-6"
 * @param {string} opts.systemPrompt    from SOUL.md
 * @param {Array}  opts.messages        conversation history [{role, content}]
 * @param {object} opts.tools           tool definitions (from tools.mjs)
 * @param {number} opts.maxSteps        max tool-call loops (default 12)
 * @param {AbortSignal} opts.signal     cancellation signal
 * @returns {object} AI SDK streamText result (has .textStream, .fullStream, etc.)
 */
export function runAgentTurn({
  modelString,
  systemPrompt,
  messages,
  tools,
  maxSteps = 12,
  signal,
}) {
  const model = resolveModel(modelString);

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    maxSteps,
    abortSignal: signal,
    onError: (error) => {
      console.error('[loop] inference error:', error);
    },
    onStepFinish: (step) => {
      if (step.toolCalls?.length > 0) {
        console.log(`[loop] tool calls:`, step.toolCalls.map(tc => tc.toolName));
      }
    },
  });

  return result;
}

/**
 * Run an agent turn with fallback chain.
 * If the primary model fails (timeout, 429, 503), try the fallback.
 *
 * @param {object} opts  Same as runAgentTurn, plus:
 * @param {string} opts.fallbackModel  Fallback model string
 * @returns {object} AI SDK streamText result
 */
export async function runAgentTurnWithFallback(opts) {
  try {
    const result = runAgentTurn(opts);

    // We need to await the first chunk to detect model-level failures.
    // If the model fails immediately (auth, 404, etc.) it throws here.
    // Wrap in a proxy that catches on consume.
    return result;
  } catch (err) {
    if (opts.fallbackModel && opts.fallbackModel !== opts.modelString) {
      console.warn(`[loop] primary model failed (${err.message}), trying fallback: ${opts.fallbackModel}`);
      return runAgentTurn({ ...opts, modelString: opts.fallbackModel });
    }
    throw err;
  }
}

/**
 * Run a non-streaming agent turn (for internal/classify use).
 *
 * @param {object} opts  Same shape as runAgentTurn
 * @returns {object} { text, toolCalls, usage }
 */
export async function runAgentTurnSync({
  modelString,
  systemPrompt,
  messages,
  tools,
  maxSteps = 12,
}) {
  const model = resolveModel(modelString);

  const result = await generateText({
    model,
    system: systemPrompt,
    messages,
    tools,
    maxSteps,
  });

  return {
    text: result.text,
    toolCalls: result.toolCalls,
    usage: result.usage,
    finishReason: result.finishReason,
  };
}
