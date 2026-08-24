// Regression: intake claiming must be addressed-only, so a fleet agent can never
// answer a message meant for its managing prime. Intake is prime-scoped and a fleet
// agent's brain runs with PRIME_ID = its managing prime, so both poll the same
// primes/{prime}/intake feed; routing is by source_meta.agentId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentClaimsIntake } from '../platform/work/plan-utils.mjs';

test('prime cortex owns unaddressed and prime-addressed intakes', () => {
  assert.equal(agentClaimsIntake('prime', undefined), true, 'unaddressed → prime is default owner');
  assert.equal(agentClaimsIntake('prime', ''), true);
  assert.equal(agentClaimsIntake('prime', 'prime'), true);
  assert.equal(agentClaimsIntake('prime', 'ftc'), false, 'addressed to a fleet agent → not the prime cortex');
});

test('fleet agent claims ONLY intakes addressed to it (the fix)', () => {
  assert.equal(agentClaimsIntake('ftc', 'ftc'), true);
  assert.equal(agentClaimsIntake('ftc', undefined), false, 'unaddressed must NOT be grabbed by a fleet agent (the bug)');
  assert.equal(agentClaimsIntake('ftc', ''), false);
  assert.equal(agentClaimsIntake('ftc', 'prime'), false, 'a prime-addressed intake is never a fleet agent\'s');
  assert.equal(agentClaimsIntake('ftc', 'millie'), false, 'another agent\'s intake is not mine');
});
