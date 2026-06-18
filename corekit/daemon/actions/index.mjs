// Action handler index — Phase 2.2
// Handlers are defined inside _processEnvelopeInner (agent-brain.mjs)
// to close over module-scoped deps. This file documents the interface
// for future extraction when deps are injected.
//
// Handler signature:
//   async function handle<Action>(ctx: ActionContext): Promise<ActionResult>
//
// ActionContext: { envelope, decision, priorResults, memoryResults, memoryContext, iteration, _activeGuard, _tokenUsage }
// ActionResult: { exit?: boolean, continue?: boolean, priorResultsAppend?: Array, activeGuard?: Object }
//
// Actions: synthesize, synthesize_with_failure, blocked, needs_input,
//          follow_process, delegate, checkpoint_plan, status_update

export const ACTION_NAMES = [
  'synthesize', 'synthesize_with_failure', 'blocked', 'needs_input',
  'follow_process', 'delegate', 'checkpoint_plan', 'status_update',
];
