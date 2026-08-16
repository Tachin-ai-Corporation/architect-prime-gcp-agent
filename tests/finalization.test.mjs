// tests/finalization.test.mjs — pure-core tests for platform/work/finalization.mjs (B-19)
//
// The pathology being prevented, from mission w-1785610208442-flyer:
//   CP1 tasks all report_pass (spec + copy written), the cerebellum CP1 milestone
//   verdict FAILs ("2/2 tasks ran"), and the mission — with a complete 2-page flyer PDF
//   already produced — terminates `blocked`, its own success summary in the blocker field.
// A milestone verdict judges a checkpoint, not the deliverable; it must never, on its own,
// make a mission whose tasks all succeeded look like failed work.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMilestoneVerdict, isWorkRow, isRealTaskFailure, isRealTaskSuccess,
  deliverableStandsDespiteMilestone, articulateBlocker,
} from '../platform/work/finalization.mjs';
import { extractFailRecommendation } from '../platform/work/verdict.mjs';

// Rows as checkpoint-executor.mjs actually pushes them.
const taskOK      = { step: '1.1', agent: 'motor', success: true };
const taskOK2     = { step: '1.2', agent: 'motor', success: true };
const taskFail    = { step: '2.1', agent: 'motor', success: false, error: 'wrong arg' };
const taskTimeout = { step: '2.2', agent: 'motor', success: false, timedOut: true };
const verifyFail  = { step: '1.verify', agent: 'cerebellum', success: false };
const verifyInconc= { step: '1.verify', agent: 'cerebellum', success: false, inconclusive: true };
const sysNudge    = { agent: 'system', result: '[SYSTEM] Synthesize blocked: ...' };

describe('isMilestoneVerdict', () => {
  it('is true only for a *.verify pseudo-step', () => {
    assert.equal(isMilestoneVerdict(verifyFail), true);
    assert.equal(isMilestoneVerdict(taskOK), false);
    assert.equal(isMilestoneVerdict(sysNudge), false);
    assert.equal(isMilestoneVerdict({ step: 'noverify' }), false);
    assert.equal(isMilestoneVerdict(null), false);
  });
});

describe('isWorkRow', () => {
  it('excludes system, human, and milestone-verdict rows', () => {
    assert.equal(isWorkRow(taskOK), true);
    assert.equal(isWorkRow(verifyFail), false);            // milestone verdict, not work
    assert.equal(isWorkRow(sysNudge), false);              // system nudge
    assert.equal(isWorkRow({ agent: 'human', success: true }), false);
    assert.equal(isWorkRow(null), false);
  });
});

describe('isRealTaskFailure', () => {
  it('is true for a hard-failed task', () => {
    assert.equal(isRealTaskFailure(taskFail), true);
  });
  it('is false for milestone-verdict / inconclusive / timed-out rows', () => {
    assert.equal(isRealTaskFailure(verifyFail), false);    // a verdict is not failed work
    assert.equal(isRealTaskFailure(verifyInconc), false);  // couldn't see it ≠ wrong
    assert.equal(isRealTaskFailure(taskTimeout), false);   // unknown ≠ wrong
    assert.equal(isRealTaskFailure(taskOK), false);
  });
});

describe('isRealTaskSuccess', () => {
  it('is true only for a real task that succeeded', () => {
    assert.equal(isRealTaskSuccess(taskOK), true);
    assert.equal(isRealTaskSuccess(taskFail), false);
    // a *.verify PASS is still not "work" — it's a verdict about work
    assert.equal(isRealTaskSuccess({ step: '1.verify', agent: 'cerebellum', success: true }), false);
  });
});

describe('deliverableStandsDespiteMilestone', () => {
  it('TRUE for the flyer case: tasks all succeeded, only the milestone verdict failed', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskOK2, verifyFail]), true);
  });
  it('TRUE when an inconclusive verdict sits over succeeded tasks', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, verifyInconc]), true);
  });
  it('TRUE when a timed-out (outcome-unknown) row sits beside a real success (synthesize re-verifies)', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskTimeout]), true);
  });
  it('FALSE when any real task hard-failed — a genuine failure must still block/own the failure', () => {
    assert.equal(deliverableStandsDespiteMilestone([taskOK, taskFail, verifyFail]), false);
  });
  it('FALSE when no real task succeeded (nothing was actually delivered)', () => {
    assert.equal(deliverableStandsDespiteMilestone([verifyFail]), false);
    assert.equal(deliverableStandsDespiteMilestone([sysNudge]), false);
    assert.equal(deliverableStandsDespiteMilestone([]), false);
    assert.equal(deliverableStandsDespiteMilestone(null), false);
  });
});

// ── articulateBlocker ──────────────────────────────────────────────────
//
// From a live assistant mission (QA, 2026-08-16): asked to create a Google Sheet,
// motor tried `sheets-create`, then `sheets create`, then `drive-create`, then
// READ its own SKILL.md, and concluded — correctly — that no tool creates a
// spreadsheet. Its report_fail said "Provide the motor agent with a functional
// tool or command to create Google Sheets."
//
// The mission terminated `blocked` with output "Blocked on external dependency."
// and blocker "Unknown blocker". The diagnosis was produced and then discarded.
describe('articulateBlocker', () => {
  const failRow = (rec) => ({
    step: '1.2', agent: 'motor', success: false,
    result: `[TOOL] report_fail({"checks":[],"recommendation":"${rec}"}) → ok`,
  });

  it('recovers the failing task\'s own recommendation', () => {
    const r = articulateBlocker(
      [failRow('Provide a tool that creates Google Sheets')],
      extractFailRecommendation,
    );
    assert.equal(r.detail, 'Provide a tool that creates Google Sheets');
    assert.equal(r.step, '1.2');
    assert.equal(r.agent, 'motor');
  });

  it('takes the LAST failure, because a re-plan supersedes earlier attempts', () => {
    const r = articulateBlocker(
      [failRow('first thing tried'), failRow('what is actually missing')],
      extractFailRecommendation,
    );
    assert.equal(r.detail, 'what is actually missing');
  });

  it('falls back to the first substantive line when there is no report_fail', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: '[FAILED]\n\n---\nThe calendar API rejected the token as expired.' }],
      extractFailRecommendation,
    );
    // The [FAILED] marker and the rule are structure; the sentence is the reason.
    assert.equal(r.detail, 'The calendar API rejected the token as expired.');
  });

  it('returns null rather than inventing when there is nothing to say', () => {
    assert.equal(articulateBlocker([], extractFailRecommendation), null);
    assert.equal(articulateBlocker(null, extractFailRecommendation), null);
    assert.equal(
      articulateBlocker([{ step: '1.1', agent: 'motor', success: false, result: '[FAILED]' }], extractFailRecommendation),
      null,
      'a bare marker is not an explanation — the caller must say so, not paper over it',
    );
  });

  it('ignores milestone verdicts and inconclusive rows, like every other predicate here', () => {
    const milestone = { step: '1.verify', agent: 'cerebellum', success: false, result: 'FAIL: could not see the artifact' };
    const inconclusive = { step: '1.1', agent: 'motor', success: false, inconclusive: true, result: 'no verdict returned at all' };
    assert.equal(articulateBlocker([milestone], extractFailRecommendation), null);
    assert.equal(articulateBlocker([inconclusive], extractFailRecommendation), null);
  });

  it('caps the detail so a blocker field cannot become a transcript', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: `x${'y'.repeat(2000)}` }],
      extractFailRecommendation,
    );
    assert.ok(r.detail.length <= 601, `detail was ${r.detail.length} chars`);
    assert.ok(r.detail.endsWith('…'));
  });

  it('survives a malformed tool log instead of losing the row', () => {
    const r = articulateBlocker(
      [{ step: '1.1', agent: 'motor', success: false, result: '[TOOL] report_fail({"recommendation": → broken\nThe sheet could not be created.' }],
      extractFailRecommendation,
    );
    assert.ok(r && r.detail.length > 0, 'a broken log should degrade to the text, not to null');
  });
});
