// tests/checkpoint-spine.test.mjs — pure-core tests for corekit/lib/checkpoint-spine.mjs (B-19)
//
// The pathology being prevented, from mission w-1785088147648-98907cc3:
//   17:54:36  Cerebellum PASS on CP1 milestone
//   17:54:37  CP2 Task 1/3 → six failed syntax attempts
//   17:57:09  Prefrontal structured 2 checkpoints… CP1 Task 1/3: Understand the master…
//   17:57:38  Cerebellum FAIL on CP1        ← a PASSED checkpoint, un-passed
// A CP2 failure must never cost CP1's verdict.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpine, firstIncompleteIndex, markCheckpoint, applyReplan, rebuildFromSpine, spineSummary,
  finalizeBlockedBySpine,
} from '../corekit/lib/checkpoint-spine.mjs';

const PLAN = [
  { instruction: 'Gather all required information', accept_criteria: 'Template + contracts read', tasks: [{ agent: 'motor', task: 'read template' }] },
  { instruction: 'Create and fill the addendums', accept_criteria: 'Three drafts exist', tasks: [{ agent: 'motor', task: 'clone template' }] },
  { instruction: 'File them', accept_criteria: 'All three in In Progress', tasks: [{ agent: 'motor', task: 'move' }] },
];

describe('buildSpine', () => {
  it('captures outcome, criteria and tasks, all pending', () => {
    const s = buildSpine(PLAN, { now: 'T0' });
    assert.equal(s.length, 3);
    assert.deepEqual(s.map(x => x.n), [1, 2, 3]);
    assert.equal(s[0].outcome, 'Gather all required information');
    assert.equal(s[1].accept_criteria, 'Three drafts exist');
    assert.equal(s[0].tasks.length, 1);
    assert.ok(s.every(x => x.status === 'pending' && x.criteria_revisions === 0));
  });

  it('tolerates a malformed plan', () => {
    assert.deepEqual(buildSpine(null), []);
    assert.deepEqual(buildSpine([]), []);
    const s = buildSpine([{}], { now: 'T' });
    assert.equal(s[0].outcome, 'Checkpoint 1');
    assert.deepEqual(s[0].tasks, []);
  });
});

describe('firstIncompleteIndex / rebuildFromSpine', () => {
  it('starts at 0 on a fresh spine', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.equal(firstIncompleteIndex(s), 0);
    assert.equal(rebuildFromSpine(s).startCpIndex, 0);
  });

  it('skips completed checkpoints by starting past them', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    assert.equal(firstIncompleteIndex(s), 1, 'CP1 done → resume at CP2');
    const { checkpoints, startCpIndex, allComplete } = rebuildFromSpine(s);
    assert.equal(startCpIndex, 1);
    assert.equal(checkpoints.length, 3, 'the whole plan is still described');
    assert.equal(allComplete, false);
  });

  it('reports allComplete when every checkpoint passed', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    for (let i = 0; i < 3; i++) s = markCheckpoint(s, i, 'complete', { now: 'T' });
    assert.equal(firstIncompleteIndex(s), -1);
    const r = rebuildFromSpine(s);
    assert.equal(r.allComplete, true);
    assert.equal(r.startCpIndex, 3);
  });

  it('round-trips the executor shape', () => {
    const { checkpoints } = rebuildFromSpine(buildSpine(PLAN, { now: 'T' }));
    assert.deepEqual(checkpoints, PLAN.map(cp => ({
      instruction: cp.instruction, accept_criteria: cp.accept_criteria, tasks: cp.tasks,
    })));
  });
});

describe('markCheckpoint', () => {
  it('does not mutate the input', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const out = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    assert.equal(s[0].status, 'pending', 'original untouched');
    assert.equal(out[0].status, 'complete');
    assert.equal(out[0].completed_at, 'T1');
  });

  it('ignores an out-of-range index instead of throwing', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.equal(markCheckpoint(s, 99, 'complete').length, 3);
    assert.equal(markCheckpoint(s, -1, 'complete').length, 3);
  });
});

describe('applyReplan — the whole point', () => {
  it('re-tasks ONE checkpoint and preserves a passed verdict', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });          // CP1 passed
    s = markCheckpoint(s, 1, 'failed', { now: 'T2' });            // CP2 failed
    const { spine } = applyReplan(s, 1, [{ agent: 'motor', task: 'docs-clone-template' }], { now: 'T3' });

    assert.equal(spine[0].status, 'complete', 'CP1 KEEPS its verdict — the regression under test');
    assert.equal(spine[0].tasks[0].task, 'read template', 'CP1 tasks untouched');
    assert.equal(spine[1].status, 'pending', 'CP2 is runnable again');
    assert.equal(spine[1].tasks[0].task, 'docs-clone-template', 'CP2 got the new tasks');
    assert.equal(spine[2].tasks[0].task, 'move', 'CP3 untouched');
    assert.equal(firstIncompleteIndex(spine), 1, 'execution resumes at CP2, not CP1');
  });

  it('pins criteria by default, allowing exactly one refinement', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const first = applyReplan(s, 0, [], { newCriteria: 'Reworded once', now: 'T1' });
    assert.equal(first.criteriaChanged, true);
    assert.equal(first.spine[0].accept_criteria, 'Reworded once');
    assert.equal(first.spine[0].criteria_revisions, 1);

    const second = applyReplan(first.spine, 0, [], { newCriteria: 'Reworded twice', now: 'T2' });
    assert.equal(second.criteriaChanged, false, 'second rewording refused');
    assert.equal(second.revisionRefused, true, 'and reported, not silent');
    assert.equal(second.spine[0].accept_criteria, 'Reworded once', 'pinned wording holds');
  });

  it('does not count a no-op restatement as a revision', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const r = applyReplan(s, 0, [], { newCriteria: '  Template + contracts read  ', now: 'T1' });
    assert.equal(r.criteriaChanged, false);
    assert.equal(r.spine[0].criteria_revisions, 0);
  });

  it('honours pinCriteria:false as a full escape', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    s = applyReplan(s, 0, [], { newCriteria: 'A', now: 'T' }).spine;
    const r = applyReplan(s, 0, [], { newCriteria: 'B', pinCriteria: false, now: 'T' });
    assert.equal(r.spine[0].accept_criteria, 'B');
    assert.equal(r.revisionRefused, false);
  });

  it('keeps existing tasks when the re-plan yields none', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const r = applyReplan(s, 1, [], { now: 'T' });
    assert.equal(r.spine[1].tasks[0].task, 'clone template', 'empty re-plan must not blank the checkpoint');
  });

  it('is a no-op on an out-of-range index', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    assert.deepEqual(applyReplan(s, 9, [{ agent: 'motor', task: 'x' }], { now: 'T' }).spine, s);
  });
});

describe('spineSummary', () => {
  it('counts states for the telemetry line', () => {
    let s = buildSpine(PLAN, { now: 'T' });
    assert.match(spineSummary(s), /3cp done=0 failed=0 pending=3/);
    s = markCheckpoint(s, 0, 'complete', { now: 'T' });
    s = markCheckpoint(s, 1, 'failed', { now: 'T' });
    assert.match(spineSummary(s), /3cp done=1 failed=1 pending=1/);
    assert.equal(spineSummary([]), 'none');
    assert.equal(spineSummary(null), 'none');
  });
});

describe('finalizeBlockedBySpine — the false-complete guard (FC-A)', () => {
  it('allows finalize when there is no spine (answer-only mission)', () => {
    assert.equal(finalizeBlockedBySpine(null), null);
    assert.equal(finalizeBlockedBySpine([]), null);
  });

  it('blocks when the DELIVERABLE (last) checkpoint is unmet — the 1health false-complete', () => {
    // CP1 done; CP2/3/4 pending (the review→deploy→report-URL delivery never finished)
    let s = buildSpine(PLAN.concat([{ instruction: 'Report the staging URL', accept_criteria: 'URL posted', tasks: [] }]), { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    const gate = finalizeBlockedBySpine(s);
    assert.ok(gate, 'a synthesize→complete here is a false green and must be blocked');
    assert.equal(gate.terminal.n, 4, 'the deliverable is the last checkpoint');
    assert.equal(gate.unmet.length, 3, 'CP2/3/4 are named as outstanding');
    assert.deepEqual(gate.unmet.map(u => u.n), [2, 3, 4]);
  });

  it('allows finalize once the deliverable checkpoint is complete (even if earlier ones somehow are not)', () => {
    // Terminal complete → the deliverable exists → a mission may legitimately finish.
    let s = buildSpine(PLAN, { now: 'T' });
    s = markCheckpoint(s, 2, 'complete', { now: 'T' });   // last checkpoint done
    assert.equal(finalizeBlockedBySpine(s), null);
  });

  it('blocks a fully-pending spine and names every checkpoint', () => {
    const s = buildSpine(PLAN, { now: 'T' });
    const gate = finalizeBlockedBySpine(s);
    assert.ok(gate);
    assert.equal(gate.unmet.length, 3);
    assert.equal(gate.unmet[0].status, 'pending');
  });
});
