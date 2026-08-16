// test/checkpoint-plan.test.mjs — Unit tests for invalid agent reject guard in checkpoint_plan action
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleCheckpointPlan } from '../platform/runtime/actions/checkpoint_plan.mjs';
import { extractCheckpoints } from '../platform/work/plan-utils.mjs';

// Reusable mock dependencies builder
function createMockDeps() {
  const calls = {
    log: [],
    callAgent: [],
    executeCheckpoints: [],
  };

  const deps = {
    log: (level, msg) => {
      calls.log.push({ level, msg });
    },
    toStr: (val) => String(val),
    callAgent: async (agentId, payload) => {
      calls.callAgent.push({ agentId, payload });
      if (agentId === 'prefrontal') {
        return {
          success: true,
          output: {
            checkpoints: [
              {
                instruction: 'Valid fallback plan',
                tasks: [{ agent: 'motor', task: 'Do fallback' }],
              },
            ],
          },
        };
      }
      return { success: true };
    },
    enforceSchema: async (val, schema) => val,
    formatSkillCatalog: () => 'skills',
    SKILL_INDEX: {},
    extractCheckpoints,
    executeCheckpoints: async (checkpoints, opts) => {
      calls.executeCheckpoints.push(checkpoints);
      return { success: true, results: [] };
    },
    PROJECTS: {},
    addressFromMeta: () => {},
    summarizeForDelivery: () => '',
    smartSummarize: () => '',
    getAuthToken: () => '',
    FIRESTORE_BASE: 'mock',
    PRIME_ID: 'mock',
    AGENT_EMAIL: 'mock',
    AGENT_ID: 'mock',
    CORE_DIR: '.',
    CTX_AGENT_STEP: 'mock',
    CTX_DISPATCH_FAILURE: 'mock',
    CONTRACTS: {},
    writeHistory: async () => {},
    firestoreWrite: async () => {},
    firestoreRead: async () => {},
    firestoreQuery: async () => [],
    generateId: () => 'id123',
    REGISTRY: { agents: {} },
    buildProjectContext: () => '',
  };

  return { deps, calls };
}

describe('checkpoint_plan Invalid Agent Reject Guard', () => {
  it('accepts cortex inline plans with only valid agents', async () => {
    const { deps, calls } = createMockDeps();
    const ctx = {
      envelope: { id: 'm-123', instruction: 'Do the task' },
      decision: {
        checkpoints: [
          {
            instruction: 'Checkpoint 1',
            tasks: [
              { agent: 'motor', task: 'Run commands' },
              { agent: 'temporal-research', task: 'Search web' },
            ],
          },
        ],
      },
      priorResults: [],
      iteration: 1,
      _tokenUsage: { totalInput: 0, totalOutput: 0, totalCached: 0, callCount: 0 },
    };

    const res = await handleCheckpointPlan(ctx, deps);

    // Verify it executed the inline checkpoints directly without calling prefrontal
    assert.equal(calls.callAgent.length, 0, 'should not dispatch to prefrontal');
    assert.equal(calls.executeCheckpoints.length, 1, 'should execute inline checkpoints');
    assert.deepStrictEqual(calls.executeCheckpoints[0][0].tasks.map(t => t.agent), ['motor', 'temporal-research']);
    assert.ok(res.continue);
  });

  it('rejects cortex inline plans containing invalid agents and falls back to prefrontal structuring', async () => {
    const { deps, calls } = createMockDeps();
    const ctx = {
      envelope: { id: 'm-123', instruction: 'Do the task' },
      decision: {
        checkpoints: [
          {
            instruction: 'Checkpoint 1',
            tasks: [
              { agent: 'motor', task: 'Run commands' },
              { agent: 'cerebellum', task: 'Verify something' }, // Invalid agent
            ],
          },
        ],
      },
      priorResults: [],
      iteration: 1,
      _tokenUsage: { totalInput: 0, totalOutput: 0, totalCached: 0, callCount: 0 },
    };

    const res = await handleCheckpointPlan(ctx, deps);

    // Verify that prefrontal was called because inline checkpoints were rejected
    const prefrontalCalls = calls.callAgent.filter(c => c.agentId === 'prefrontal');
    assert.equal(prefrontalCalls.length, 1, 'should fallback to prefrontal structuring');
    
    // Verify that the fallback checkpoints from prefrontal (which are valid) were executed
    assert.equal(calls.executeCheckpoints.length, 1, 'should execute prefrontal checkpoints');
    assert.deepStrictEqual(calls.executeCheckpoints[0][0].tasks.map(t => t.agent), ['motor'], 'should execute valid fallback plan');
    assert.ok(res.continue);

    // Verify warning log was emitted
    const warnLogs = calls.log.filter(l => l.level === 'WARN' && l.msg.includes("Cortex inline plan contains invalid agent 'cerebellum'"));
    assert.equal(warnLogs.length, 1, 'should log a warning about rejecting the invalid agent');
  });
});
