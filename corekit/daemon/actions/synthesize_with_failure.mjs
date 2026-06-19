// Action handler: synthesize_with_failure
export async function handleSynthesizeWithFailure(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { log, firestoreWrite, completeEnvelope, toStr, MAX_ITERATIONS } = deps;

  const swfState = envelope._swf_state || null;

  // State 1: Check if recent work actually succeeded (stale failure in context)
  const recentDispatches = priorResults.filter(r => r.agent !== 'system' && r.agent !== 'human');
  const lastPlanStart = priorResults.findLastIndex(r => r.agent === 'system' && r.result?.includes('[SYSTEM] Checkpoint'));
  const recentWork = lastPlanStart >= 0 ? recentDispatches.filter((_, i) => i >= lastPlanStart) : recentDispatches;
  const recentAllSucceeded = recentWork.length > 0 && recentWork.every(r => r.success !== false);

  if (recentAllSucceeded) {
    log('INFO', `swf[upgrade]: recent work all succeeded — upgrading to synthesize`);
    decision.action = 'synthesize';
    return { delegateAction: 'synthesize' };
  }
  // State 2: First failure — attempt self-unblock
  else if (swfState === null && iteration < MAX_ITERATIONS - 2) {
    log('INFO', `swf[null→awaiting_unblock]: self-unblock attempt for ${envelope.id}`);
    envelope._swf_state = 'awaiting_unblock';
    envelope._failure_synthesis = decision.synthesis || decision.content || decision.failure_summary || decision.message || decision.instruction || null;
    await firestoreWrite('work', envelope.id, envelope);

    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SELF-UNBLOCK CHECK] Before accepting this failure, try to find an alternative approach. Can you resolve this yourself using a different method? If YES: use "checkpoint_plan" to try the alternative. If NO — this is a genuine external dependency you cannot work around — use "blocked" action with a concrete blocker description. Do NOT use synthesize_with_failure; use "blocked" instead.`,
      }],
    };
  }
  // State 3: After self-unblock — check if new work succeeded
  else if (swfState === 'awaiting_unblock') {
    // Check if any dispatch succeeded since the unblock was injected
    const hasPostUnblockSuccess = recentDispatches.some(r => r.success === true);
    if (hasPostUnblockSuccess) {
      log('INFO', `swf[awaiting_unblock→complete]: self-unblock succeeded`);
      envelope._swf_state = 'unblock_attempted';
      await completeEnvelope(envelope, {
        status: 'complete',
        output: decision.synthesis || decision.content || decision.response || decision.message || decision.instruction || '',
        historyDetail: 'Completed (self-unblock resolved the failure)',
        tokenUsage: _tokenUsage,
      });
      return { exit: true };
    }
    // Self-unblock didn't produce success — fall through to terminal state
    log('INFO', `swf[awaiting_unblock→terminal]: self-unblock did not resolve failure`);
    envelope._swf_state = 'unblock_attempted';
  }

  // Terminal state: accept the failure
  if (envelope.type === 'M') {
    await completeEnvelope(envelope, {
      status: 'blocked',
      output: decision.synthesis || decision.content || decision.response || decision.message || decision.instruction || '',
      blocker: decision.failure_summary || decision.synthesis || decision.content || decision.message || decision.instruction || 'Unknown blocker',
      blockerType: decision.blocker_type || 'other',
      historyDetail: `Blocked (self-unblock exhausted): ${toStr(decision.failure_summary).substring(0, 200)}`,
      tokenUsage: _tokenUsage,
    });
    return { exit: true };
  }

  // Non-mission: complete with failure acknowledgment
  await completeEnvelope(envelope, {
    status: 'complete',
    output: decision.synthesis || decision.content || decision.response || decision.message || decision.instruction || '',
    historyDetail: `Synthesized with acknowledged failure: ${toStr(decision.failure_summary).substring(0, 200)}`,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
