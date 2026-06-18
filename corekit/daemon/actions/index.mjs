// Action handler index — Phase 2.2
// Exports all 8 action handlers with unified signature:
//   async function handle<Action>(ctx, deps)

import { handleSynthesize } from './synthesize.mjs';
import { handleBlocked } from './blocked.mjs';
import { handleNeedsInput } from './needs_input.mjs';
import { handleStatusUpdate } from './status_update.mjs';
import { handleSynthesizeWithFailure } from './synthesize_with_failure.mjs';
import { handleFollowProcess } from './follow_process.mjs';
import { handleDelegate } from './delegate.mjs';
import { handleCheckpointPlan } from './checkpoint_plan.mjs';

export {
  handleSynthesize,
  handleBlocked,
  handleNeedsInput,
  handleStatusUpdate,
  handleSynthesizeWithFailure,
  handleFollowProcess,
  handleDelegate,
  handleCheckpointPlan,
};

export const ACTION_NAMES = [
  'synthesize', 'synthesize_with_failure', 'blocked', 'needs_input',
  'follow_process', 'delegate', 'checkpoint_plan', 'status_update',
];
