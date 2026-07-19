# Skill: Test Runner Operations

## When to Use
When running test suites, collecting code coverage metrics, analyzing test logs, or detecting flaky tests across Node.js, Python, or Go environments.

## Commands

No custom corekit scripts are governed directly by this skill.

## Procedures

### Run test suite and check coverage
1. Identify the project type (Node.js, Python, or Go).
2. Run the appropriate test command with coverage collection flags:
   - Node: `npx jest --coverage --coverageReporters=text 2>&1`
   - Python: `python -m pytest --cov=. --cov-report=term-missing 2>&1`
   - Go: `go test -coverprofile=coverage.out ./... 2>&1`
3. Verify: Check that the test runner outputs a coverage summary containing percentages for statements, branches, functions, and lines.

### Troubleshoot a failing test
1. Retrieve the names or files of failing tests from the build output.
2. Run only the failed test(s) with verbose output redirected:
   - Jest: `npx jest path/to/failed.test.ts --verbose 2>&1`
   - Pytest: `python -m pytest path/to/failed.py -v --tb=short 2>&1`
3. Verify: Inspect the stack trace and error message details to identify the cause of the failure.

### Detect flaky tests
1. Run the test suite multiple times in a loop or using runner repeat features:
   - Go: `go test ./... -count=5 -v 2>&1`
   - Pytest: `python -m pytest --count=5 -x 2>&1`
   - Node: Run in a loop: `for i in {1..5}; do npm test 2>&1; done`
2. Verify: Compare the outcomes of each run. If a test passes in some runs and fails in others, flag it as a flaky test.

---

## Environment Reference

### Node.js / JavaScript / TypeScript
```bash
# Run all tests
npm test 2>&1

# Run specific test file
npx jest PATH/TO/TEST.test.ts 2>&1

# Jest built-in coverage
npx jest --coverage --coverageReporters=text 2>&1
```

### Python
```bash
# Run all tests
python -m pytest -v 2>&1

# Run specific test file
python -m pytest tests/test_module.py -v 2>&1

# Collect coverage
python -m pytest --cov=. --cov-report=term-missing 2>&1
```

### Go
```bash
# Run all tests
go test ./... -v 2>&1

# Basic coverage
go test -cover ./... 2>&1
```

## Safety Rules
- Always redirect stderr with `2>&1` to capture full output
- Use timeouts to prevent hanging tests from blocking execution
- Never modify test files during a test run — read-only analysis
- Save results to files for comparison, not just stdout
- Report exact test names and file paths for failures

---

## Structured Test Result Reporting

All test execution results MUST be reported in this structured format — never prose-only:

```json
{
  "suite": "Suite Name",
  "run_timestamp": "ISO-8601",
  "environment": "staging|production|local",
  "summary": {
    "total": 0,
    "pass": 0,
    "fail": 0,
    "skip": 0,
    "error": 0
  },
  "failures": [
    {
      "test_name": "descriptive.test.name",
      "expected": "what should happen",
      "actual": "what happened",
      "error_message": "verbatim error",
      "evidence_url": "link to screenshot/log"
    }
  ],
  "skips": [
    {
      "test_name": "descriptive.test.name",
      "reason": "why it was skipped"
    }
  ]
}
```

Integrity rule: `total` must equal `pass + fail + skip + error`.

Acceptable skip reasons: `environment_unavailable`, `known_flaky_pending_fix`, `not_applicable_to_env`, `blocked_by_DEF-NNNN`. Unacceptable: empty string, `TODO`, `skip`, `disabled`.

Evidence capture:
- Name screenshots descriptively: `{test-name}_{step}_{timestamp}.png`
- For API/service tests, capture full request/response pairs
- Attach log files with timestamps — do not summarize them
- Passing tests in critical areas still get an evidence URL or output hash for the audit trail

## Regression Diff Reporting

When a baseline exists, compare the current run against it and report the diff in this format:

```
REGRESSIONS (were PASS, now FAIL):
  test.name.here — was PASS @ baseline 2025-01-15, now FAIL

FIXES (were FAIL, now PASS):
  test.name.three — was FAIL @ baseline 2025-01-15, now PASS

PERSISTENT FAILURES (still FAIL):
  test.name.four — FAIL since baseline 2025-01-10

NEW TESTS (not in baseline):
  test.name.five — PASS (new)
```

- Save each run's results to a file for future baseline comparison.
- If no baseline exists, state that explicitly — do not assume all results are new.
- Flag the run if total test count drops more than 5% from baseline without explanation, or if execution time is more than 2x or less than half the baseline duration.

## Defect Record Format

When recording defects in a tracking sheet or file, use these columns:

| Column | Content |
|--------|---------|
| **ID** | Auto-increment or `DEF-NNNN` |
| **Title** | Short, specific summary (not "bug found") |
| **Severity** | S1 / S2 / S3 / S4 |
| **Status** | Open / In Progress / Fixed / Verified / Closed |
| **Found Date** | ISO-8601 date |
| **Found By** | Agent name or test suite name |
| **Repro Steps** | Numbered steps to reproduce |
| **Expected** | What should happen |
| **Actual** | What does happen |
| **Evidence** | URL to screenshot, log, or test output |
| **Environment** | Where the bug was found |
| **Assigned To** | Who is fixing it |
| **Fix Date** | When it was fixed (blank if open) |
| **Verified Date** | When fix was verified (blank if not yet) |
