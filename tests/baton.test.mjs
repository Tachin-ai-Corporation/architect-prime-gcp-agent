// tests/baton.test.mjs — pure tests for the intra-mission checkpoint hand-off core.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sameAgent, effectiveAssignee, missionOriginator, checkpointAssignee,
  decideHop, myRunEnd, handoffPatch, isBatonStale, reclaimPatch, handoffModelEnabled,
  deriveHandoffCheckpoints,
} from '../corekit/lib/baton.mjs';

const A = 'product-architect-agent-archie@tachin.ag';
const B = 'engineer-agent-bobby@tachin.ag';
const C = 'devops-agent-stan@tachin.ag';
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

describe('handoffModelEnabled', () => {
  it('is off unless dispatch.delegation.model === "handoff"', () => {
    assert.equal(handoffModelEnabled({ dispatch: { delegation: { model: 'handoff' } } }), true);
    assert.equal(handoffModelEnabled({ dispatch: { delegation: { model: 'child-mission' } } }), false);
    assert.equal(handoffModelEnabled({ dispatch: {} }), false);
    assert.equal(handoffModelEnabled({}), false);
    assert.equal(handoffModelEnabled(undefined), false);
  });
});
