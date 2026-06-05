// corekit/brain/test/vertex-probe.mjs
//
// Smoke test: Verify all Vertex AI provider paths work from this GCE VM.
//
// Run:   node --test corekit/brain/test/vertex-probe.mjs
// Env:   GOOGLE_CLOUD_PROJECT  (required — GCP project ID)
//        GOOGLE_CLOUD_LOCATION (optional — defaults to "us-central1")
//
// Expects GCE metadata ADC to be available (running on a Compute Engine VM
// with a service account that has Vertex AI User role).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

if (!project) {
  console.error('ERROR: GOOGLE_CLOUD_PROJECT env var is required');
  process.exit(1);
}

console.log(`[vertex-probe] project=${project} location=${location}`);

describe('Vertex AI provider smoke tests', () => {

  it('Google (Gemini 2.5 Flash) via createVertex', async () => {
    const vertex = createVertex({ project, location });
    const { text } = await generateText({
      model: vertex('gemini-2.5-flash'),
      prompt: 'Reply with exactly the text: VERTEX_GOOGLE_OK',
      maxTokens: 20,
    });
    console.log(`  Gemini response: "${text.trim()}"`);
    assert.ok(text.includes('VERTEX_GOOGLE_OK'), `Expected VERTEX_GOOGLE_OK, got: ${text}`);
  });

  it('Anthropic (Claude Haiku 4.5) via createVertexAnthropic', async () => {
    // Dynamic import — same pattern as router.mjs
    const { createVertexAnthropic } = await import('@ai-sdk/google-vertex/anthropic');
    const anthropic = createVertexAnthropic({ project, location });
    const { text } = await generateText({
      model: anthropic('claude-haiku-4-5'),
      prompt: 'Reply with exactly the text: VERTEX_ANTHROPIC_OK',
      maxTokens: 20,
    });
    console.log(`  Claude response: "${text.trim()}"`);
    assert.ok(text.includes('VERTEX_ANTHROPIC_OK'), `Expected VERTEX_ANTHROPIC_OK, got: ${text}`);
  });

});
