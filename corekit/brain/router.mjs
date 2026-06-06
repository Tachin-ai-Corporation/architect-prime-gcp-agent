// corekit/brain/router.mjs — Direct Vendor SDK Client Router
//
// Initializes and exposes direct Google GenAI and Anthropic Vertex client instances.
// Removes Vercel AI SDK wrappers entirely.

import { GoogleGenAI } from '@google/genai';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

let _googleClient = null;
let _anthropicClient = null;
let _config = {};

/**
 * Initialize direct client SDKs with GCP project and locations.
 */
export async function initRouter({ project, googleLocation = 'us-central1', anthropicLocation = 'us-east5' }) {
  _config = { project, googleLocation, anthropicLocation };

  _googleClient = new GoogleGenAI({
    vertexai: true,
    project,
    location: googleLocation,
  });

  try {
    _anthropicClient = new AnthropicVertex({
      projectId: project,
      region: anthropicLocation,
    });
  } catch (err) {
    console.warn('[router] AnthropicVertex client initialization failed:', err.message);
    _anthropicClient = null;
  }

  console.log(`[router] Initialized: project=${project} google=${googleLocation} anthropic=${anthropicLocation}`);
}

export function getGoogleClient() {
  if (!_googleClient) throw new Error('[router] Router not initialized or GoogleGenAI not available');
  return _googleClient;
}

export function getAnthropicClient() {
  if (!_anthropicClient) throw new Error('[router] Router not initialized or AnthropicVertex not available');
  return _anthropicClient;
}

/**
 * Parses model string to identify the prefix and model ID.
 */
export function parseModel(modelString) {
  if (!modelString.includes('/')) {
    return { prefix: 'vertex-google', modelId: modelString };
  }
  const slashIdx = modelString.indexOf('/');
  const prefix = modelString.slice(0, slashIdx);
  const modelId = modelString.slice(slashIdx + 1);
  return { prefix, modelId };
}

/**
 * Check which providers are available.
 */
export function getProviderStatus() {
  return {
    'vertex-google': { available: !!_googleClient, location: _config.googleLocation },
    'vertex-anthropic': { available: !!_anthropicClient, location: _config.anthropicLocation },
  };
}
