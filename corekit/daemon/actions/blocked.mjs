// Action handler: blocked
import { deliverableStandsDespiteMilestone } from '../../lib/finalization.mjs';

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

  await completeEnvelope(envelope, {
    status: 'blocked',
    output: decision.escalation_message || decision.blocker_description || decision.blocker || decision.synthesis || decision.content || decision.response || decision.message || decision.instruction || 'Blocked on external dependency.',
    blocker: decision.blocker || 'Unknown blocker',
    blockerType: decision.blocker_type || 'other',
    historyDetail: `Blocked: ${toStr(decision.blocker).substring(0, 200)}`,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
