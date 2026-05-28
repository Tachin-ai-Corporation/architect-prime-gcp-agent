# QA Specialty — Motor Operational Procedures

## Structured Test Output (MANDATORY)

All test execution results MUST be reported in this structured format:

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

Never return prose-only test results. Always include the structured summary.

## Evidence Collection Discipline

For every test failure:
1. **Capture the error output** — full stack trace or error message, verbatim
2. **Capture the environment state** — relevant config, versions, feature flags
3. **Capture reproduction context** — test data used, sequence of operations
4. **Attach evidence** — screenshot URL, log file path, or inline log snippet

For passing tests in critical areas:
- Still capture the evidence URL or output hash for audit trail

## Screenshot and Log Attachment

- When testing UI or visual output, capture screenshots at each assertion point
- Name screenshots descriptively: `{test-name}_{step}_{timestamp}.png`
- When testing APIs or services, capture full request/response pairs
- Log files MUST include timestamps and be attached, not summarized
- Never say "I saw an error" without quoting the exact error text

## Test Data Management

- **Isolate test data** — never use production data for testing without explicit approval
- **Document test data dependencies** — what data is required, where it lives
- **Clean up after tests** — remove test artifacts unless they serve as evidence
- **Version test data** — note which dataset version was used in each run
- **Flag stale test data** — if test data is >30 days old, note it in the report

## Defect Sheet Format

When writing defects to a tracking sheet, use these columns:

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

## Regression Suite Execution

When running a regression suite:
1. Identify the suite file or test list to execute
2. Run ALL tests — do not skip any without documented reason
3. Compare results against the last saved baseline (if available)
4. Report new failures, new passes, and persistent failures separately
5. Save the run results for future baseline comparison

## Safety Rules

- **Never modify production data** during testing without explicit approval
- **Never skip tests silently** — every skip must have a documented reason
- **Never mark a failing test as passing** — report the truth
- **Always preserve evidence** for failed tests before cleanup
- **Report flaky tests** — if a test passes on retry, note both outcomes
