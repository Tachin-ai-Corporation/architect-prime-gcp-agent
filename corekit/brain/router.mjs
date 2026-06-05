// corekit/brain/router.mjs — Model Router
//
// Resolves a model string like "vertex-google/gemini-3.1-pro-preview" or
// "vertex-anthropic/claude-opus-4-6" to the correct AI SDK model instance
// backed by Vertex AI with native ADC auth.
//
// Supported prefixes:
//   vertex-google/     → Google models (Gemini) via createVertex()
//   vertex-anthropic/  → Anthropic models (Claude) via createVertexAnthropic()
//   vertex-maas/       → MaaS models (Meta, xAI, Mistral) via createVertex()
//   (no prefix)        → treated as vertex-google

import { createVertex } from '@ai-sdk/google-vertex';

let _vertexGoogle, _vertexAnthropic;

/**
 * Initialize the router with GCP project and location.
 * Must be called before resolveModel().
 */
export async function initRouter({ project, location }) {
  _vertexGoogle = createVertex({ project, location });

  // Dynamic import for the anthropic sub-path export.
  // This avoids a hard dependency if the package doesn't include it.
  try {
    const { createVertexAnthropic } = await import('@ai-sdk/google-vertex/anthropic');
    _vertexAnthropic = createVertexAnthropic({ project, location });
  } catch (err) {
    console.warn('[router] @ai-sdk/google-vertex/anthropic not available:', err.message);
    _vertexAnthropic = null;
  }
}

/**
 * Resolve a model string to an AI SDK model instance.
 *
 * @param {string} modelString  e.g. "vertex-anthropic/claude-opus-4-6"
 * @returns {object}  AI SDK model instance ready for generateText/streamText
 * @throws {Error}  If prefix is unknown or provider not initialized
 */
export function resolveModel(modelString) {
  if (!modelString.includes('/')) return _vertexGoogle(modelString);

  const slashIdx = modelString.indexOf('/');
  const prefix = modelString.slice(0, slashIdx);
  const modelId = modelString.slice(slashIdx + 1);

  switch (prefix) {
    case 'vertex-google':
      return _vertexGoogle(modelId);

    case 'vertex-anthropic':
      if (!_vertexAnthropic) {
        throw new Error(`Anthropic provider not available. Cannot resolve: ${modelString}`);
      }
      return _vertexAnthropic(modelId);

    case 'vertex-maas':
      // MaaS models (Meta Llama, xAI Grok, Mistral) go through the Google
      // Vertex provider — they use the generateContent API, not rawPredict.
      return _vertexGoogle(modelId);

    default:
      // Unknown prefix — try as bare model name through Google Vertex
      console.warn(`[router] Unknown prefix "${prefix}", treating as vertex-google: ${modelString}`);
      return _vertexGoogle(modelString);
  }
}

/**
 * Check which providers are available.
 */
export function getProviderStatus() {
  return {
    'vertex-google': !!_vertexGoogle,
    'vertex-anthropic': !!_vertexAnthropic,
  };
}
