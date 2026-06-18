// Action handler: synthesize
export async function handleSynthesize(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { log, createCT, completeEnvelope, MAX_ITERATIONS } = deps;

  // Check for unresolved failures — block premature success synthesis
  const lastSuccessIdx = priorResults.map((r, i) => r.success === true ? i : -1).filter(i => i >= 0).pop() ?? -1;
  const hasUnresolvedFail = priorResults.some((r, i) => r.success === false && !r.timedOut && i > lastSuccessIdx);
  if (hasUnresolvedFail && iteration < MAX_ITERATIONS - 1) {
    log('WARN', `Blocking premature synthesize — unresolved hard failures in prior_results (iteration ${iteration})`);
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Synthesize blocked: there are unresolved failures in prior_results. You MUST either: (1) dispatch to investigate/fix the failure, or (2) use "synthesize_with_failure" action with explicit failure details. Plain "synthesize" is not allowed when tasks have failed.`,
      }],
      activeGuard: { forbidden: 'synthesize', fallback: 'checkpoint_plan', injectedAt: iteration },
    };
  }

  // Wrap synthesis in C→T under the mission
  await createCT(envelope, {
    checkpointTitle: 'Formulate response',
    taskTitle: 'Synthesize answer',
    taskOutput: decision.synthesis || decision.response || decision.message,
    taskIntent: 'synthesize',
    deliveryStatus: 'internal',
    ctKey: `synth-${envelope.id}-${iteration}`,
  });

  envelope.output = decision.synthesis || decision.response || decision.message;
  await completeEnvelope(envelope, {
    status: 'complete',
    output: decision.synthesis || decision.response || decision.message,
    historyDetail: 'Synthesized response',
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
