// tests/baton.test.mjs — pure tests for the intra-mission checkpoint hand-off core.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sameAgent, effectiveAssignee, missionOriginator, checkpointAssignee,
  decideHop, myRunEnd, handoffPatch, isBatonStale, reclaimPatch, handoffModelEnabled,
  deriveHandoffCheckpoints, resolveAssignee,
} from '../platform/work/baton.mjs';

// A project team roster shaped like projects/{id}.team (marketing-site).
const ROSTER = [
  { email: 'chill@example.com', role: 'owner', name: 'Christopher', type: 'human' },
  { email: 'product-architect-agent-archie@example.com', role: 'lead', name: 'Archie', type: 'agent' },
  { email: 'devops-agent-stan@example.com', role: 'devops', name: 'Stan', type: 'agent' },
  { email: 'designer-agent-dot@example.com', role: 'designer', name: 'Dot', type: 'agent' },
  { email: 'engineer-agent-bobby@example.com', role: 'engineer', name: 'Bobby', type: 'agent' },
];

const A = 'product-architect-agent-archie@example.com';
const B = 'engineer-agent-bobby@example.com';
const C = 'devops-agent-stan@example.com';
const cp = (status, assignee) => ({ status, ...(assignee ? { assignee } : {}) });

describe('sameAgent', () => {
  it('matches by localpart, case-insensitively', () => {
    assert.equal(sameAgent(A, 'PRODUCT-ARCHITECT-AGENT-ARCHIE@example.com'), true);
    assert.equal(sameAgent(A, B), false);
    assert.equal(sameAgent('', A), false);
    assert.equal(sameAgent(null, undefined), false);
  });
});

describe('identity shims', () => {
  it('effectiveAssignee prefers assignee then owner', () => {
    assert.equal(effectiveAssignee({ assignee: B, owner: A }), B);
    assert.equal(effectiveAssignee({ owner: A }), A); // shim when assignee unset
    assert.equal(effectiveAssignee({}), '');
  });
  it('missionOriginator prefers originator then owner', () => {
    assert.equal(missionOriginator({ originator: A, assignee: B, owner: B }), A);
    assert.equal(missionOriginator({ owner: A }), A); // shim
  });
  it('checkpointAssignee defaults to the originator', () => {
    assert.equal(checkpointAssignee({ assignee: B }, A), B);
    assert.equal(checkpointAssignee({}, A), A);
    assert.equal(checkpointAssignee(null, A), A);
  });
});

describe('decideHop', () => {
  it('EXECUTE when the first incomplete checkpoint is mine (default = originator)', () => {
    const spine = [cp('complete'), cp('pending')]; // cp2 has no assignee → originator A
    assert.deepEqual(decideHop(spine, { me: A, originator: A }), { action: 'execute', index: 1 });
  });
  it('HANDOFF when the first incomplete checkpoint belongs to a teammate', () => {
    const spine = [cp('complete'), cp('pending', B)];
    assert.deepEqual(decideHop(spine, { me: A, originator: A }), { action: 'handoff', to: B, index: 1 });
  });
  it('the delegate EXECUTES its own assigned checkpoint', () => {
    const spine = [cp('complete'), cp('pending', B)];
    assert.deepEqual(decideHop(spine, { me: B, originator: A }), { action: 'execute', index: 1 });
  });
  it('HANDBACK to originator when all remaining is done and I am not the originator', () => {
    const spine = [cp('complete'), cp('complete', B)];
    assert.deepEqual(decideHop(spine, { me: B, originator: A }), { action: 'handback', to: A });
  });
  it('SYNTHESIZE when the whole spine is complete and I am the originator', () => {
    const spine = [cp('complete'), cp('complete', B)];
    assert.deepEqual(decideHop(spine, { me: A, originator: A }), { action: 'synthesize' });
  });
  it('a failed checkpoint counts as not-complete (re-run/hand-off it)', () => {
    const spine = [cp('complete'), cp('failed', B)];
    assert.deepEqual(decideHop(spine, { me: A, originator: A }), { action: 'handoff', to: B, index: 1 });
  });
});

describe('myRunEnd', () => {
  it('returns the contiguous run of my checkpoints from startIndex', () => {
    // A owns cp0,cp1 (default); B owns cp2; A owns cp3
    const spine = [cp('pending'), cp('pending'), cp('pending', B), cp('pending')];
    assert.equal(myRunEnd(spine, { me: A, originator: A, startIndex: 0 }), 2); // runs 0,1 then hands off at 2
    assert.equal(myRunEnd(spine, { me: B, originator: A, startIndex: 2 }), 3); // B runs only cp2
    assert.equal(myRunEnd(spine, { me: A, originator: A, startIndex: 3 }), 4); // A runs cp3 to end
  });
});

describe('handoffPatch', () => {
  it('produces a disjoint field patch that queues the mission to the new assignee', () => {
    const env = { assignee: A, owner: A, _baton: { turn: 1 } };
    const p = handoffPatch(env, B, { now: 1_000_000, leaseMs: 60_000 });
    assert.equal(p.assignee, B);
    assert.equal(p.status, 'queued');
    assert.equal(p._baton.turn, 2);      // incremented
    assert.equal(p._baton.from, A);
    assert.equal(p._baton.to, B);
    assert.equal(p._baton.lease_expiry, new Date(1_060_000).toISOString());
    // the patch touches only routing fields — never tasks/spine/output
    assert.deepEqual(Object.keys(p).sort(), ['_baton', 'assignee', 'status', 'updated_at']);
  });
  it('starts turn at 1 when there is no prior baton', () => {
    assert.equal(handoffPatch({ owner: A }, B, { now: 1 })._baton.turn, 1);
  });
});

describe('isBatonStale / reclaimPatch', () => {
  it('is stale only when assigned away AND past the lease', () => {
    const env = { originator: A, assignee: B, owner: A, _baton: { lease_expiry: new Date(1000).toISOString() } };
    assert.equal(isBatonStale(env, 2000), true);   // past lease, away from originator
    assert.equal(isBatonStale(env, 500), false);   // not yet expired
  });
  it('is never stale while the mission sits with its originator', () => {
    const env = { originator: A, assignee: A, owner: A, _baton: { lease_expiry: new Date(1).toISOString() } };
    assert.equal(isBatonStale(env, 9_999_999), false);
  });
  it('reclaimPatch routes back to the originator and bumps the turn', () => {
    const env = { originator: A, assignee: B, owner: A, _baton: { turn: 3 } };
    const p = reclaimPatch(env, { now: 5 });
    assert.equal(p.assignee, A);
    assert.equal(p.status, 'queued');
    assert.equal(p._baton.turn, 4);
    assert.equal(p._baton.reclaimed, true);
  });
});

describe('deriveHandoffCheckpoints', () => {
  it('turns a delegation task into a checkpoint assignee and de-delegates its tasks', () => {
    const cps = [
      { instruction: 'edit', tasks: [{ type: 'delegation', target_email: B, _specialty: 'engineer', task: 'edit index.html', accept_criteria: 'done' }] },
      { instruction: 'deliver', tasks: [{ agent: 'motor', type: 'standard', task: 'report' }] },
    ];
    const out = deriveHandoffCheckpoints(cps);
    assert.equal(out[0].assignee, B);
    assert.equal(out[0].tasks[0].agent, 'motor');
    assert.equal(out[0].tasks[0].type, 'standard');
    assert.equal(out[0].tasks[0].target_email, undefined); // stripped — no nested delegation
    assert.equal(out[0].tasks[0].task, 'edit index.html');  // instruction preserved
    assert.ok(!out[1].assignee); // no teammate signal → stays the originator's (null/undefined)
  });
  it('honors an explicit checkpoint assignee', () => {
    const out = deriveHandoffCheckpoints([{ assignee: C, tasks: [{ agent: 'motor', task: 'x' }] }]);
    assert.equal(out[0].assignee, C);
  });
  it('is a no-op on empty/absent input', () => {
    assert.deepEqual(deriveHandoffCheckpoints([]), []);
    assert.deepEqual(deriveHandoffCheckpoints(null), []);
  });
});

describe('resolveAssignee (roster resolution — the canary bug)', () => {
  it('repairs the planner-hallucinated pattern email via the specialty signal', () => {
    // The exact live failure: planner emitted engineer-agent@<operator-domain> (wrong domain,
    // missing -bobby) with agent="engineer". Resolve by role -> the roster's real address.
    assert.equal(
      resolveAssignee(ROSTER, { target_email: 'engineer-agent@example.com', agent: 'engineer' }),
      'engineer-agent-bobby@example.com',
    );
    assert.equal(
      resolveAssignee(ROSTER, { target_email: 'devops-agent@example.com', _specialty: 'devops' }),
      'devops-agent-stan@example.com',
    );
  });
  it('honors a verbatim-correct email (case-insensitive) and returns the canonical form', () => {
    assert.equal(resolveAssignee(ROSTER, { target_email: 'ENGINEER-AGENT-BOBBY@example.com' }), 'engineer-agent-bobby@example.com');
  });
  it('resolves a specialty whose role label differs, via the email localpart token', () => {
    // product-architect maps to role "lead"; match the specialty token in the member email.
    assert.equal(resolveAssignee(ROSTER, { agent: 'product-architect' }), 'product-architect-agent-archie@example.com');
  });
  it('resolves by teammate name', () => {
    assert.equal(resolveAssignee(ROSTER, { target_name: 'Bobby' }), 'engineer-agent-bobby@example.com');
  });
  it('NEVER resolves to a human — batons route to agent daemons', () => {
    assert.equal(resolveAssignee(ROSTER, { target_email: 'chill@example.com' }), null);
  });
  it('returns null when nothing matches (caller keeps the originator, never strands)', () => {
    assert.equal(resolveAssignee(ROSTER, { agent: 'astrophysicist' }), null);
    assert.equal(resolveAssignee(ROSTER, {}), null);
  });
  it('with no roster, falls back to the raw target_email (legacy passthrough)', () => {
    assert.equal(resolveAssignee([], { target_email: 'x@y.z' }), 'x@y.z');
    assert.equal(resolveAssignee(undefined, { _specialty: 'engineer' }), null);
  });
});

describe('deriveHandoffCheckpoints with roster', () => {
  it('pins the RESOLVED roster email as assignee, not the hallucinated one', () => {
    const cps = [
      { instruction: 'edit', tasks: [{ type: 'delegation', agent: 'engineer', target_email: 'engineer-agent@example.com', task: 'edit index.html' }] },
      { instruction: 'deploy', tasks: [{ type: 'delegation', agent: 'devops', target_email: 'devops-agent@example.com', task: 'deploy' }] },
      { instruction: 'report', tasks: [{ agent: 'motor', type: 'standard', task: 'report' }] },
    ];
    const out = deriveHandoffCheckpoints(cps, ROSTER);
    assert.equal(out[0].assignee, 'engineer-agent-bobby@example.com');
    assert.equal(out[1].assignee, 'devops-agent-stan@example.com');
    assert.ok(!out[2].assignee);            // originator keeps the report
    assert.equal(out[0].tasks[0].agent, 'motor');       // de-delegated
    assert.equal(out[0].tasks[0].target_email, undefined);
    assert.equal(out[0].tasks[0].task, 'edit index.html');
  });
  it('keeps the originator when a delegation cannot be resolved (no strand)', () => {
    const cps = [{ instruction: 'x', tasks: [{ type: 'delegation', agent: 'astrophysicist', task: 'x' }] }];
    const out = deriveHandoffCheckpoints(cps, ROSTER);
    assert.ok(!out[0].assignee);            // unresolved -> stays with originator
    assert.equal(out[0].tasks[0].type, 'delegation'); // not de-delegated (no assignee)
  });
});

describe('handoffModelEnabled', () => {
  it('is off unless dispatch.delegation.model === "handoff"', () => {
    assert.equal(handoffModelEnabled({ dispatch: { delegation: { model: 'handoff' } } }), true);
    assert.equal(handoffModelEnabled({ dispatch: { delegation: { model: 'child-mission' } } }), false);
    assert.equal(handoffModelEnabled({ dispatch: {} }), false);
    assert.equal(handoffModelEnabled({}), false);
    assert.equal(handoffModelEnabled(undefined), false);
  });
});
