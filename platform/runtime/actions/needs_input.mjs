// Action handler: needs_input
export async function handleNeedsInput(ctx, deps) {
  const { envelope, decision, _tokenUsage } = ctx;
  const { completeEnvelope } = deps;

  await completeEnvelope(envelope, {
    status: 'needs_input',
    output: decision.question || decision.message || 'I need more information to proceed.',
    historyDetail: `Needs: ${decision.what_is_needed || 'clarification'}`,
    skipArtifacts: true,
    skipMemory: true,
    skipCleanup: true,
    tokenUsage: _tokenUsage,
  });
  return { exit: true };
}
