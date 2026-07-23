// Action handler: trigger_responsibility
//
// The agent-initiated face of the on-demand responsibility trigger: when a user
// asks the agent to run a scheduled cycle out of turn ("run the memory
// consolidation now"), Cortex emits { action: 'trigger_responsibility',
// responsibilityId: '<id>' }. This handler fires it via the scheduler's
// fireById primitive, then hands back to Cortex to deliver a brief confirmation
// through the normal synthesize → mouth path (C-27). The fired responsibility
// runs its own R→M cycle in the background — this turn's job is only to start it.
//
// Guardrails:
//   - Only responsibilities in the triggerable set may be fired here (curated
//     opt-in via responsibilities.json `triggerable: true`).
//   - fireById always enforces the singleton guard; on-demand bypasses spacing.
//   - envelope._responsibility_triggered + an activeGuard prevent re-firing in
//     the same turn.
export async function handleTriggerResponsibility(ctx, deps) {
  const { envelope, decision, iteration } = ctx;
  const { log, fireResponsibilityById, getTriggerableResponsibilities } = deps;

  const respId = decision.responsibilityId || decision.responsibility_id || decision.id;
  const triggerable = (typeof getTriggerableResponsibilities === 'function')
    ? (getTriggerableResponsibilities() || [])
    : [];
  const match = triggerable.find(r => r.id === respId);

  // Unknown / non-triggerable id — steer Cortex to the right path rather than firing.
  if (!respId || !match) {
    const list = triggerable.map(r => r.id).join(', ') || 'none';
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] trigger_responsibility needs a "responsibilityId" from the triggerable set: ${list}. `
          + `If the user's request is not one of these scheduled cycles, do NOT use trigger_responsibility — plan the work with checkpoint_plan instead.`,
      }],
    };
  }

  // Already fired this turn — force the confirmation, never fire twice.
  if (envelope._responsibility_triggered) {
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] '${envelope._responsibility_triggered}' was already triggered this turn. Respond to the user now with action "synthesize" — a brief confirmation. Do NOT trigger again.`,
      }],
      activeGuard: { forbidden: 'trigger_responsibility', fallback: 'synthesize', injectedAt: iteration },
    };
  }

  const r = await fireResponsibilityById(respId, { bypassSpacing: true, source: 'agent' });
  envelope._responsibility_triggered = respId;

  if (!r || !r.ok) {
    const why = r?.error || 'unknown error';
    const hint = r?.skipped ? ' (a cycle may already be running — it will finish on its own).' : '.';
    return {
      continue: true,
      priorResultsAppend: [{
        agent: 'system',
        result: `[SYSTEM] Could not start '${match.name}': ${why}${hint} Explain this to the user with action "synthesize"; do NOT retry the trigger.`,
      }],
      activeGuard: { forbidden: 'trigger_responsibility', fallback: 'synthesize', injectedAt: iteration },
    };
  }

  log('INFO', `[TELEMETRY] responsibility_triggered id=${respId} source=agent mission=${envelope.id}`);
  return {
    continue: true,
    priorResultsAppend: [{
      agent: 'system',
      success: true,
      result: `[SYSTEM] The '${match.name}' responsibility has been triggered and is now running in the background — it will complete on its own. `
        + `Your job this turn is done: respond to the user with action "synthesize" — a brief confirmation that you've started it. Do NOT plan the cycle's internal steps yourself.`,
    }],
    activeGuard: { forbidden: 'trigger_responsibility', fallback: 'synthesize', injectedAt: iteration },
  };
}
