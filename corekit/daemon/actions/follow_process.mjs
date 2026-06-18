// Action handler: follow_process
export async function handleFollowProcess(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage, memoryResults } = ctx;
  const {
    log,
    toStr,
    createCT,
    completeEnvelope,
    ensureProcessesLoaded,
    PROCESSES,
    executeProcess
  } = deps;

  const processId = decision.processId || decision.process_id;

  if (!processId) {
    log('ERROR', 'follow_process: missing processId');
    return {
      continue: true,
      priorResultsAppend: [{ agent: 'system', result: '[SYSTEM] follow_process requires a processId.' }]
    };
  }

  // Guard: prevent re-executing a process that already ran in this envelope
  if (envelope.process_id) {
    const forceKey = '_follow_process_force_count';
    envelope[forceKey] = (envelope[forceKey] || 0) + 1;

    if (envelope[forceKey] >= 2) {
      // Cortex is stuck in a loop — force-complete the mission with process results
      log('WARN', `follow_process: process '${envelope.process_id}' already executed — Cortex stuck (${envelope[forceKey]}x), force-completing mission`);

      // Build synthesis from child results
      const childResults = priorResults
        .filter(r => r.agent && r.agent !== 'system')
        .map(r => `${r.agent}: ${toStr(r.result).substring(0, 500)}`)
        .join('\n\n');
      const synthesis = childResults || envelope.output || 'Process completed but Cortex could not synthesize results.';

      await createCT(envelope, {
        checkpointTitle: 'Force-synthesize (stuck loop)',
        taskTitle: 'Auto-synthesize after process completion',
        taskOutput: synthesis,
        taskIntent: 'synthesize',
        deliveryStatus: 'internal',
        ctKey: `force-synth-${envelope.id}-${iteration}`,
      });

      envelope.output = synthesis;
      await completeEnvelope(envelope, {
        status: 'complete',
        output: synthesis,
        historyDetail: 'Force-synthesized: Cortex stuck in follow_process loop',
        tokenUsage: _tokenUsage,
      });
      return { exit: true };
    }

    log('WARN', `follow_process: process '${envelope.process_id}' already executed on this envelope — forcing synthesize`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Process '${envelope.process_id}' has already been executed on this envelope. You MUST now synthesize the results. Use action "synthesize" with a summary of what was accomplished.`,
      }],
      activeGuard: { forbidden: 'follow_process', fallback: 'synthesize', injectedAt: iteration }
    };
  }

  await ensureProcessesLoaded();
  if (!PROCESSES[processId]) {
    log('ERROR', `follow_process: process '${processId}' not found`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Process '${processId}' not found. Available processes: ${Object.keys(PROCESSES).join(', ') || 'none'}`
      }]
    };
  }

  // Hand off to deterministic executor — exits the Cortex decide loop
  log('INFO', `follow_process: handing off '${processId}' to executeProcess`);
  // Telemetry: process selection
  log('INFO', `[TELEMETRY] process_selected: ${JSON.stringify({ processId, missionId: envelope.id, projectId: envelope.project_id || null, iteration })}`);
  
  const memoryContext = memoryResults || {};
  const processResult = await executeProcess(null, decision, memoryContext, processId, envelope);
  
  if (processResult === 'fallback_to_decide') {
    log('WARN', `follow_process: process '${processId}' fell back to decide — continuing loop`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] follow_process '${processId}' failed: missing required parameters. Use checkpoint_plan instead and include the work steps directly, or re-issue follow_process with all required parameters filled in the "parameters" field.`
      }]
    };
  }
  
  return { exit: true };
}
