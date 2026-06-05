// corekit/brain/test/brain-e2e.mjs
//
// End-to-end test: Start the brain server, send a chat completion request,
// verify the response matches the OpenAI format that agent-brain.mjs expects.
//
// Run:   node --test corekit/brain/test/brain-e2e.mjs
// Env:   GOOGLE_CLOUD_PROJECT (required)
//        GOOGLE_CLOUD_LOCATION (optional, default: us-central1)
//        BRAIN_PORT (optional, default: 19999 for test isolation)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PORT = parseInt(process.env.BRAIN_TEST_PORT || '19999', 10);
const project = process.env.GOOGLE_CLOUD_PROJECT;

if (!project) {
  console.error('ERROR: GOOGLE_CLOUD_PROJECT env var is required');
  process.exit(1);
}

describe('Brain gateway e2e', () => {

  it('GET /healthz returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });

  it('GET /v1/models returns model list (pre-flight check)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'list');
    assert.ok(Array.isArray(data.data));
    console.log('  Models:', data.data.map(m => `${m.id}(${m.location})`).join(', '));
  });

  it('POST /v1/chat/completions returns OpenAI-format response', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'brain/cortex',
        messages: [
          { role: 'system', content: 'You are a test assistant. Reply briefly.' },
          { role: 'user', content: 'Reply with exactly: BRAIN_E2E_OK' },
        ],
        max_tokens: 20,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

    const data = await res.json();
    console.log('  Response:', JSON.stringify(data, null, 2).substring(0, 500));

    // Verify OpenAI-compatible structure
    assert.ok(data.id, 'Response should have id');
    assert.equal(data.object, 'chat.completion');
    assert.ok(Array.isArray(data.choices), 'Response should have choices array');
    assert.ok(data.choices.length > 0, 'Should have at least one choice');

    const choice = data.choices[0];
    assert.equal(choice.message.role, 'assistant');
    assert.ok(typeof choice.message.content === 'string', 'Content should be a string');
    assert.ok(choice.message.content.length > 0, 'Content should not be empty');

    console.log(`  Assistant: "${choice.message.content.substring(0, 100)}"`);
  });

});
