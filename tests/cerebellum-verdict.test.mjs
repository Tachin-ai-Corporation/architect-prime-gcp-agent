// tests/cerebellum-verdict.test.mjs — Phase 5.3: Cerebellum verdict path verification
//
// Self-contained test script. No test runner required.
// Run: node tests/cerebellum-verdict.test.mjs

import { extractVerdict, extractFailRecommendation } from '../corekit/lib/verdict.mjs';
import { detectMotorFailure } from '../corekit/lib/agent-output.mjs';
import { extractCheckpoints } from '../corekit/lib/plan-utils.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log('\nPhase 5.3 — Cerebellum verdict path tests\n');

// ── Test 1: report_pass produces PASS verdict ───────────────────────
run('report_pass → PASS verdict', () => {
  const passArgs = JSON.stringify({
    verdict: 'PASS',
    reasoning: 'All criteria met',
    checks: [{ criterion: 'File exists', pass: true, evidence: 'ls shows file.txt' }]
  });
  const passOutput = `[TOOL EXECUTION LOG]\n[TOOL] report_pass(${passArgs})\n[RESULT] Verification complete\n[END TOOL LOG]`;
  const result = extractVerdict(passOutput);
  assert(result === 'PASS', `expected PASS, got ${result}`);
});

// ── Test 2: report_fail produces FAIL verdict + recommendation ──────
run('report_fail → FAIL verdict', () => {
  const failArgs = JSON.stringify({
    verdict: 'FAIL',
    reasoning: 'Missing file',
    checks: [{ criterion: 'File exists', pass: false, evidence: 'ls shows no file.txt' }],
    recommendation: 'Create file.txt'
  });
  const failOutput = `[TOOL EXECUTION LOG]\n[TOOL] report_fail(${failArgs})\n[RESULT] Verification complete\n[END TOOL LOG]`;
  const result = extractVerdict(failOutput);
  assert(result === 'FAIL', `expected FAIL, got ${result}`);
});

run('report_fail → extractFailRecommendation', () => {
  const failArgs = JSON.stringify({
    verdict: 'FAIL',
    reasoning: 'Missing file',
    checks: [{ criterion: 'File exists', pass: false, evidence: 'ls shows no file.txt' }],
    recommendation: 'Create file.txt'
  });
  const failOutput = `[TOOL EXECUTION LOG]\n[TOOL] report_fail(${failArgs})\n[RESULT] Verification complete\n[END TOOL LOG]`;
  const rec = extractFailRecommendation(failOutput);
  assert(rec && rec.length > 0, `expected recommendation, got ${rec}`);
  assert(rec === 'Create file.txt', `expected 'Create file.txt', got '${rec}'`);
});

// ── Test 3: No verdict tool → null ──────────────────────────────────
run('no verdict tool → null', () => {
  const textOutput = 'I reviewed the work and it looks good. The acceptance criteria are all satisfied.';
  const result = extractVerdict(textOutput);
  assert(result === null, `expected null, got ${result}`);
});

// ── Test 4: detectMotorFailure ──────────────────────────────────────
run('detectMotorFailure → auth failure', () => {
  const motorFail = detectMotorFailure('Error: DWD token expired. Authentication failed.');
  assert(motorFail.failed === true, `expected failed=true`);
  assert(motorFail.type === 'auth', `expected type=auth, got ${motorFail.type}`);
});

run('detectMotorFailure → no failure', () => {
  const motorOk = detectMotorFailure('File created successfully.');
  assert(motorOk.failed === false, `expected failed=false`);
});

// ── Test 5: extractCheckpoints ──────────────────────────────────────
run('extractCheckpoints → structured plan', () => {
  const plan = {
    checkpoints: [{
      instruction: 'Deploy service',
      tasks: [{ agent: 'motor', task: 'Run deploy script' }]
    }]
  };
  const cps = extractCheckpoints(plan);
  assert(cps && cps.length === 1, `expected 1 checkpoint, got ${cps?.length}`);
  assert(cps[0].tasks[0].agent === 'motor', `expected motor agent`);
});

run('extractCheckpoints → steps normalized to tasks', () => {
  const plan2 = {
    checkpoints: [{
      instruction: 'Test',
      steps: [{ agent: 'motor', task: 'Do thing' }]
    }]
  };
  const cps2 = extractCheckpoints(plan2);
  assert(cps2 && cps2[0].tasks, `expected steps normalized to tasks`);
  assert(cps2[0].tasks.length === 1, `expected 1 task after normalization`);
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
