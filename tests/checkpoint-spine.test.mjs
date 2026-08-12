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
  finalizeBlockedBySpine, checkpointFailureHalts, probeGatedFinalizeAction,
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

describe('checkpointFailureHalts — FC-D non-terminal milestone convergence', () => {
  it('HALTS on a real task failure, terminal or not', () => {
    assert.equal(checkpointFailureHalts({ isTerminal: false, taskFailure: true }), true);
    assert.equal(checkpointFailureHalts({ isTerminal: true, taskFailure: true }), true);
  });

  it('HALTS on ANY failure of the terminal (deliverable) checkpoint — fail-closed', () => {
    // The deliverable milestone is the real gate; a terminal milestone FAIL must halt honestly.
    assert.equal(checkpointFailureHalts({ isTerminal: true, taskFailure: false }), true);
  });

  it('PROCEEDS past a NON-terminal milestone-only failure (tasks ok) — the 1health edit-checkpoint case', () => {
    // bobby's delegated edit succeeded, but archie's cerebellum could not see it in archie's
    // workspace → a milestone FAIL that must NOT halt: the deploy (terminal) checkpoint gates.
    assert.equal(checkpointFailureHalts({ isTerminal: false, taskFailure: false }), false);
  });

  it('with no signals returns proceed=false (edge; the executor always passes real booleans)', () => {
    // Pure-function edge case: undefined isTerminal/taskFailure → neither halt condition fires.
    // The executor only calls this when cpFailed is already true AND the flag is ON, and always
    // supplies computed booleans, so this default is defensive, not a live path.
    assert.equal(checkpointFailureHalts(), false);
  });
});

describe('FC-E — the reset-loop invariant the skip path must preserve', () => {
  // The archie→bobby→stan reset-loop: a resumed EDIT and DEPLOY checkpoint (tasks banked via
  // delegation) were skipped WITHOUT their spine entry being advanced, so the pinned spine read
  // [pending, pending, failed] though the edit + deploy were done. firstIncompleteIndex then
  // returns 0 (the edit), so the scoped re-plan re-targets the edit and the executor restarts the
  // whole mission — re-running a completed edit/deploy forever. The executor fix (SKIP_ADVANCES_SPINE)
  // marks a skipped checkpoint complete; these tests lock the spine contract that makes that correct.
  const THREE = [
    { instruction: 'Edit the hero headline', accept_criteria: 'headline updated', tasks: [] },
    { instruction: 'Deploy to staging', accept_criteria: 'staging serves it', tasks: [] },
    { instruction: 'Report the staging URL', accept_criteria: 'URL posted', tasks: [] },
  ];

  it('BUG shape: edit+deploy left pending → firstIncompleteIndex points at the EDIT (restart loop)', () => {
    let s = buildSpine(THREE, { now: 'T' });
    s = markCheckpoint(s, 2, 'failed', { now: 'T' });                 // only the terminal was marked
    assert.equal(firstIncompleteIndex(s), 0, 'the reset-loop: re-plan/resume restarts from the edit');
    assert.equal(rebuildFromSpine(s).startCpIndex, 0);
  });

  it('FIXED shape: skip advanced edit+deploy to complete → re-plan scopes to the TERMINAL only', () => {
    let s = buildSpine(THREE, { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });              // skip advanced the edit
    s = markCheckpoint(s, 1, 'complete', { now: 'T2' });              // skip advanced the deploy
    s = markCheckpoint(s, 2, 'failed', { now: 'T3' });                // terminal genuinely failed
    assert.equal(firstIncompleteIndex(s), 2, 'only the failed terminal is re-planned');
    assert.equal(rebuildFromSpine(s).startCpIndex, 2, 'the executor resumes at the terminal, not the edit');
    // …and a scoped re-plan of the terminal must NOT disturb the completed edit/deploy verdicts.
    const { spine } = applyReplan(s, 2, [{ agent: 'motor', task: 'report the url' }], { now: 'T4' });
    assert.equal(spine[0].status, 'complete', 'edit verdict preserved');
    assert.equal(spine[1].status, 'complete', 'deploy verdict preserved');
    assert.equal(spine[2].status, 'pending', 'only the terminal is made runnable again');
  });

  it('once the deploy (terminal, no separate report CP) is complete, finalize is allowed', () => {
    // The plan-structuring half of the fix folds "report the URL" into the deploy checkpoint, so a
    // two-checkpoint mission (edit → deploy+report) finalizes cleanly when the deploy completes.
    let s = buildSpine(THREE.slice(0, 2), { now: 'T' });
    s = markCheckpoint(s, 0, 'complete', { now: 'T1' });
    s = markCheckpoint(s, 1, 'complete', { now: 'T2' });
    assert.equal(firstIncompleteIndex(s), -1, 'whole spine done');
    assert.equal(finalizeBlockedBySpine(s), null, 'deliverable met → finalize allowed');
  });
});

describe('probeGatedFinalizeAction — FC-A false-negative refinement (#237)', () => {
  it('BLOCKS (original FC-A) when the flag is off, regardless of delegation', () => {
    assert.equal(probeGatedFinalizeAction({ flagOn: false, restsOnDelegation: true, deliverableVerdict: undefined }), 'block');
    assert.equal(probeGatedFinalizeAction({ flagOn: false, restsOnDelegation: true, deliverableVerdict: 'PASS' }), 'block');
  });

  it('BLOCKS a non-delegated mission (no ground-truth artifact to re-derive)', () => {
    assert.equal(probeGatedFinalizeAction({ flagOn: true, restsOnDelegation: false, deliverableVerdict: undefined }), 'block');
  });

  it('DEFERS a delegated mission at the gate (verdict unknown) → run the re-derivation', () => {
    assert.equal(probeGatedFinalizeAction({ flagOn: true, restsOnDelegation: true, deliverableVerdict: undefined }), 'defer');
  });

  it('ALLOWS finalize only when the re-derivation PASSES (deliverable observably met)', () => {
    assert.equal(probeGatedFinalizeAction({ flagOn: true, restsOnDelegation: true, deliverableVerdict: 'PASS' }), 'allow');
  });

  it('re-BLOCKS fail-closed on a non-PASS re-derivation (FAIL / inconclusive / null)', () => {
    assert.equal(probeGatedFinalizeAction({ flagOn: true, restsOnDelegation: true, deliverableVerdict: 'FAIL' }), 'block');
    assert.equal(probeGatedFinalizeAction({ flagOn: true, restsOnDelegation: true, deliverableVerdict: null }), 'block');
  });

  it('empty-arg edge is a safe block', () => {
    assert.equal(probeGatedFinalizeAction(), 'block');
  });
});
