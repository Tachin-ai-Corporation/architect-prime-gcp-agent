// tests/graded-verdict.test.mjs — C-38 / B-37 graded verdict (met / met-with-caveat / not-met)
//
// Self-contained. Run: node tests/graded-verdict.test.mjs  (or via `node --test tests/*.test.mjs`)
//
// The graded verdict is expressed STRUCTURALLY: a `caveat` field rides the report_pass verdict.
// extractVerdict stays binary (a caveated pass is still PASS, so the whole flow is untouched);
// extractPassCaveat reads the caveat so the daemon can SURFACE it. A clean pass is unchanged.

import { extractVerdict, extractPassCaveat } from '../platform/work/verdict.mjs';
import { renderCaveatSection } from '../platform/work/finalization.mjs';

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

const passLog = (args) =>
  `[TOOL EXECUTION LOG]\n[TOOL] report_pass(${JSON.stringify(args)}) → {"verdict":"PASS"}\n[END TOOL LOG]`;

console.log('\nC-38 / B-37 — graded verdict tests\n');

// ── extractPassCaveat: caveat present ───────────────────────────────
run('report_pass with caveat → extractPassCaveat returns it', () => {
  const out = passLog({
    reasoning: 'Playbook registered and active',
    checks: [{ criterion: 'Playbook registered', pass: true, evidence: 'process-ops list shows it' }],
    caveat: 'Two source folders resolve at runtime via Drive search',
  });
  const cav = extractPassCaveat(out);
  assert(cav === 'Two source folders resolve at runtime via Drive search', `got '${cav}'`);
});

// ── extractPassCaveat: clean pass → '' (unchanged behaviour) ────────
run('clean report_pass (no caveat field) → empty string', () => {
  const out = passLog({
    reasoning: 'All criteria met',
    checks: [{ criterion: 'File exists', pass: true, evidence: 'ls shows file.txt' }],
  });
  assert(extractPassCaveat(out) === '', 'a clean pass must yield no caveat');
});

// ── extractPassCaveat: caveat with parentheses survives the sentinel ─
// The ` ) → ` sentinel (not the first paren) is why a caveat can contain parentheses without
// truncating the JSON to garbage — the same discipline extractReportFailArgs uses for legal text.
run('caveat containing parentheses survives (sentinel, not first-paren)', () => {
  const caveat = 'The In Progress folder (1ozAGM…) id was not captured; it resolves at runtime.';
  const out = passLog({
    reasoning: 'Done',
    checks: [{ criterion: 'x', pass: true, evidence: 'y' }],
    caveat,
  });
  assert(extractPassCaveat(out) === caveat, `parenthetical caveat was truncated: '${extractPassCaveat(out)}'`);
});

// ── extractPassCaveat: no report_pass → '' ──────────────────────────
run('no report_pass in output → empty string', () => {
  const failOut = `[TOOL EXECUTION LOG]\n[TOOL] report_fail(${JSON.stringify({ reasoning: 'nope', checks: [], recommendation: 'fix' })}) → {}\n[END TOOL LOG]`;
  assert(extractPassCaveat(failOut) === '', 'a fail carries no pass caveat');
  assert(extractPassCaveat('just prose, no tool log') === '', 'prose carries no caveat');
  assert(extractPassCaveat('') === '', 'empty input → empty caveat');
});

// ── extractVerdict is UNCHANGED by a caveat (structural verdict) ─────
run('a caveated pass is still structurally PASS', () => {
  const out = passLog({
    reasoning: 'met with a note',
    checks: [{ criterion: 'x', pass: true, evidence: 'y' }],
    caveat: 'minor deferral',
  });
  assert(extractVerdict(out) === 'PASS', `expected PASS, got ${extractVerdict(out)}`);
});

// ── renderCaveatSection: empty → '' (clean completion unchanged) ────
run('renderCaveatSection([]) → empty (no section on a clean completion)', () => {
  assert(renderCaveatSection([]) === '', 'no caveats → no section');
  assert(renderCaveatSection(undefined) === '', 'undefined → no section');
  assert(renderCaveatSection(['', '   ', null]) === '', 'only blank caveats → no section');
});

// ── renderCaveatSection: formats + dedups + trims ──────────────────
run('renderCaveatSection formats a bullet block, deduped and trimmed', () => {
  const s = renderCaveatSection([
    'CP2: two folders resolve at runtime',
    '  CP2: two folders resolve at runtime  ', // duplicate after trim
    'CP3: optional summary chart deferred',
  ]);
  assert(s.includes('— Caveats (noted, non-blocking) —'), 'missing header');
  assert(s.includes('• CP2: two folders resolve at runtime'), 'missing first bullet');
  assert(s.includes('• CP3: optional summary chart deferred'), 'missing second bullet');
  const bullets = (s.match(/•/g) || []).length;
  assert(bullets === 2, `expected 2 deduped bullets, got ${bullets}`);
  assert(s.startsWith('\n\n'), 'section should append with a leading blank line');
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
