// tests/vertex-text-schema.test.mjs — enforceSchema/normalizeDecision regression
// coverage for the classify-decision-loss defect: cortex responses that carry
// the real classification under "type" (or bare under "action") were being
// silently reduced to classification=undefined, which downstream code
// defaults to 'new_mission' — creating a duplicate mission instead of
// resuming a needs_input/blocked one. Root cause was two compounding bugs:
// (1) no type/action→classification alias existed (unlike attach_to_mission,
// continue_to, etc.), and (2) the fast-exit re-parsed raw JSON fresh and
// checked bare `action` truthiness, which is always true for classify since
// "action" is just the echoed mode marker ("action":"classify").
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVertexText } from '../platform/providers/vertex-text.mjs';

const vtx = createVertexText({ projectId: 'test', location: 'us-central1', model: 'test-model' });
// Bounded config for cases that intentionally fall through to the network
// coercion path (no valid classify field to fast-exit on) — no real GCP
// credentials exist here, so cap the timeout instead of eating the default
// 15s x 2-attempt budget per test.
const vtxFastFail = createVertexText({
  projectId: 'test', location: 'us-central1', model: 'test-model',
  enforceSchemaTimeoutMs: 1000, enforceSchemaMaxAttempts: 1,
});

describe('enforceSchema: classify — type/action alias (production defect)', () => {
  it('recovers classification from "type" when the model wraps it under "action":"classify"', async () => {
    // The exact shape observed in prod: cortex echoes the mode as action,
    // puts the real decision under type, and correctly identifies the
    // target mission — none of that should be discarded.
    const raw = JSON.stringify({
      action: 'classify',
      type: 'continue',
      continue_mission: 'w-1783885371273-5b7457cd',
      instruction: 'The operator confirms: investigate via Firestore directly.',
      reasoning: 'The user is answering the needs_input question from the prior mission.',
    });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'continue');
    assert.equal(result.continue_mission, 'w-1783885371273-5b7457cd');
  });

  it('recovers classification from a bare "action" when no "type" wrapper is present', async () => {
    const raw = JSON.stringify({
      action: 'new_mission',
      instruction: 'Do the thing',
      reasoning: 'This is unrelated new work.',
    });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'new_mission');
  });

  it('does not alias the literal mode-marker value "classify" itself', async () => {
    // "classify" is not a member of the classification enum — aliasing it
    // would just relabel the bug instead of surfacing it for repair.
    const raw = JSON.stringify({ action: 'classify', reasoning: 'no real decision here' });
    const result = await vtxFastFail.enforceSchema(raw, 'classify');
    assert.notEqual(result.classification, 'classify');
  });

  it('prefers an explicit "classification" over "type"/"action" aliases', async () => {
    const raw = JSON.stringify({
      action: 'classify', type: 'new_mission', classification: 'attach', attach_to: 'w-abc',
      reasoning: 'explicit classification wins',
    });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'attach');
  });

  it('does not leak the classify-only "type" alias into decide schema handling', async () => {
    // Decide's own schema has no "type" field; make sure a stray "type" key
    // on a decide-shaped response can't be misread as a classification.
    const raw = JSON.stringify({
      action: 'checkpoint_plan', type: 'continue', reasoning: 'r',
      checkpoints: [{ instruction: 'i', accept_criteria: 'a', tasks: [{ agent: 'motor', task: 't' }] }],
    });
    const result = await vtx.enforceSchema(raw, 'decide');
    assert.equal(result.action, 'checkpoint_plan');
    assert.equal(result.classification, undefined);
  });
});

describe('enforceSchema: fast-exit no longer trusts bare "action" for classify', () => {
  it('fast-exits immediately once classification is present (no network call)', async () => {
    const raw = JSON.stringify({ classification: 'respond', response: 'hi', reasoning: 'greeting' });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.classification, 'respond');
  });
});

describe('enforceSchema: pre-existing aliases still work (no regressions)', () => {
  it('move → action', async () => {
    const raw = JSON.stringify({
      move: 'checkpoint_plan', reasoning: 'r',
      checkpoints: [{ instruction: 'i', accept_criteria: 'a', tasks: [{ agent: 'motor', task: 't' }] }],
    });
    const result = await vtx.enforceSchema(raw, 'decide');
    assert.equal(result.action, 'checkpoint_plan');
  });

  it('attach_to_mission → attach_to', async () => {
    const raw = JSON.stringify({ classification: 'attach', attach_to_mission: 'w-1', reasoning: 'r' });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.attach_to, 'w-1');
  });

  it('continue_to → continue_mission', async () => {
    const raw = JSON.stringify({ classification: 'continue', continue_to: 'w-2', reasoning: 'r' });
    const result = await vtx.enforceSchema(raw, 'classify');
    assert.equal(result.continue_mission, 'w-2');
  });
});
