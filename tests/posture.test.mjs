// tests/posture.test.mjs — capability posture (C-37) resolution + per-agent assignment.
//
// Covers the declarative per-agent override added so a specific fleet agent can be raised
// to a stronger posture via the fleet definition (contracts.posture_assignments.agents)
// instead of a per-VM AGENT_POSTURE env hack. Precedence: env > agent assignment > role default.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentPosture, applyPosture, withPosture } from '../platform/contracts/posture.mjs';

const CONTRACTS = {
  vertex: { strong_model_agents: [] },
  brain: { max_iterations: 25 },
  postures: {
    strict: {},
    focused: {
      vertex: { strong_model_agents: ['prefrontal', 'motor', 'cerebellum'] },
      brain: { max_iterations: 10 },
    },
    unbound: {
      vertex: { strong_model_agents: ['prefrontal', 'motor', 'cerebellum'] },
      brain: { max_iterations: 40 },
    },
  },
  posture_assignments: { agents: { millie: 'unbound' } },
};

describe('agentPosture — resolution precedence', () => {
  it('defaults by role (prime=unbound, fleet=strict)', () => {
    assert.equal(agentPosture(CONTRACTS, { isPrime: true, env: {} }), 'unbound');
    assert.equal(agentPosture(CONTRACTS, { isPrime: false, env: {} }), 'strict');
  });
  it('honors a per-agent assignment for a fleet agent', () => {
    assert.equal(agentPosture(CONTRACTS, { isPrime: false, agentId: 'millie', env: {} }), 'unbound');
  });
  it('leaves an unassigned fleet agent strict', () => {
    assert.equal(agentPosture(CONTRACTS, { isPrime: false, agentId: 'stan', env: {} }), 'strict');
  });
  it('AGENT_POSTURE env overrides both assignment and role', () => {
    assert.equal(agentPosture(CONTRACTS, { isPrime: true, agentId: 'millie', env: { AGENT_POSTURE: 'strict' } }), 'strict');
    assert.equal(agentPosture(CONTRACTS, { isPrime: false, agentId: 'stan', env: { AGENT_POSTURE: 'unbound' } }), 'unbound');
  });
  it('ignores an assignment to a posture that is not defined (typo-safe)', () => {
    const c = { ...CONTRACTS, posture_assignments: { agents: { millie: 'ludicrous' } } };
    assert.equal(agentPosture(c, { isPrime: false, agentId: 'millie', env: {} }), 'strict');
  });
  it('is safe when posture_assignments is absent', () => {
    const c = { postures: CONTRACTS.postures };
    assert.equal(agentPosture(c, { isPrime: false, agentId: 'millie', env: {} }), 'strict');
  });
});

describe('withPosture — overlay application', () => {
  it('an assigned fleet agent gets the unbound overlay (strong models + budgets)', () => {
    const eff = withPosture(CONTRACTS, { isPrime: false, agentId: 'millie', env: {} });
    assert.deepEqual(eff.vertex.strong_model_agents, ['prefrontal', 'motor', 'cerebellum']);
    assert.equal(eff.brain.max_iterations, 40);
  });
  it('focused = strong models AND a tighter-than-baseline budget', () => {
    // The defining invariant of 'focused': strong model tier for synthesis quality, but a
    // budget TIGHTER than base (a thorough strong model over-iterates otherwise) — and it
    // must never silently become 'unbound'.
    const c = { ...CONTRACTS, posture_assignments: { agents: { millie: 'focused' } } };
    const eff = withPosture(c, { isPrime: false, agentId: 'millie', env: {} });
    assert.deepEqual(eff.vertex.strong_model_agents, ['prefrontal', 'motor', 'cerebellum']);
    assert.equal(eff.brain.max_iterations, 10); // tight override — not base 25, not unbound's 40
  });
  it('an unassigned fleet agent stays on the base (strict = empty overlay)', () => {
    const eff = withPosture(CONTRACTS, { isPrime: false, agentId: 'stan', env: {} });
    assert.deepEqual(eff.vertex.strong_model_agents, []);
    assert.equal(eff.brain.max_iterations, 25);
  });
  it('does not mutate the input contracts', () => {
    withPosture(CONTRACTS, { isPrime: false, agentId: 'millie', env: {} });
    assert.deepEqual(CONTRACTS.vertex.strong_model_agents, []);
    assert.equal(CONTRACTS.brain.max_iterations, 25);
  });
});
