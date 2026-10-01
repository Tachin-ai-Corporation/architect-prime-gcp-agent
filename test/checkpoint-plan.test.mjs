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

// 2026-10-01: a weekly briefing's mission passed every checkpoint, then its cortex asked for
// context, read the digested read-back as "truncated", and returned a PLAIN checkpoint_plan.
// With nothing left to re-task, that fell through to full structuring and ran the whole
// mission again — four times, each pass passing. The refusal for re-planning verified work
// only covered an explicit replan_scope:'mission'.
describe('a plan that passed is delivered, not re-planned', () => {
  const READBACK_REF = 'tool_results/tr-1790894607596-c2524ae5';
  const passedSpine = () => [1, 2, 3].map(n => ({ n, outcome: `CP${n}`, accept_criteria: '', tasks: [], status: 'complete' }));
  // What this decide loop holds after the plan passed and the cortex hydrated a task's output.
  const thisRun = () => [
    { agent: 'motor', task: 'Gather', result: 'Saved four transcripts.', success: true, checkpoint_step: '1.1', ref: 'w-task-1' },
    { agent: 'motor', task: 'Write', result: 'Wrote the content JSON.', success: true, checkpoint_step: '2.1', ref: 'w-task-2' },
    {
      agent: 'motor', task: 'Deliver', success: true, checkpoint_step: '3.1', ref: 'w-task-3',
      result: `Created the doc and read it back.\n---\n[TOOL EXECUTION LOG]\n[TOOL] readFile({"path":"readback.txt"}) → [digest of 5336 chars — full result: ${READBACK_REF}]\nSections: Sources, State of the Week…\n[END TOOL LOG]`,
    },
    { agent: 'system', result: '[SYSTEM] All 3 checkpoint(s) PASSED verification — the work is DONE.' },
  ];
  const run = async ({ decision, priorResults, spine = passedSpine(), contracts = {} }) => {
    const { deps, calls } = createMockDeps();
    deps.CONTRACTS = contracts;
    const ctx = {
      envelope: { id: 'm-brief', instruction: 'Produce this week\'s briefing', _cp_spine: spine },
      decision,
      priorResults,
      iteration: 3,
      _tokenUsage: { totalInput: 0, totalOutput: 0, totalCached: 0, totalCacheWrites: 0, callCount: 0 },
    };
    const res = await handleCheckpointPlan(ctx, deps);
    return { res, calls };
  };

  it('REPRODUCES the incident: a plain checkpoint_plan after every checkpoint passed is refused', async () => {
    const { res, calls } = await run({ decision: { action: 'checkpoint_plan', goal: 'Produce the briefing again' }, priorResults: thisRun() });
    assert.equal(calls.executeCheckpoints.length, 0, 'the passed mission must not run again');
    assert.equal(calls.callAgent.length, 0, 'nothing may be structured');
    assert.ok(res.continue);
    assert.match(res.priorResultsAppend[0].result, /Re-plan refused: every checkpoint has PASSED/);
    assert.deepEqual(
      { forbidden: res.activeGuard?.forbidden, fallback: res.activeGuard?.fallback, injectedAt: res.activeGuard?.injectedAt },
      { forbidden: 'checkpoint_plan', fallback: 'synthesize', injectedAt: 3 },
      'asking to plan again is turned into synthesize',
    );
    assert.ok(calls.log.some(l => /full_replan_refused .*implicit=true/.test(l.msg)), 'telemetry says it was the implicit form');
  });

  it('the refusal names the stored full result behind a digest, so the cortex can read it', async () => {
    const { res } = await run({ decision: { action: 'checkpoint_plan' }, priorResults: thisRun() });
    const steer = res.priorResultsAppend[0].result;
    assert.ok(steer.includes(READBACK_REF), 'the digested read-back is offered by its own ref');
    assert.match(steer, /a DIGEST of a stored result, not a cut/);
    assert.match(steer, /w-task-3/, 'task refs are still offered');
  });

  it('an explicit mission-scope re-shape of passed work is refused too, now with the guard', async () => {
    const { res, calls } = await run({ decision: { action: 'checkpoint_plan', replan_scope: 'mission', replan_reason: 'start over' }, priorResults: thisRun() });
    assert.equal(calls.executeCheckpoints.length, 0);
    assert.equal(res.activeGuard?.fallback, 'synthesize');
    assert.ok(calls.log.some(l => /full_replan_refused .*implicit=false/.test(l.msg)));
  });

  it('a spine that passed BEFORE a human answered stays plannable — the answer may ask for more', async () => {
    const { res, calls } = await run({
      decision: { action: 'checkpoint_plan', checkpoints: [{ instruction: 'Add the board deck', tasks: [{ agent: 'motor', task: 'Build the deck' }] }] },
      priorResults: [{ agent: 'human', result: 'Thanks — also add the board deck.', success: true }],
    });
    assert.equal(calls.executeCheckpoints.length, 1, 'new work from a human is planned');
    assert.equal(res.activeGuard, undefined);
  });

  it('a failed checkpoint is still re-tasked, not refused', async () => {
    const spine = passedSpine();
    spine[2].status = 'failed';
    const { calls } = await run({ decision: { action: 'checkpoint_plan' }, priorResults: thisRun(), spine });
    const scoped = calls.callAgent.filter(c => c.agentId === 'prefrontal' && String(c.payload?.instruction).includes('SINGLE CHECKPOINT'));
    assert.equal(scoped.length, 1, 'the failed checkpoint gets a scoped re-plan');
  });

  it('with reject_full_replan_when_passing off, the old behaviour returns', async () => {
    const { calls } = await run({
      decision: { action: 'checkpoint_plan' },
      priorResults: thisRun(),
      contracts: { dispatch: { reject_full_replan_when_passing: false } },
    });
    assert.equal(calls.executeCheckpoints.length, 1);
  });

  it('the pass nudge offers the stored full results behind any digests', async () => {
    const { deps } = createMockDeps();
    deps.executeCheckpoints = async () => ({
      success: true,
      results: [{ step: '1.1', agent: 'motor', task: 'Deliver', success: true, ref: 'w-task-9', result: thisRun()[2].result }],
    });
    const res = await handleCheckpointPlan({
      envelope: { id: 'm-fresh', instruction: 'Produce the briefing' },
      decision: { checkpoints: [{ instruction: 'Deliver', tasks: [{ agent: 'motor', task: 'Create and read back the doc' }] }] },
      priorResults: [],
      iteration: 1,
      _tokenUsage: { totalInput: 0, totalOutput: 0, totalCached: 0, totalCacheWrites: 0, callCount: 0 },
    }, deps);
    const nudge = res.priorResultsAppend.find(r => r.agent === 'system' && /PASSED verification/.test(r.result));
    assert.ok(nudge, 'a passed plan is nudged to synthesize');
    assert.ok(nudge.result.includes(READBACK_REF));
    assert.ok(nudge.result.includes('w-task-9'));
  });
});
