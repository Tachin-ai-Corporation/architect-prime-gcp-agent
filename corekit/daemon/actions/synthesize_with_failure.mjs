// Action handler: synthesize_with_failure
import { isRealTaskFailure, isRealTaskSuccess } from '../../lib/finalization.mjs';

export async function handleSynthesizeWithFailure(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { log, firestoreWrite, completeEnvelope, toStr, MAX_ITERATIONS, CONTRACTS = {} } = deps;

  const swfState = envelope._swf_state || null;

  // State 1: Check if recent work actually succeeded (stale failure in context)
  const recentDispatches = priorResults.filter(r => r.agent !== 'system' && r.agent !== 'human');
  const lastPlanStart = priorResults.findLastIndex(r => r.agent === 'system' && r.result?.includes('[SYSTEM] Checkpoint'));
  const recentWork = lastPlanStart >= 0 ? recentDispatches.filter((_, i) => i >= lastPlanStart) : recentDispatches;
  // A milestone-verification verdict (step "N.verify") judges a checkpoint, not the WORK,
  // and an inconclusive/timed-out row is not a failure — exclude both from the "did recent
  // work actually succeed?" test (the same exclusion synthesize.mjs applies). Without it a
  // checkpoint whose TASKS all succeeded but whose milestone FAILed defeated this upgrade and
  // steered a finished mission toward `blocked` (the flyer mission). Gated for single-revert.
  const GUARD = CONTRACTS.dispatch?.blocked_requires_real_blocker !== false;
  const recentAllSucceeded = GUARD
    ? (recentWork.some(isRealTaskSuccess) && !recentWork.some(isRealTaskFailure))
    : (recentWork.length > 0 && recentWork.every(r => r.success !== false));

  if (recentAllSucceeded) {
    log('INFO', `swf[upgrade]: recent work all succeeded — upgrading to synthesize`);
    decision.action = 'synthesize';
    return { delegateAction: 'synthesize' };
  }
  // State 2: First failure — attempt self-unblock
  else if (swfState === null && iteration < MAX_ITERATIONS - 2) {
    log('INFO', `swf[null→awaiting_unblock]: self-unblock attempt for ${envelope.id}`);
    envelope._swf_state = 'awaiting_unblock';
    envelope._failure_synthesis = decision.synthesis || decision.summary || decision.content || decision.failure_summary || decision.message || decision.instruction || null;
    await firestoreWrite('work', envelope.id, envelope);

    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SELF-UNBLOCK CHECK] Before accepting this failure, check what actually happened.\n(a) If the deliverable is in fact COMPLETE and the only "failure" was a checkpoint/milestone verdict — the tasks themselves succeeded — do NOT report a blocker. Deliver the finished result now with "synthesize", noting honestly any milestone that was left unverified.\n(b) If it is genuinely incomplete but you can resolve it a different way, use "checkpoint_plan" to try the alternative.\n(c) ONLY if this is a genuine external dependency you cannot work around, use the "blocked" action with a concrete description of the obstacle (the thing standing in your way — not a summary of what you accomplished). Do NOT use synthesize_with_failure.`,
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
        output: decision.synthesis || decision.summary || decision.content || decision.response || decision.message || decision.instruction || '',
        priorResults,
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
      output: decision.synthesis || decision.summary || decision.content || decision.response || decision.message || decision.instruction || '',
      blocker: decision.failure_summary || decision.synthesis || decision.content || decision.message || decision.instruction || 'Unknown blocker',
      blockerType: decision.blocker_type || 'other',
      priorResults,
      historyDetail: `Blocked (self-unblock exhausted): ${toStr(decision.failure_summary).substring(0, 200)}`,
      tokenUsage: _tokenUsage,
    });
    return { exit: true };
  }

  // Non-mission: complete with failure acknowledgment
  await completeEnvelope(envelope, {
    status: 'complete',
    output: decision.synthesis || decision.summary || decision.content || decision.response || decision.message || decision.instruction || '',
    priorResults,
    historyDetail: `Synthesized with acknowledged failure: ${toStr(decision.failure_summary).substring(0, 200)}`,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
