// Action handler: blocked
import { deliverableStandsDespiteMilestone, articulateBlocker } from '../../work/finalization.mjs';
import { extractFailRecommendation } from '../../work/verdict.mjs';

// Blocker types that name a genuine external obstacle. When cortex declares one of these we
// trust it and block; the guard below only catches the DEFAULT/absent 'other' case, where a
// milestone verdict has been mistaken for a failed deliverable.
const REAL_BLOCKER_TYPES = new Set([
  'access', 'permission', 'auth', 'missing-input', 'missing_input',
  'external', 'dependency', 'quota', 'rate-limit', 'rate_limit',
]);

export async function handleBlocked(ctx, deps) {
  const { envelope, decision, priorResults, iteration, _tokenUsage } = ctx;
  const { completeEnvelope, toStr, log, firestoreWrite, CONTRACTS = {}, MAX_ITERATIONS = 50 } = deps;

  // ---- Backstop: a `blocked` terminal must describe a genuine obstacle (B-28/B-29) ----
  // A checkpoint milestone-verification FAIL judges a checkpoint, not the mission's
  // deliverable. A real report_fail on a checkpoint whose TASKS all succeeded once
  // terminated a FINISHED mission as `blocked`, writing the mission's own success summary
  // into the blocker field (the flyer mission delivered a complete 2-page PDF as an
  // on_failure outcome). Before recording `blocked`, assert a real task actually failed. If
  // none did and a deliverable exists — and cortex named no genuine external blocker_type —
  // this is a mislabel: re-route ONCE to a verified synthesize, which completes it honestly
  // or routes to an acknowledged failure. Deterministic (C-4/B-1); the complete-vs-honest-
  // failure judgement stays with cerebellum. One-shot + iteration-bounded so a cortex that
  // truly insists on blocked (or a near-max-iteration mission) still terminates.
  const guardEnabled = CONTRACTS.dispatch?.blocked_requires_real_blocker !== false;
  const declaredRealBlocker = REAL_BLOCKER_TYPES.has(String(decision.blocker_type || '').toLowerCase());
  if (guardEnabled
      && envelope.type === 'M'
      && !envelope._blocked_mislabel_averted
      && !declaredRealBlocker
      && iteration < MAX_ITERATIONS - 1
      && deliverableStandsDespiteMilestone(priorResults)) {
    envelope._blocked_mislabel_averted = true;
    try { await firestoreWrite('work', envelope.id, envelope); } catch { /* flag rides the next write */ }
    log('WARN', `[blocked] mislabel averted for ${envelope.id}: no real task failed and a deliverable exists, but cortex chose blocked with a success-shaped blocker — re-routing to a verified synthesize (B-28)`);
    log('INFO', `[TELEMETRY] blocked_mislabel_averted mission=${envelope.id} iteration=${iteration}`);
    // Carry the summary cortex wrote into the synthesis field synthesize reads from.
    decision.synthesis = decision.synthesis || decision.blocker || decision.escalation_message
      || decision.blocker_description || decision.content || envelope._failure_synthesis || '';
    decision.action = 'synthesize';
    return { delegateAction: 'synthesize' };
  }

  // ---- The handback must carry the handback information (B-29) ----
  // Everything below is a fallback CHAIN, and its last link used to be a constant.
  // When cortex named nothing, an operator received "Blocked on external
  // dependency." over blocker "Unknown blocker" — while the failing task's own
  // report_fail sat on the envelope saying precisely what was missing. Recover it
  // rather than print a phrase; only when there is genuinely no evidence do we say
  // that, and say it as the unusual thing it is instead of dressing it as a reason.
  const stated = decision.escalation_message || decision.blocker_description || decision.blocker
    || decision.synthesis || decision.content || decision.response || decision.message
    || decision.instruction || '';
  let output = stated;
  let blocker = decision.blocker || '';
  if (!output || !blocker) {
    const evidence = articulateBlocker(priorResults, extractFailRecommendation);
    if (evidence) {
      const where = evidence.step ? ` (step ${evidence.step}${evidence.agent ? `, ${evidence.agent}` : ''})` : '';
      if (!output) output = `Blocked${where}: ${evidence.detail}`;
      if (!blocker) blocker = evidence.detail;
      log('INFO', `[TELEMETRY] blocker_articulated_from_evidence mission=${envelope.id} step=${evidence.step}`);
    }
  }
  // Nothing stated and nothing attempted. Observed live: asked to send an email —
  // a capability this agent does not have — cortex correctly declined, but on the
  // SECOND iteration, before dispatching a single task, and with every blocker
  // field empty. There is no failure to recover a reason from because there was
  // no failure; the decision to stop was made at planning time.
  //
  // Say exactly that, and say what was asked. An operator who knows the stop
  // happened before execution knows to look at the plan and the agent's
  // capabilities rather than hunt a failed step that does not exist.
  if (!output || !blocker) {
    const attempted = (Array.isArray(priorResults) ? priorResults : []).length > 0;
    const asked = String(envelope.instruction || envelope.title || '').trim().slice(0, 300);
    const where = attempted
      ? 'Blocked, and neither cortex nor any failed task recorded why — inspect the mission history.'
      : 'Blocked before any work was dispatched, and no blocker was stated. Nothing was attempted, '
        + 'so there is no failed step to inspect: the decision to stop was made while planning.';
    if (!output) output = asked ? `${where}\n\nThe request was: ${asked}` : where;
    if (!blocker) blocker = attempted
      ? 'Unarticulated blocker — no evidence on the envelope'
      : 'Unarticulated blocker — stopped at planning time, before any step ran';
    log('WARN', `[blocked] ${envelope.id} terminated with no blocker stated (attempted=${attempted})`);
    log('INFO', `[TELEMETRY] blocker_unarticulated mission=${envelope.id} attempted=${attempted}`);
  }

  await completeEnvelope(envelope, {
    status: 'blocked',
    output,
    blocker,
    blockerType: decision.blocker_type || 'other',
    historyDetail: `Blocked: ${toStr(blocker).substring(0, 200)}`,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
