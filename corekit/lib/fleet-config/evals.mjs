// corekit/lib/fleet-config/evals.mjs — measuring a candidate before agents meet it
//
// The rollout gate judges a release on the work it produced, which is honest and
// late: something has to go wrong in production before the gate has anything to
// read. An evaluation asks the same question earlier, against the compiled spec
// itself.
//
// These graders are DETERMINISTIC on purpose (C-4). A behavioural eval that
// calls a model to judge a model is expensive, non-reproducible, and — worst —
// disagrees with itself between runs, so a regression and a bad mood look
// identical. Everything here is a structural assertion over the Effective Agent
// Spec and its rendered bundle: which skills a role holds, which capabilities
// close, what the soul actually says, and how large it is.
//
// That is not the whole of "better", and the metrics from real work remain the
// arbiter. But it covers the class of regression this program actually suffered:
// an overlay that landed twice, a skill that vanished from a role, a soul that
// grew past the prompt budget. Every one of those is a fact about the artifact,
// knowable before any agent runs a mission on it.
//
// Cases are DATA, not code — they are Fleet Definition content authored per
// deployment, and a grader that needed a code change per case would put them
// back in Foundation.

/** The assertions a case may make. Adding one is a Foundation change (C-29). */
export const ASSERTIONS = Object.freeze([
  'contains', 'not_contains', 'occurs', 'matches',
  'file_present', 'file_absent', 'max_chars',
  'has_skill', 'lacks_skill', 'has_capability', 'lacks_capability', 'egress_class',
]);

/** Count non-overlapping occurrences of a literal. */
function countOf(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Grade one case against a compiled spec and its rendered files.
 *
 * Returns `pass` plus a note that states what was actually found — a bare false
 * sends the reader back to the fixture to guess, which is how an eval suite
 * stops being run.
 *
 * @param {object} evalCase - { id, file?, assert: { kind, value, times?, max? } }
 * @param {object} ctx - { spec, files }
 * @returns {{ pass: boolean, notes: string }}
 */
export function runCase(evalCase, { spec, files }) {
  const a = evalCase.assert || {};
  const kind = a.kind;

  if (!ASSERTIONS.includes(kind)) {
    // An unknown assertion must FAIL, never pass. A typo that silently passes is
    // a case that has stopped testing anything while still reporting green.
    return { pass: false, notes: `unknown assertion '${kind}' — case cannot be graded` };
  }

  // ---- Spec-level assertions ----
  const skills = (spec?.skills || []).map((s) => s.id);
  const capabilities = spec?.capabilities || [];

  switch (kind) {
    case 'has_skill':
      return skills.includes(a.value)
        ? { pass: true, notes: `role holds '${a.value}'` }
        : { pass: false, notes: `role does not hold '${a.value}' (has: ${skills.join(', ') || 'none'})` };
    case 'lacks_skill':
      return skills.includes(a.value)
        ? { pass: false, notes: `role holds '${a.value}' and should not` }
        : { pass: true, notes: `role does not hold '${a.value}'` };
    case 'has_capability':
      return capabilities.includes(a.value)
        ? { pass: true, notes: `capability '${a.value}' is granted` }
        : { pass: false, notes: `capability '${a.value}' is not granted` };
    case 'lacks_capability':
      return capabilities.includes(a.value)
        ? { pass: false, notes: `capability '${a.value}' is granted and should not be` }
        : { pass: true, notes: `capability '${a.value}' is not granted` };
    case 'egress_class':
      return spec?.egress_class === a.value
        ? { pass: true, notes: `egress is '${a.value}'` }
        : { pass: false, notes: `egress is '${spec?.egress_class}', expected '${a.value}'` };
    default:
      break;
  }

  // ---- File-level assertions ----
  const path = evalCase.file;
  if (!path) return { pass: false, notes: `assertion '${kind}' needs a file, and the case names none` };
  const present = Object.prototype.hasOwnProperty.call(files || {}, path);

  if (kind === 'file_present') {
    return present ? { pass: true, notes: `${path} is in the bundle` } : { pass: false, notes: `${path} is missing` };
  }
  if (kind === 'file_absent') {
    return present ? { pass: false, notes: `${path} is present and should not be` } : { pass: true, notes: `${path} is absent` };
  }
  if (!present) {
    // Distinguish "the file is missing" from "the content is wrong". They have
    // different causes and a shared failure message hides the more serious one.
    return { pass: false, notes: `${path} is missing from the bundle, so '${kind}' could not be checked` };
  }

  const body = String(files[path]);
  switch (kind) {
    case 'contains':
      return countOf(body, a.value) > 0
        ? { pass: true, notes: `${path} contains it` }
        : { pass: false, notes: `${path} does not contain ${JSON.stringify(a.value)}` };
    case 'not_contains':
      return countOf(body, a.value) === 0
        ? { pass: true, notes: `${path} does not contain it` }
        : { pass: false, notes: `${path} contains ${JSON.stringify(a.value)} and should not` };
    case 'occurs': {
      // The assertion that would have caught the soul doubling: not "is the
      // overlay there" but "is it there exactly once".
      const want = a.times ?? 1;
      const got = countOf(body, a.value);
      return got === want
        ? { pass: true, notes: `${path} contains it ${got}×` }
        : { pass: false, notes: `${path} contains ${JSON.stringify(a.value)} ${got}×, expected ${want}×` };
    }
    case 'matches': {
      let rx;
      try { rx = new RegExp(a.value, a.flags || ''); }
      catch (e) { return { pass: false, notes: `invalid pattern: ${e.message}` }; }
      return rx.test(body)
        ? { pass: true, notes: `${path} matches` }
        : { pass: false, notes: `${path} does not match /${a.value}/` };
    }
    case 'max_chars':
      return body.length <= a.max
        ? { pass: true, notes: `${path} is ${body.length} chars (limit ${a.max})` }
        : { pass: false, notes: `${path} is ${body.length} chars, over the ${a.max} limit` };
    default:
      return { pass: false, notes: `assertion '${kind}' is declared but not implemented` };
  }
}

/**
 * Run a whole suite against one compiled spec.
 *
 * An empty suite fails rather than reporting a clean sweep — "every case passed"
 * over no cases is the same lie as a validator that approves an empty set.
 */
export function runSuite(suite, ctx) {
  const cases = suite?.cases || [];
  if (!cases.length) {
    return { ok: false, reason: 'suite has no cases — an empty suite proves nothing', results: [] };
  }
  const results = cases.map((c) => {
    const { pass, notes } = runCase(c, ctx);
    return { case_id: c.id, pass, notes };
  });
  return { ok: true, results, passed: results.filter((r) => r.pass).length, total: results.length };
}

/**
 * Compare a baseline run against a candidate run, case by case.
 *
 * A case only present on one side is reported rather than skipped: a candidate
 * that drops a case it used to fail would otherwise look like an improvement.
 */
export function compareRuns(baselineResults, candidateResults) {
  const base = new Map((baselineResults || []).map((r) => [r.case_id, r]));
  const cand = new Map((candidateResults || []).map((r) => [r.case_id, r]));
  const ids = [...new Set([...base.keys(), ...cand.keys()])].sort();

  const results = [];
  for (const id of ids) {
    const b = base.get(id);
    const c = cand.get(id);
    if (!c) { results.push({ case_id: id, baseline_pass: !!b?.pass, candidate_pass: false, verdict: 'regressed', notes: 'case missing from the candidate run' }); continue; }
    if (!b) { results.push({ case_id: id, baseline_pass: false, candidate_pass: !!c.pass, verdict: c.pass ? 'improved' : 'regressed', notes: 'case is new — no baseline to compare against' }); continue; }
    const verdict = b.pass === c.pass ? 'unchanged' : (c.pass ? 'improved' : 'regressed');
    results.push({ case_id: id, baseline_pass: b.pass, candidate_pass: c.pass, verdict, notes: c.notes });
  }
  return results;
}

/** Did the candidate lose ground anywhere? */
export function regressions(results) {
  return (results || []).filter((r) => r.verdict === 'regressed');
}

/**
 * Assemble a fleetEvaluation record.
 *
 * The schema refuses a comparison whose two sides used different models, because
 * a change in both content and model can be attributed to neither. This keeps
 * the same discipline for the platform coordinate by surfacing it rather than
 * silently normalising it.
 */
export function evaluationRecord({ id, suiteId, baseline, candidate, results, createdAt }) {
  const total = results.length;
  const passed = results.filter((r) => r.candidate_pass).length;
  const regressed = regressions(results).length;

  return {
    id, schema_version: 1, created_at: createdAt, suite_id: suiteId,
    baseline, candidate, results,
    metrics: {
      total,
      passed,
      pass_rate: total ? passed / total : null,
      regressed,
      improved: results.filter((r) => r.verdict === 'improved').length,
    },
    status: 'complete',
  };
}

/** A short operator-facing verdict. */
export function renderEvaluation(record) {
  const m = record.metrics || {};
  const lines = [
    `${m.regressed ? '❌' : '✅'} ${record.suite_id}: ${m.passed}/${m.total} cases pass`,
  ];
  if (m.improved) lines.push(`   ${m.improved} improved`);
  if (m.regressed) {
    lines.push(`   ${m.regressed} REGRESSED:`);
    for (const r of regressions(record.results)) lines.push(`     · ${r.case_id} — ${r.notes}`);
  }
  return lines.join('\n');
}
