// corekit/contracts/schemas/runtime.mjs — Runtime State (Foundation-owned schemas)
//
// What is happening, what happened, and what was learned. These records are
// written by the runtime through domain commands, never authored by hand and
// never edited by Prime as raw documents (C-29).
//
// The Work schema is the important one: envelope shape was previously a
// TypeScript interface in the dashboard, while transitions and completion lived
// in several runtime paths. A shape that only the UI declares is a shape the
// runtime can silently diverge from.

import { ID_PATTERN, DIGEST_PATTERN } from '../ids.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const schema = (id, version, properties, check) => ({
  id, version, spec: { type: 'object', properties, check },
});

// ── Work envelope ──────────────────────────────────────────────────────

/** R → M → C → T. The spine, and the only work hierarchy there is (C-15). */
export const ENVELOPE_TYPES = ['R', 'M', 'C', 'T'];

export const ENVELOPE_STATUSES = [
  'pending', 'planned', 'queued', 'active', 'waiting', 'awaiting_approval',
  'needs_input', 'needs_review', 'blocked', 'complete', 'failed', 'rejected',
  'timed_out', 'cancelled', 'archived',
];

/** Statuses from which no further transition is legal. */
export const TERMINAL_STATUSES = ['complete', 'failed', 'rejected', 'timed_out', 'cancelled', 'archived'];

export const WORK_SCHEMA = schema('work', 1, {
  id: { type: 'string', required: true, minLength: 1 },
  type: { type: 'string', required: true, enum: ENVELOPE_TYPES },
  parent_id: { type: 'string', nullable: true },
  owner: { type: 'string', required: true, minLength: 1, describe: 'Full agent email — the scoping key for the root-level collection' },
  status: { type: 'string', required: true, enum: ENVELOPE_STATUSES },
  intent: { type: 'string', required: true },
  title: { type: 'string' },
  instruction: { type: 'string', required: true },
  accept_criteria: { type: 'string', required: true, describe: 'What the deliverable must observably do — never a tool-runtime detail' },
  context_summary: { type: 'string', nullable: true },
  output: { type: 'string', nullable: true },
  error: { type: 'string', nullable: true },
  children: { type: 'array', items: { type: 'string' }, default: [] },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  source_channel: { type: 'string', required: true },
  source_meta: { type: 'object', open: true, default: {} },
  source_text: { type: 'string', nullable: true, describe: 'Verbatim intake, carried on M only' },

  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  started_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  completed_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  updated_at: { type: 'string', required: true, pattern: ISO_DATE },
  iteration: { type: 'integer', required: true, min: 0, default: 0 },

  blocker: { type: 'string', nullable: true },
  blocker_type: { type: 'string', nullable: true },
  blocked_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  cancelled_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  cancelled_reason: { type: 'string', nullable: true },

  project_id: { type: 'string', nullable: true, describe: 'Required on M — never null in practice (C-15)' },
  delivery_status: { type: 'string', nullable: true, enum: ['pending', 'delivered', 'failed'] },
  delivery_attempts: { type: 'integer', min: 0 },
  next_delivery_attempt_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  delivery_error: { type: 'string', nullable: true },

  // C-32: what produced this behavior. Stamped at creation, read for the
  // envelope's whole life, so a mission can be attributed and replayed.
  platform_version: { type: 'string', nullable: true },
  fleet_release: { type: 'string', nullable: true },
  agent_spec_digest: { type: 'string', nullable: true, pattern: DIGEST_PATTERN },

  step_ledger: { type: 'object', open: true, describe: 'Idempotency keys for replay-safe dispatch' },
  claimed_by: { type: 'string', nullable: true },
  claimed_at_ms: { type: 'number', nullable: true },
  wait_resume_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  resume_instruction: { type: 'string', nullable: true },
}, (env) => {
  // C-15: missions never nest, and the spine has exactly one shape.
  if (env.type === 'M' && env.parent_id) {
    const meta = env.source_meta || {};
    // A delegated mission legitimately points at the delegating checkpoint.
    if (!meta.delegation_parent && !meta.responsibility_id) {
      return 'a Mission may not nest under another envelope (C-15)';
    }
  }
  if (env.type === 'T' && !env.parent_id) return 'a Task must belong to a Checkpoint (C-15)';
  if (env.type === 'C' && !env.parent_id) return 'a Checkpoint must belong to a Mission (C-15)';
  if (env.status === 'complete' && !env.completed_at) return 'a complete envelope must carry completed_at';
  return null;
});

// ── Approval ───────────────────────────────────────────────────────────

export const APPROVAL_SCHEMA = schema('approval', 1, {
  id: { type: 'string', required: true, minLength: 1 },
  schema_version: { type: 'integer', min: 1 },
  envelope_id: { type: 'string', required: true, describe: 'The work this gates' },
  owner: { type: 'string', required: true },
  conversation_id: { type: 'string', nullable: true, describe: 'Approvals resolve owner+conversation scoped' },
  requested_at: { type: 'string', required: true, pattern: ISO_DATE },
  requested_by: { type: 'string', required: true },
  action_summary: { type: 'string', required: true, minLength: 5, describe: 'What is about to happen, in the operator\'s terms' },
  action_digest: {
    type: 'string', required: true, pattern: DIGEST_PATTERN,
    describe: 'Binds the token to the exact action. An approval for one action cannot authorize another.',
  },
  stakes: { type: 'string', required: true, enum: ['routine', 'consequential', 'destructive_or_public'] },
  scope: { type: 'string', required: true, enum: ['once', 'conversation', 'mission'], default: 'once' },
  expires_at: { type: 'string', required: true, pattern: ISO_DATE },
  status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected', 'expired', 'consumed'], default: 'pending' },
  resolved_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  resolved_by: { type: 'string', nullable: true },
  consumed_at: { type: 'string', nullable: true, pattern: ISO_DATE, describe: 'A token is consumed once (C-31 §7)' },
}, (a) => {
  if (a.status === 'approved' && !a.resolved_by) return 'an approved request must record who approved it';
  if (a.status === 'consumed' && !a.consumed_at) return 'a consumed token must record when';
  return null;
});

// ── Project ────────────────────────────────────────────────────────────

export const PROJECT_SCHEMA = schema('project', 1, {
  id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'Equals the document id (C-31)' },
  schema_version: { type: 'integer', min: 1 },
  name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
  description: { type: 'string', required: true, minLength: 1 },
  goal: { type: 'string', default: '' },
  status: { type: 'string', required: true, enum: ['active', 'complete', 'archived'], default: 'active' },
  owner: { type: 'string', default: '' },
  ownerAgent: { type: 'string', nullable: true },
  parent_id: { type: 'string', nullable: true, describe: 'Projects are the sole recursive primitive, max depth 4 (C-15)' },
  depends_on: { type: 'array', items: { type: 'string' }, default: [] },
  team: { type: 'array', items: { type: 'any' }, default: [], describe: 'Members with role and responsibilities' },
  participants: { type: 'array', items: { type: 'string' }, default: [] },
  standardProcesses: { type: 'array', items: { type: 'string' }, default: [] },
  context: { type: 'object', open: true, nullable: true, default: {} },
  deploy: { type: 'object', open: true, nullable: true },
  missionCount: { type: 'integer', min: 0, default: 0 },
  completedMissions: { type: 'integer', min: 0, default: 0 },
  created_by: { type: 'string', default: 'operator' },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  updated_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  completed_at: { type: 'string', nullable: true, pattern: ISO_DATE },
}, (p) => {
  if (p.parent_id === p.id) return 'a project cannot be its own parent';
  if (Array.isArray(p.depends_on) && p.depends_on.includes(p.id)) return 'a project cannot depend on itself';
  return null;
});
