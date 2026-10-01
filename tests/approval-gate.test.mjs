// tests/approval-gate.test.mjs — an approval gate asks the right person the right question,
// and only its owner resumes it.
//
// 2026-10-01: a fleet agent's scheduled weekly briefing planned an approval gate before its
// delivery step. Three things went wrong, and these tests pin each fix:
//   1. The approval's description read "Approval granted." while it was still pending —
//      the gate's own pass condition, written where the request's description belongs.
//   2. Its notification was marked 'internal' because the mission had a parent (the
//      Responsibility that fired it), so it was never delivered — nobody was told.
//   3. When the operator approved, the PRIME's poller resumed it: a Prime has no Workspace
//      email, and a poller with no identity resumed every agent's gates. The delivery ran on
//      the Prime's host, where the agent's Drive and Docs tools do not exist, and re-planned
//      until it blocked.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ownsApproval, describeApprovalGate, createApprovalChecker } from '../platform/work/approvals.mjs';
import { executeCheckpoints } from '../platform/work/checkpoint-executor.mjs';

const MILLIE = 'assistant-agent-millie@example.com';

describe('ownsApproval', () => {
  it('REPRODUCES the incident: a Prime with no email does not own a fleet agent\'s gate', () => {
    assert.equal(ownsApproval({ owner: MILLIE }, null, ['', 'prime'].filter(Boolean)), false);
  });

  it('a Prime owns its own gates — it stamps its agent id as owner', () => {
    assert.equal(ownsApproval({ owner: 'prime' }, null, ['prime']), true);
  });

  it('a fleet agent owns its gates by email', () => {
    assert.equal(ownsApproval({ owner: MILLIE }, null, [MILLIE, 'millie']), true);
    assert.equal(ownsApproval({ owner: 'devops-agent-stan@example.com' }, null, [MILLIE, 'millie']), false);
  });

  it('a doc written before the owner stamp falls back to the envelope\'s owner', () => {
    assert.equal(ownsApproval({}, { owner: MILLIE }, [MILLIE]), true);
    assert.equal(ownsApproval({}, { owner: MILLIE }, ['prime']), false);
  });

  it('no owner anywhere, or no identity, is never "mine"', () => {
    assert.equal(ownsApproval({}, {}, [MILLIE]), false);
    assert.equal(ownsApproval({ owner: MILLIE }, null, []), false);
    assert.equal(ownsApproval({ owner: MILLIE }, null, undefined), false);
  });
});

describe('describeApprovalGate', () => {
  it('says what runs once approved, in order', () => {
    const d = describeApprovalGate({ next: ['Trash today\'s earlier doc, then create the briefing.', 'Read it back.'] });
    assert.equal(d, 'If approved, this runs next: Trash today\'s earlier doc, then create the briefing. Then: Read it back.');
  });

  it('an explicit approval message wins', () => {
    assert.equal(describeApprovalGate({ message: 'Promote acme to production.', next: ['x'] }), 'Promote acme to production.');
  });

  it('a gate with nothing after it says so instead of going blank', () => {
    assert.match(describeApprovalGate({ next: [] }), /finishes and reports/);
    assert.match(describeApprovalGate(), /finishes and reports/);
  });

  it('is clipped, and marked when it is', () => {
    const d = describeApprovalGate({ next: ['y'.repeat(5000)], maxChars: 200 });
    assert.equal(d.length, 200);
    assert.ok(d.endsWith('…'));
  });
});

// ---- The poller, driven through its real Firestore REST calls ----
describe('the approval poller resumes only its owner\'s gates', () => {
  let realFetch;
  let realToken;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    realToken = process.env.GCP_TOKEN;
    process.env.GCP_TOKEN = 'test-token';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.GCP_TOKEN; else process.env.GCP_TOKEN = realToken;
  });

  // One approved gate in the prime-wide collection, owned by `owner`.
  function world(owner) {
    const patched = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith(':runQuery')) {
        const body = JSON.parse(init.body);
        const status = body.structuredQuery.where.compositeFilter.filters[1].fieldFilter.value.stringValue;
        const rows = status !== 'approved' ? [] : [{ document: {
          name: 'projects/p/databases/(default)/documents/approvals/apr-1',
          fields: {
            envelopeId: { stringValue: 'w-m1' },
            status: { stringValue: 'approved' },
            ...(owner ? { owner: { stringValue: owner } } : {}),
          },
        } }];
        return { ok: true, json: async () => rows };
      }
      patched.push(String(url));
      return { ok: true, json: async () => ({}) };
    };
    const resumed = [];
    const envelope = {
      id: 'w-m1', type: 'M', owner: MILLIE, status: 'awaiting_approval', instruction: 'weekly briefing',
      _cp_spine: [{ status: 'complete' }, { status: 'pending' }],
      source_meta: { paused_checkpoint_index: 1, paused_task_index: 0 },
    };
    return { patched, resumed, envelope };
  }

  async function poll(identity, w) {
    const checker = createApprovalChecker({
      config: { primeId: 'cand', gcpProject: 'p', ...identity },
      resumeCheckpointPlan: async (env) => { w.resumed.push(env.id); },
      processEnvelope: async () => { throw new Error('must resume the plan, not re-decide'); },
      recallMemory: async () => ({}),
      firestoreWrite: async () => {},
      firestoreRead: async (col, id) => (col === 'work' && id === 'w-m1' ? structuredClone(w.envelope) : null),
      writeHistory: async () => {},
      logger: () => {},
    });
    for (let i = 0; i < 5; i++) await checker.checkPending(); // it polls on every 5th call
  }

  it('REPRODUCES the incident: the Prime (no email) leaves a fleet agent\'s approved gate alone', async () => {
    const w = world(MILLIE);
    await poll({ agentEmail: '', agentId: 'prime' }, w);
    assert.deepEqual(w.resumed, [], 'the Prime must not run the agent\'s work on its own host');
    assert.equal(w.patched.length, 0, 'and must not mark it processed — its owner still has to pick it up');
  });

  it('the owning agent resumes it, once, and marks it processed', async () => {
    const w = world(MILLIE);
    await poll({ agentEmail: MILLIE, agentId: 'millie' }, w);
    assert.deepEqual(w.resumed, ['w-m1']);
    assert.ok(w.patched.some(u => u.includes('approvals/apr-1') && u.includes('_processed')));
  });

  it('a doc without an owner stamp is resumed by the envelope\'s owner only', async () => {
    const prime = world(undefined);
    await poll({ agentEmail: '', agentId: 'prime' }, prime);
    assert.deepEqual(prime.resumed, []);
    const millie = world(undefined);
    await poll({ agentEmail: MILLIE, agentId: 'millie' }, millie);
    assert.deepEqual(millie.resumed, ['w-m1']);
  });

  it('a brain with no identity at all resumes nothing', async () => {
    const w = world(MILLIE);
    await poll({}, w);
    assert.deepEqual(w.resumed, []);
  });
});

// ---- The gate as the executor raises it ----
describe('an approval gate in a scheduled mission', () => {
  let realFetch;
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function raiseGate(checkpoints, { parentId = 'w-r1', savedResults = [] } = {}) {
    const approvals = [];
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes('/approvals/')) approvals.push(JSON.parse(init.body).fields);
      return { ok: true, json: async () => ({}) };
    };
    const writes = [];
    const notified = [];
    let n = 0;
    const envelope = {
      id: 'w-m1', type: 'M', parent_id: parentId, owner: MILLIE, status: 'active',
      instruction: 'Produce this week\'s briefing', source_channel: 'scheduler',
      source_meta: { responsibility_id: 'r-weekly-briefing' }, children: [], iteration: 1,
    };
    const result = await executeCheckpoints(checkpoints, {
      envelope,
      dispatchAgent: async () => { throw new Error('nothing may run before the gate is approved'); },
      firestoreWrite: async (col, id, doc) => { writes.push({ col, id, doc: structuredClone(doc) }); },
      firestoreRead: async () => null,
      writeHistory: async () => {},
      generateId: (p) => `${p}-${++n}`,
      buildProjectContext: () => '',
      log: () => {},
      getAuthToken: async () => 'tok',
      FIRESTORE_BASE: 'https://firestore.test/v1/projects/p/databases/(default)/documents',
      PRIME_ID: 'cand',
      AGENT_EMAIL: MILLIE,
      AGENT_ID: 'millie',
      addressFromMeta: () => ({ channel: 'dashboard', fleet_agent: null }),
      summarizeForDelivery: async (type, fallback, ctx) => { notified.push(ctx); return fallback; },
      savedResults,
    });
    const notification = writes.find(w => w.col === 'work' && w.doc.intent === 'notification')?.doc;
    return { result, approval: approvals[0], notification, notified };
  }

  const PLAN = [
    {
      instruction: 'Gather this week\'s notes and write the briefing',
      tasks: [{ agent: 'motor', task: 'Gather and synthesize.' }],
    },
    {
      instruction: 'Publish and verify the briefing',
      tasks: [
        { agent: 'motor', type: 'approval_gate', task: 'Trash any existing copy of today\'s briefing and create a new one. Approve to proceed.', accept_criteria: 'Approval granted.' },
        { agent: 'motor', task: 'Trash today\'s earlier copy, create the branded doc, and read it back.' },
      ],
    },
  ];
  const PRIOR = [{ step: '1.1', agent: 'motor', success: true, result: 'Saved four transcripts from this week and drafted the briefing.' }];

  it('pauses at the gate without running the gated work', async () => {
    const { result } = await raiseGate(PLAN.slice(1), { savedResults: PRIOR });
    assert.equal(result.paused, true);
    assert.ok(result.approvalId);
  });

  it('describes what runs once approved — never the gate\'s own pass condition', async () => {
    const { approval } = await raiseGate(PLAN.slice(1), { savedResults: PRIOR });
    const description = approval.description.stringValue;
    assert.notEqual(description, 'Approval granted.');
    assert.equal(description, 'If approved, this runs next: Trash today\'s earlier copy, create the branded doc, and read it back.');
  });

  it('a gate that ends its checkpoint describes the next checkpoint', async () => {
    const plan = [
      { instruction: 'Draft the briefing', tasks: [{ agent: 'motor', type: 'approval_gate', task: 'Approve the draft.', accept_criteria: 'Approval granted.' }] },
      { instruction: 'Publish the briefing to the output folder', tasks: [{ agent: 'motor', task: 'Publish.' }] },
    ];
    const { approval } = await raiseGate(plan);
    assert.equal(approval.description.stringValue, 'If approved, this runs next: Publish the briefing to the output folder');
  });

  it('REPRODUCES the incident: a responsibility-fired mission\'s gate is DELIVERED, not internal', async () => {
    const { notification } = await raiseGate(PLAN.slice(1), { parentId: 'w-r1', savedResults: PRIOR });
    assert.equal(notification.delivery_status, 'pending');
    assert.deepEqual(notification.delivery_address, { channel: 'dashboard', fleet_agent: null });
  });

  it('a top-level mission\'s gate is delivered as before', async () => {
    const { notification } = await raiseGate(PLAN.slice(1), { parentId: null, savedResults: PRIOR });
    assert.equal(notification.delivery_status, 'pending');
  });

  it('the notification writer gets the work done so far and what runs next', async () => {
    const { notified } = await raiseGate(PLAN.slice(1), { savedResults: PRIOR });
    assert.equal(notified.length, 1);
    assert.match(notified[0].customMessage, /^If approved, this runs next:/);
    assert.deepEqual(notified[0].steps.map(s => s.step), ['1.1'], 'a gate that opens its checkpoint still reports the earlier work');
  });
});
