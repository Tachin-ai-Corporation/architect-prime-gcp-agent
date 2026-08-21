// The approve → re-plan → re-gate loop, and why it happened.
//
// A prod-deploy mission paused at an approval gate. The operator approved; the
// resume (resumeCheckpointPlan → executeCheckpointPlanResume) correctly CONTINUED
// the plan past the gate and ran the deploy. But when the resumed plan finished,
// the re-entry into the cortex decide loop summarized each step result truncated to
// 200 characters. The cortex could not see that the deploy had succeeded ("results
// are truncated — I can't see the actual outcomes"), so it re-planned — and the
// re-plan re-inserted the SAME approval gate. The operator approved again; same
// thing. Observed live on the 1health prod deploy: a fresh apr- per approval, the
// site already deployed and .git already unexposed the whole time.
//
// The resumeCheckpointPlan comment already names this hazard ("re-deciding re-plans
// the gate's checkpoint and re-inserts the SAME approval gate ... re-gates forever")
// and continues the plan to avoid it — but executeCheckpointPlanResume then fell
// back into the decide loop at the END, with 200-char results, reintroducing the
// re-decide it was built to prevent.
//
// The fix, asserted here against the real source: the resume re-entry gives the
// cortex the SAME result budget the sibling delegation-resume path uses
// (RESULT_PREVIEW_CHARS), and labels a completed plan as completed with an explicit
// SYNTHESIZE (not re-plan / not re-gate) instruction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repo, 'platform', 'runtime', 'agent-brain.mjs'), 'utf8');

// Isolate the resume re-entry block so these assertions are about IT, not some other
// use of the same tokens elsewhere in a 5k-line file.
const start = src.indexOf('These results are the ONLY account');
const block = src.slice(start, start + 1400);

test('the resume re-entry exists (the fix is anchored in the resume path)', () => {
  assert.ok(start > 0, 'the resume re-entry block must be present');
});

test('resumed step results are NOT truncated to 200 chars', () => {
  assert.doesNotMatch(block, /substring\(0,\s*200\)/,
    'a 200-char summary hid the deploy outcome and drove the re-plan/re-gate loop');
});

test('the resume re-entry uses the shared result budget, like the sibling path', () => {
  assert.match(block, /smartTruncate\(toStr\(r\.result\),\s*RESULT_PREVIEW_CHARS\)/,
    'give the cortex the same budget the delegation-resume path gives it');
});

test('a COMPLETED resumed plan is labeled completed and told to synthesize, not re-plan', () => {
  assert.match(block, /COMPLETED on resume/, 'a plan that ran to completion is not a crash');
  assert.match(block, /SYNTHESIZE/, 'the cortex must synthesize the deliverable');
  assert.match(block, /Do NOT re-plan or re-request an approval already granted/,
    'the explicit guard against re-gating an already-approved, already-executed action');
});

test('a FAILED resumed plan still routes to failure handling, not silent retry', () => {
  assert.match(block, /FAILED on resume/);
  assert.match(block, /synthesize_with_failure or needs_input/);
});
