// A planted regression must fail the gate (Finding B).
//
// `fleet-config evaluate` compiled ONE spec — from the mutable branch tip, not a
// pinned release — and then compared it to itself:
//
//     compareRuns(candidateRun.results, candidateRun.results)
//
// Every case therefore came back `unchanged`, `regressions()` was always empty,
// and the `process.exit(4)` gate at the end of the command could not fire. The
// evaluation was not weak, it was incapable — and it reported PASS while being so.
//
// `compareRuns` itself was always correct. The defect was entirely at the call
// site, which is why a unit test of the pure function would have stayed green
// throughout. These tests drive the PIPELINE — two distinct runs in, a verdict
// out — and then check the wiring that feeds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSuite, compareRuns, regressions } from '../platform/deployment/evals.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = readFileSync(join(repo, 'corekit', 'system', 'fleet-config'), 'utf8');

/** A suite that asserts the agent keeps a skill and keeps its rendered soul. */
const SUITE = {
  id: 'regression-guard',
  cases: [
    { id: 'keeps-git', assert: { kind: 'has_skill', value: 'workspace-git' } },
    { id: 'keeps-soul', file: 'workspace-cortex/SOUL.md', assert: { kind: 'file_present' } },
  ],
};

const bundle = ({ skills, files }) => ({
  spec: { skills: skills.map((id) => ({ id })), capabilities: [], egress_class: 'mouth' },
  files,
});

const HEALTHY = bundle({
  skills: ['workspace-git', 'web-search'],
  files: { 'workspace-cortex/SOUL.md': '# cortex\n' },
});

// ---- the pipeline ---------------------------------------------------------

test('a candidate that drops a skill is reported as a REGRESSION', () => {
  const broken = bundle({ skills: ['web-search'], files: HEALTHY.files });

  const base = runSuite(SUITE, HEALTHY);
  const cand = runSuite(SUITE, broken);
  assert.ok(base.ok && cand.ok, 'both runs must grade');

  const results = compareRuns(base.results, cand.results);
  const lost = regressions(results);

  assert.equal(lost.length, 1, 'exactly the dropped skill must regress');
  assert.equal(lost[0].case_id, 'keeps-git');
  assert.equal(lost[0].baseline_pass, true);
  assert.equal(lost[0].candidate_pass, false);
});

test('a candidate that drops a rendered file is reported as a REGRESSION', () => {
  const broken = bundle({ skills: ['workspace-git', 'web-search'], files: {} });
  const results = compareRuns(runSuite(SUITE, HEALTHY).results, runSuite(SUITE, broken).results);
  assert.deepEqual(regressions(results).map((r) => r.case_id), ['keeps-soul']);
});

test('comparing a run to ITSELF can never regress — the old behaviour, pinned', () => {
  // This is what the command did. Note that it holds even for a bundle that FAILS
  // every case: self-comparison reports `unchanged`, so a wholly broken candidate
  // sailed through the gate. Kept as a test so the shape stays recognisable.
  const broken = bundle({ skills: [], files: {} });
  const run = runSuite(SUITE, broken);
  assert.ok(run.results.every((r) => !r.pass), 'this bundle fails every case');

  const selfCompared = compareRuns(run.results, run.results);
  assert.equal(regressions(selfCompared).length, 0,
    'self-comparison finds no regression even when nothing passes — which is why the gate could not fire');
});

test('an improvement is not mistaken for a regression', () => {
  // The gate exits non-zero on regressions only. If adding a skill registered as
  // a regression, every real improvement would be blocked and the gate would be
  // switched off within a week.
  const better = bundle({ skills: ['workspace-git', 'web-search', 'legal-review'], files: HEALTHY.files });
  const results = compareRuns(runSuite(SUITE, HEALTHY).results, runSuite(SUITE, better).results);
  assert.equal(regressions(results).length, 0);
  assert.ok(results.every((r) => r.verdict === 'unchanged'));
});

// ---- the wiring that feeds it --------------------------------------------

/** The file with `//` comment lines removed, so prose cannot satisfy or defeat a check. */
const code = cli.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the command compares two DIFFERENT runs', () => {
  // Asserted against CODE, not the file. The fix keeps the old buggy line quoted
  // in a comment because it is the clearest statement of what went wrong — and
  // the first version of this test failed on that comment, which is the same
  // defect from the other side: a check a comment can fool is not a check.
  assert.doesNotMatch(code, /compareRuns\(\s*candidateRun\.results\s*,\s*candidateRun\.results\s*\)/,
    'the candidate must not be compared to itself');
  assert.match(code, /compareRuns\(baselineRun\.results, candidateRun\.results\)/,
    'the baseline must be a separately compiled and separately graded run');
});

test('both sides are read from a PINNED release, not the branch tip', () => {
  // Finding A, in the evaluation path. Comparing two compilations of a mutable
  // branch means neither side names a set of bytes, so a verdict cannot be
  // attributed to a change — the evaluation would be measuring the clock.
  const at = cli.indexOf('async function cmdEvaluate(');
  assert.ok(at > 0);
  const body = cli.slice(at, cli.indexOf('\nasync function cmdObserve('));

  assert.equal((body.match(/readReleaseDefinitions\(/g) || []).length, 2,
    'exactly two pinned reads: one for the baseline, one for the candidate');
  assert.doesNotMatch(body, /registry\.readDefinitions\(/,
    'the mutable branch tip must not appear in an evaluation');
});

test('--baseline is actually read', () => {
  // It was advertised in the usage string and never read — a flag that existed
  // only as documentation of an intention.
  assert.match(cli, /argValue\(args, '--baseline'\)/);
  assert.match(cli, /argValue\(args, '--candidate'\)/);
});

test('the gate still exits non-zero on a regression', () => {
  // The comparison is only worth fixing if something acts on it.
  assert.match(cli, /if \(regressions\(results\)\.length\) process\.exit\(4\);/);
});
