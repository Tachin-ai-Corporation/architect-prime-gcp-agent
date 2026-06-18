// Action handler: blocked
export async function handleBlocked(ctx, deps) {
  const { envelope, decision, _tokenUsage } = ctx;
  const { completeEnvelope, toStr } = deps;

  await completeEnvelope(envelope, {
    status: 'blocked',
    output: decision.escalation_message || decision.blocker_description || decision.blocker || decision.synthesis || decision.response || decision.message || 'Blocked on external dependency.',
    blocker: decision.blocker || 'Unknown blocker',
    blockerType: decision.blocker_type || 'other',
    historyDetail: `Blocked: ${toStr(decision.blocker).substring(0, 200)}`,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
