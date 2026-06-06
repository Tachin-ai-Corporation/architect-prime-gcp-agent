// corekit/brain/loop.mjs — Agent Inference Loop
//
// Core inference loop using direct client SDKs for Google and Anthropic.
// Resolves the model, performs turns, executes tools, and returns the result.

import { getGoogleClient, getAnthropicClient, parseModel } from './router.mjs';
import { toGoogleSchema } from './tools.mjs';

/**
 * Convert standard message history to Google Contents API format.
 */
function convertMessagesToGoogle(messages) {
  return messages.map(msg => {
    // System messages are handled as systemInstruction, not in contents list.
    // Map roles: 'assistant' -> 'model', 'system'/'tool'/'user' -> 'user'
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'model',
        parts: msg.toolCalls.map(tc => ({
          functionCall: {
            name: tc.toolName || tc.name,
            args: tc.args,
          }
        }))
      };
    }

    if (msg.role === 'tool') {
      return {
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolName || msg.name,
            response: typeof msg.content === 'object' ? msg.content : { result: msg.content }
          }
        }]
      };
    }

    return {
      role,
      parts: [{ text: msg.content || '' }]
    };
  });
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
async function runGoogleTurnSync({ modelId, systemPrompt, messages, tools, maxSteps }) {
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

  while (step < maxSteps) {
    const googleMessages = convertMessagesToGoogle(localHistory);

    console.log(`[loop] Calling Google Gemini ${modelId} (step ${step}/${maxSteps})...`);
    const response = await ai.models.generateContent({
      model: modelId,
      contents: googleMessages,
      config: {
        systemInstruction: systemPrompt,
        tools: googleTools,
        temperature: 0.2,
      }
    });

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
    }

    step++;
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
async function runAnthropicTurnSync({ modelId, systemPrompt, messages, tools, maxSteps }) {
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

  while (step < maxSteps) {
    const anthropicMessages = convertMessagesToAnthropic(localHistory);

    console.log(`[loop] Calling Anthropic Claude ${modelId} (step ${step}/${maxSteps})...`);
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools: anthropicTools,
    });

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
    }

    step++;
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
}) {
  const { prefix, modelId } = parseModel(modelString);

  if (prefix === 'vertex-anthropic') {
    return await runAnthropicTurnSync({ modelId, systemPrompt, messages, tools, maxSteps });
  } else {
    return await runGoogleTurnSync({ modelId, systemPrompt, messages, tools, maxSteps });
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
