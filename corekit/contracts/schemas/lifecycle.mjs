// corekit/contracts/schemas/lifecycle.mjs — how definitions become live (Foundation)
//
// The Fleet Definition plane's transactional metadata: a change is drafted,
// validated, evaluated, released, assigned, rolled out, and — when it goes wrong
// — rolled back to a named predecessor. These records are what make a content
// change attributable and reversible (C-31), and they are the difference between
// "Prime edited a soul" and "Prime shipped a soul change you can undo".
//
// The Platform Finding lives here too, because it is the one thing that leaves
// this plane instead of becoming a release (C-34).

import { ID_PATTERN, REVISION_PATTERN, DIGEST_PATTERN, COMMIT_SHA_PATTERN } from '../ids.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const schema = (id, version, properties, check) => ({
  id, version, spec: { type: 'object', properties, check },
});

/** One entry of a semantic diff — what changed, in domain terms, not as a patch. */
const DIFF_ENTRY = {
  type: 'object',
  properties: {
    kind: { type: 'string', required: true, describe: 'Aggregate name' },
    id: { type: 'string', required: true, pattern: ID_PATTERN },
    op: { type: 'string', required: true, enum: ['add', 'update', 'deprecate'] },
    from_revision: { type: 'string', nullable: true, pattern: REVISION_PATTERN },
    to_revision: { type: 'string', nullable: true, pattern: REVISION_PATTERN },
    summary: { type: 'string', required: true, describe: 'What changed, in one line an operator can act on' },
    fields: { type: 'array', items: { type: 'string' }, default: [], describe: 'Which fields differ' },
  },
};

// ── Change: an immutable draft ─────────────────────────────────────────

export const CHANGE_SCHEMA = schema('fleetChange', 1, {
  id: { type: 'string', required: true, pattern: /^fc-[a-z0-9-]+$/ },
  schema_version: { type: 'integer', required: true, min: 1 },
  title: { type: 'string', required: true, minLength: 5, maxLength: 200 },
  rationale: { type: 'string', required: true, minLength: 20, describe: 'Why. The first thing an operator reads on a proposal card.' },
  author: { type: 'string', required: true, minLength: 1 },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  base_release: {
    type: 'string', nullable: true, pattern: /^fr-[a-z0-9-]+$/,
    describe: 'The release this change branched from. Concurrent drift against it is a 409, not a merge (C-31).',
  },
  status: {
    type: 'string', required: true,
    enum: ['draft', 'validated', 'evaluated', 'released', 'abandoned'],
    default: 'draft',
  },
  revisions: {
    type: 'array', required: true, minLength: 1,
    items: {
      type: 'object',
      properties: {
        kind: { type: 'string', required: true },
        id: { type: 'string', required: true, pattern: ID_PATTERN },
        revision: { type: 'string', required: true, pattern: REVISION_PATTERN },
        base_revision: { type: 'string', nullable: true, pattern: REVISION_PATTERN, describe: 'CAS precondition — the revision this edit assumed' },
      },
    },
    describe: 'The definition revisions this change introduces',
  },
  diff: { type: 'array', items: DIFF_ENTRY, default: [] },
  validation: {
    type: 'object', nullable: true,
    properties: {
      at: { type: 'string', required: true, pattern: ISO_DATE },
      passed: { type: 'boolean', required: true },
      errors: { type: 'array', items: { type: 'string' }, default: [] },
      checks: { type: 'array', items: { type: 'string' }, default: [], describe: 'Which validators ran — an absent check is not a pass' },
    },
  },
  evaluation_ids: { type: 'array', items: { type: 'string' }, default: [] },
  risk: {
    type: 'string', enum: ['low', 'medium', 'high'], default: 'medium',
    describe: 'Drives the approval policy — see the risk table in ADR-001',
  },
});

// ── Release: an immutable, activatable set ─────────────────────────────

export const RELEASE_SCHEMA = schema('fleetRelease', 1, {
  id: { type: 'string', required: true, pattern: /^fr-[a-z0-9-]+$/ },
  schema_version: { type: 'integer', required: true, min: 1 },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  created_by: { type: 'string', required: true, minLength: 1 },
  change_ids: { type: 'array', required: true, minLength: 1, items: { type: 'string' } },
  content_ref: {
    type: 'object', required: true,
    describe: 'Where the content actually is: a commit in the tenant fleet-config repo.',
    properties: {
      repo: { type: 'string', required: true },
      branch: { type: 'string', required: true },
      commit: { type: 'string', required: true, pattern: /^[0-9a-f]{40}$/ },
    },
  },
  digest: { type: 'string', required: true, pattern: DIGEST_PATTERN, describe: 'Content address of the whole release' },
  parent_release: { type: 'string', nullable: true, pattern: /^fr-[a-z0-9-]+$/, describe: 'The rollback target (C-31)' },
  platform_compat: {
    type: 'object', required: true,
    properties: {
      min: { type: 'string', required: true },
      max: { type: 'string', nullable: true },
    },
  },
  evidence: {
    type: 'object', required: true,
    describe: 'Validation and evaluation must be recorded before a high-scope promotion.',
    properties: {
      validated: { type: 'boolean', required: true },
      evaluation_ids: { type: 'array', items: { type: 'string' }, default: [] },
      approved_by: { type: 'string', nullable: true },
      approved_at: { type: 'string', nullable: true, pattern: ISO_DATE },
    },
  },
  status: { type: 'string', required: true, enum: ['pending', 'canary', 'active', 'superseded', 'rolled-back'], default: 'pending' },
}, (release) => {
  if (release.status === 'active' && !release.evidence?.validated) {
    return 'an active release must carry validation evidence (C-31)';
  }
  return null;
});

// ── Evaluation: a pinned baseline/candidate comparison ─────────────────

export const EVALUATION_SCHEMA = schema('fleetEvaluation', 1, {
  id: { type: 'string', required: true, pattern: /^fe-[a-z0-9-]+$/ },
  schema_version: { type: 'integer', required: true, min: 1 },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  suite_id: { type: 'string', required: true, pattern: ID_PATTERN },
  // Both sides pinned, or the comparison measures the wrong thing.
  baseline: {
    type: 'object', required: true,
    properties: {
      release: { type: 'string', nullable: true },
      agent_spec_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
      platform_version: { type: 'string', required: true },
      model: { type: 'string', required: true },
    },
  },
  candidate: {
    type: 'object', required: true,
    properties: {
      change_id: { type: 'string', nullable: true },
      agent_spec_digest: { type: 'string', required: true, pattern: DIGEST_PATTERN },
      platform_version: { type: 'string', required: true },
      model: { type: 'string', required: true },
    },
  },
  results: {
    type: 'array', required: true,
    items: {
      type: 'object',
      properties: {
        case_id: { type: 'string', required: true },
        baseline_pass: { type: 'boolean', required: true },
        candidate_pass: { type: 'boolean', required: true },
        verdict: { type: 'string', required: true, enum: ['improved', 'unchanged', 'regressed'] },
        notes: { type: 'string' },
      },
    },
  },
  metrics: {
    type: 'object', open: true, default: {},
    describe: 'Pass rate, iterations, tool errors, cost, latency — the §12 measures',
  },
  status: { type: 'string', required: true, enum: ['running', 'complete', 'failed'], default: 'running' },
}, (evaluation) => {
  if (evaluation.baseline?.model && evaluation.candidate?.model &&
      evaluation.baseline.model !== evaluation.candidate.model) {
    // Changing the model and the content at once means neither can be blamed.
    return 'baseline and candidate use different models — the comparison cannot attribute a difference to the content';
  }
  return null;
});

// ── Assignment: what one agent should be running ───────────────────────

export const ASSIGNMENT_SCHEMA = schema('fleetAssignment', 1, {
  id: { type: 'string', required: true, pattern: ID_PATTERN, describe: 'The agent id' },
  schema_version: { type: 'integer', required: true, min: 1 },
  role_id: { type: 'string', required: true, pattern: ID_PATTERN },
  desired_release: { type: 'string', required: true, pattern: /^fr-[a-z0-9-]+$/ },
  desired_spec_digest: {
    type: 'string', nullable: true, pattern: DIGEST_PATTERN,
    describe: 'The exact bundle approved for this agent. Null means "compile from the release '
      + 'and attest what you got" — a spec digest also depends on the firmware installed on '
      + 'the VM, which the control plane does not hold.',
  },
  actual_release: { type: 'string', nullable: true, pattern: /^fr-[a-z0-9-]+$/ },
  actual_spec_digest: { type: 'string', nullable: true, pattern: DIGEST_PATTERN },
  pinned: {
    type: 'boolean', default: false,
    describe: 'A pinned agent does not follow fleet-wide promotion — used for canaries and for holding an agent back',
  },
  applied_at: { type: 'string', nullable: true, pattern: ISO_DATE },
  drift: {
    type: 'string', enum: ['converged', 'pending', 'failed'], default: 'pending',
    describe: 'Derived: desired vs actual. `failed` is actionable, `pending` is normal between release and idle boundary.',
  },
  last_error: { type: 'string', nullable: true },
  updated_at: { type: 'string', required: true, pattern: ISO_DATE },
});

// ── Rollout: a governed promotion in flight ────────────────────────────

export const ROLLOUT_SCHEMA = schema('fleetRollout', 1, {
  id: { type: 'string', required: true, pattern: /^ro-[a-z0-9-]+$/ },
  schema_version: { type: 'integer', required: true, min: 1 },
  release_id: { type: 'string', required: true, pattern: /^fr-[a-z0-9-]+$/ },
  rollback_target: { type: 'string', required: true, pattern: /^fr-[a-z0-9-]+$/, describe: 'Named up front — never worked out during an incident' },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  cohort: {
    type: 'object', required: true,
    properties: {
      stage: { type: 'string', required: true, enum: ['canary', 'partial', 'fleet'] },
      agent_ids: { type: 'array', required: true, items: { type: 'string', pattern: ID_PATTERN } },
    },
  },
  thresholds: {
    type: 'object', required: true,
    describe: 'Breaching any of these pauses or rolls back automatically',
    properties: {
      min_pass_rate: { type: 'number', min: 0, max: 1, default: 0.9 },
      max_false_complete_rate: { type: 'number', min: 0, max: 1, default: 0.02 },
      max_tool_error_rate: { type: 'number', min: 0, max: 1, default: 0.2 },
      observation_missions: { type: 'integer', min: 1, default: 5, describe: 'How much evidence before a verdict' },
    },
  },
  observed: { type: 'object', open: true, default: {} },
  status: {
    type: 'string', required: true,
    enum: ['pending', 'observing', 'promoted', 'paused', 'rolled-back'],
    default: 'pending',
  },
  status_reason: { type: 'string', nullable: true },
  approved_by: { type: 'string', nullable: true },
});

// ── Platform Finding: the only bridge out of this plane (C-34) ─────────

export const PLATFORM_FINDING_SCHEMA = schema('platformFinding', 1, {
  id: { type: 'string', required: true, pattern: /^pf-[a-z0-9-]+$/ },
  schema_version: { type: 'integer', required: true, min: 1 },
  created_at: { type: 'string', required: true, pattern: ISO_DATE },
  created_by: { type: 'string', required: true, minLength: 1 },
  title: { type: 'string', required: true, minLength: 10, maxLength: 200 },
  severity: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
  frequency: { type: 'string', required: true, describe: 'How often this is hit, with the evidence that says so' },
  affected_scope: { type: 'string', required: true, describe: 'Which agents, roles or projects' },

  // Version coordinates: without these a maintainer cannot reproduce anything.
  platform_version: { type: 'string', required: true },
  fleet_release: { type: 'string', nullable: true },
  agent_spec_digest: { type: 'string', nullable: true, pattern: DIGEST_PATTERN },

  evidence: {
    type: 'object', required: true,
    properties: {
      mission_ids: { type: 'array', required: true, items: { type: 'string' }, minLength: 1 },
      logs: { type: 'string', maxLength: 20000, describe: 'Sanitized. The secret scan below gates this field.' },
      reproduction: { type: 'string', describe: 'Deterministic steps or a minimal fixture, where one exists' },
    },
  },
  desired_invariant: {
    type: 'string', required: true, minLength: 20,
    describe: 'The outcome that should hold — not an implementation demand. Maintainers design the fix.',
  },
  why_not_definition: {
    type: 'string', required: true, minLength: 20,
    describe: 'Why no Fleet Definition solves this. A finding that could have been a definition is drift with paperwork.',
  },
  required_class: {
    type: 'string', required: true,
    enum: ['provider', 'permission', 'schema', 'state-transition', 'runtime-mechanism', 'security', 'other'],
  },
  workaround: {
    type: 'object', nullable: true,
    properties: {
      description: { type: 'string', required: true },
      limitations: { type: 'string', required: true, describe: 'A workaround presented without its limits invites over-reliance' },
    },
  },
  privacy_scan: {
    type: 'object', required: true,
    describe: 'A finding leaves the deployment. It does not leave unscanned (C-8).',
    properties: {
      scanned_at: { type: 'string', required: true, pattern: ISO_DATE },
      secrets_found: { type: 'integer', required: true, min: 0 },
      pii_found: { type: 'integer', required: true, min: 0 },
    },
  },
  status: {
    type: 'string', required: true,
    enum: ['open', 'acknowledged', 'in-progress', 'released', 'declined', 'duplicate'],
    default: 'open',
  },
  resolution: { type: 'string', nullable: true, describe: 'Which platform release addressed it' },
}, (finding) => {
  const scan = finding.privacy_scan;
  if (scan && (scan.secrets_found > 0 || scan.pii_found > 0)) {
    return 'the privacy scan found secrets or PII — sanitize before filing (C-8)';
  }
  return null;
});
