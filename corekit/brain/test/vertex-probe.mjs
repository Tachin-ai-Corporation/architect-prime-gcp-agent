// corekit/brain/test/vertex-probe.mjs
//
// Smoke test: Verify all Vertex AI provider paths work from this GCE VM.
//
// Run:   node --test corekit/brain/test/vertex-probe.mjs
// Env:   GOOGLE_CLOUD_PROJECT  (required — GCP project ID)
//        GOOGLE_CLOUD_LOCATION (optional — defaults to "us-central1")
//

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

if (!project) {
  console.error('ERROR: GOOGLE_CLOUD_PROJECT env var is required');
  process.exit(1);
}

console.log(`[vertex-probe] project=${project} location=${location}`);

describe('Vertex AI provider smoke tests', () => {

  it('Google (Gemini 3.5 Flash) via GoogleGenAI', async () => {
    const google = new GoogleGenAI({ vertexai: true, project, location });
    const response = await google.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: 'Reply with exactly the text: VERTEX_GOOGLE_OK',
      config: {
        maxOutputTokens: 20,
      }
    });
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`  Gemini response: "${text.trim()}"`);
    assert.ok(text.includes('VERTEX_GOOGLE_OK'), `Expected VERTEX_GOOGLE_OK, got: ${text}`);
  });

  it('Anthropic (Claude 3.5 Sonnet) via AnthropicVertex', async () => {
    const anthropic = new AnthropicVertex({ projectId: project, region: location });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet@20240620',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with exactly the text: VERTEX_ANTHROPIC_OK' }],
    });
    const text = response.content?.[0]?.text || '';
    console.log(`  Claude response: "${text.trim()}"`);
    assert.ok(text.includes('VERTEX_ANTHROPIC_OK'), `Expected VERTEX_ANTHROPIC_OK, got: ${text}`);
  });

});
