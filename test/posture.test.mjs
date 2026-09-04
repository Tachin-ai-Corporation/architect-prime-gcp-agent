// test/posture.test.mjs — capability posture (C-37): pure resolution/overlay + the C-37 guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentPosture, applyPosture, withPosture } from '../platform/contracts/posture.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const contracts = JSON.parse(readFileSync(join(__dir, '../infra/contracts.json'), 'utf8'));

test('agentPosture: role decides by default (prime→unbound, fleet→strict)', () => {
  assert.equal(agentPosture(contracts, { isPrime: true, env: {} }), 'unbound');
  assert.equal(agentPosture(contracts, { isPrime: false, env: {} }), 'strict');
});

test('agentPosture: AGENT_POSTURE env forces the posture (canary / rollback)', () => {
  assert.equal(agentPosture(contracts, { isPrime: false, env: { AGENT_POSTURE: 'unbound' } }), 'unbound');
  assert.equal(agentPosture(contracts, { isPrime: true, env: { AGENT_POSTURE: 'strict' } }), 'strict');
  // a garbage value is ignored — role still decides
  assert.equal(agentPosture(contracts, { isPrime: true, env: { AGENT_POSTURE: 'nonsense' } }), 'unbound');
});

test('strict = the base unchanged (fleet stays on flash, baseline budgets)', () => {
  const out = applyPosture(contracts, 'strict');
  assert.deepEqual(out.vertex.strong_model_agents, []);
  assert.equal(out.dispatch.max_iterations, contracts.dispatch.max_iterations);
  assert.equal(out.brain.max_iterations, contracts.brain.max_iterations);
  assert.equal(out, contracts); // empty overlay returns the base by reference
});

test('unbound = the latitude overlay applied (strong executors + budget headroom)', () => {
  const out = applyPosture(contracts, 'unbound');
  assert.deepEqual(out.vertex.strong_model_agents, ['prefrontal', 'motor', 'cerebellum']);
  assert.equal(out.dispatch.max_iterations, 75);
  assert.equal(out.dispatch.max_delegations_per_checkpoint, 6);
  assert.equal(out.brain.max_iterations, 40);
  // deep merge, not replace: non-overridden siblings survive
  assert.equal(out.dispatch.poll_interval_ms, contracts.dispatch.poll_interval_ms);
  assert.equal(out.vertex.models.subagentStrong, contracts.vertex.models.subagentStrong);
  assert.equal(out.dispatch.context_token_budget, contracts.dispatch.context_token_budget);
});

test('applyPosture is pure — never mutates its argument', () => {
  const before = JSON.stringify(contracts);
  applyPosture(contracts, 'unbound');
  assert.equal(JSON.stringify(contracts), before);
  assert.deepEqual(contracts.vertex.strong_model_agents, []); // base still fleet-strict
});

test('unknown / empty posture returns the base unchanged', () => {
  assert.equal(applyPosture(contracts, 'does-not-exist'), contracts);
  const b = { postures: { x: {} } };
  assert.equal(applyPosture(b, 'x'), b);
});

test('withPosture end-to-end: fleet→flash, prime→strong', () => {
  assert.deepEqual(withPosture(contracts, { isPrime: false, env: {} }).vertex.strong_model_agents, []);
  assert.deepEqual(withPosture(contracts, { isPrime: true, env: {} }).vertex.strong_model_agents,
    ['prefrontal', 'motor', 'cerebellum']);
});

// C-37 GUARD (enforced in code): a posture may carry ONLY enumerated cognitive-latitude knobs —
// never a capability, secret, egress, or state-machine key. Adding a knob is deliberate: extend
// ALLOWED here, which is exactly the review checkpoint C-37 demands. This is what stops a future
// edit from "relaxing" a security wall or an honesty gate under the guise of a posture.
test('C-37: postures carry only allowed latitude knobs (never the spine or the fence)', () => {
  const ALLOWED = new Set([
    'vertex.strong_model_agents',
    'dispatch.max_iterations',
    'dispatch.max_delegations_per_checkpoint',
    'brain.max_iterations',
  ]);
  const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
  for (const [name, overlay] of Object.entries(contracts.postures || {})) {
    for (const path of flatten(overlay)) {
      assert.ok(ALLOWED.has(path),
        `posture '${name}' sets '${path}', not an allowed latitude knob. C-37: a posture may never ` +
        `touch the deterministic spine or the structural fence. Only extend ALLOWED for a genuine ` +
        `cognitive-latitude knob (model tier / budget / sampling).`);
    }
  }
});
