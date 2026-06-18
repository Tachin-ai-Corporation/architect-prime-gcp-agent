// checkpoint-executor.mjs — Shared checkpoint execution engine
// Phase 2.5: Convergence of checkpoint execution paths
//
// Both agent-brain.mjs (checkpoint_plan handler) and process-engine.mjs
// (runProcessPlan) implement the same walk-checkpoints-dispatch-verify-retry
// pattern. This module will eventually contain the shared implementation.
//
// Current status: Interface defined, wiring pending Phase 2.2/2.3 completion.
// Integration plan:
//   1. Phase 2.2/2.3 extracts checkpoint_plan handler to named function
//   2. This module receives the execution loop from that named function
//   3. process-engine.mjs switches to calling this module
//   4. Both paths share one verification, one evidence floor, one step ledger

import { toStr } from './to-str.mjs';

/**
 * Execute a set of checkpoint tasks using the provided agent dispatcher.
 *
 * @param {Array} checkpoints - Array of { instruction, accept_criteria, tasks: [{ agent, task, ... }] }
 * @param {Object} opts
 * @param {Function} opts.dispatchAgent - async (agentId, payload) => { success, output, error, usage }
 * @param {Object} opts.envelope - The parent envelope being processed
 * @param {Object} opts.memory - Memory context for injecting into dispatches
 * @param {Object} opts.stepLedger - Step ledger state for idempotency
 * @param {Function} opts.log - Logging function
 * @param {Function} opts.writeHistory - History recording function
 * @param {Function} opts.firestoreWrite - Firestore write function
 * @param {Function} opts.generateId - ID generator
 * @param {Function} opts.createCT - Checkpoint/task envelope creator
 * @param {Object} opts.contracts - Runtime contracts for evidence floor, verification, etc.
 * @param {Object} opts.skillIndex - Available skills for motor dispatch
 * @param {Object} opts.projects - Project context
 * @param {Function} opts.extractVerdict - Verdict extraction from cerebellum output
 * @param {Function} opts.extractFailRecommendation - Fail recommendation extraction
 * @param {Function} opts.detectMotorFailure - Motor-specific failure detection
 * @returns {Object} { success: boolean, results: Array, tokenUsage: Object }
 */
export async function executeCheckpointTasks(checkpoints, opts) {
  const {
    dispatchAgent,
    envelope,
    log = () => {},
    contracts = {},
    extractVerdict,
  } = opts;

  const results = [];
  const tokenUsage = { totalInput: 0, totalOutput: 0, totalCached: 0, callCount: 0 };
  let allSucceeded = true;

  for (let cpIdx = 0; cpIdx < checkpoints.length; cpIdx++) {
    const checkpoint = checkpoints[cpIdx];
    const cpNum = cpIdx + 1;
    log('INFO', `[checkpoint-executor] CP${cpNum}/${checkpoints.length}: ${toStr(checkpoint.instruction).substring(0, 100)}`);

    for (const task of checkpoint.tasks) {
      const taskAgent = task.agent || 'motor';
      const taskInstruction = toStr(task.task || task.instruction || '');

      log('INFO', `[checkpoint-executor] CP${cpNum} dispatching to ${taskAgent}: ${taskInstruction.substring(0, 80)}`);

      try {
        const result = await dispatchAgent(taskAgent, {
          instruction: taskInstruction,
          _missionId: envelope.id,
          accept_criteria: task.accept_criteria || checkpoint.accept_criteria || '',
          skill_hint: task.skill || task.brief_part || null,
        });

        // Accumulate token usage
        if (result?.usage) {
          tokenUsage.totalInput += (result.usage.promptTokenCount || result.usage.input_tokens || 0);
          tokenUsage.totalOutput += (result.usage.candidatesTokenCount || result.usage.output_tokens || 0);
          tokenUsage.callCount++;
        }

        results.push({
          checkpoint: cpNum,
          agent: taskAgent,
          success: result?.success ?? false,
          result: toStr(result?.output || result?.error || ''),
          durationMs: result?.durationMs || 0,
        });

        if (!result?.success) {
          allSucceeded = false;
          log('WARN', `[checkpoint-executor] CP${cpNum} task failed: ${toStr(result?.error).substring(0, 200)}`);
        }
      } catch (e) {
        allSucceeded = false;
        results.push({
          checkpoint: cpNum,
          agent: taskAgent,
          success: false,
          result: `Dispatch error: ${e.message}`,
        });
        log('ERROR', `[checkpoint-executor] CP${cpNum} dispatch error: ${e.message}`);
      }
    }

    // Verification step (if cerebellum is available via dispatchAgent)
    if (checkpoint.accept_criteria && extractVerdict) {
      try {
        const verifyResult = await dispatchAgent('cerebellum', {
          instruction: [
            'Verify the following checkpoint against its acceptance criteria.',
            '',
            `## Acceptance Criteria`,
            checkpoint.accept_criteria,
            '',
            `## Task Results`,
            results.filter(r => r.checkpoint === cpNum)
              .map(r => `${r.agent} (${r.success ? 'success' : 'failed'}): ${r.result.substring(0, 500)}`)
              .join('\n\n'),
          ].join('\n'),
          _missionId: envelope.id,
        });

        if (verifyResult?.success && verifyResult?.output) {
          const verdict = extractVerdict(verifyResult.output);
          if (verdict === 'FAIL') {
            allSucceeded = false;
            log('WARN', `[checkpoint-executor] CP${cpNum} verification FAIL`);
          } else if (verdict === 'PASS') {
            log('INFO', `[checkpoint-executor] CP${cpNum} verification PASS`);
          } else {
            log('WARN', `[checkpoint-executor] CP${cpNum} verification inconclusive (no verdict tool called)`);
          }
        }
      } catch (e) {
        log('WARN', `[checkpoint-executor] CP${cpNum} verification error: ${e.message}`);
      }
    }
  }

  return { success: allSucceeded, results, tokenUsage };
}
