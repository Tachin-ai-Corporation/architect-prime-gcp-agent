# QA Specialty — Cerebellum Verification Rules

## Skip Verification (MANDATORY)

- **Refuse to mark a suite as GREEN if there are unexplained skips**
- Every skipped test MUST have a `reason` field — "unknown" or empty is NOT acceptable
- If skips exceed 10% of total tests, flag the run as `YELLOW` regardless of pass rate
- Acceptable skip reasons: `environment_unavailable`, `known_flaky_pending_fix`, `not_applicable_to_env`, `blocked_by_DEF-NNNN`
- Unacceptable skip reasons: empty string, `TODO`, `skip`, `disabled`

## Regression Verification

- Compare current run results against the **last known baseline**
- Flag any test that was PASS in baseline but is now FAIL as a **regression**
- Flag any test that was FAIL in baseline but is now PASS as a **fix** (positive signal)
- If no baseline exists, note this explicitly — do not assume all results are new
- A run with ANY new regressions MUST be flagged, even if overall pass rate is high

### Regression Diff Format
```
REGRESSIONS (were PASS, now FAIL):
  ❌ test.name.here — was PASS @ baseline 2025-01-15, now FAIL
  ❌ test.name.two — was PASS @ baseline 2025-01-15, now FAIL

FIXES (were FAIL, now PASS):
  ✅ test.name.three — was FAIL @ baseline 2025-01-15, now PASS

PERSISTENT FAILURES (still FAIL):
  ⚠️ test.name.four — FAIL since baseline 2025-01-10

NEW TESTS (not in baseline):
  🆕 test.name.five — PASS (new)
```

## Evidence Validation

- Every FAIL result MUST have an `evidence_url` or inline evidence — reject results without it
- Evidence must be **specific** — "see logs" is not acceptable; "see `build-log-2025-01-15.txt` line 47" is
- For S1/S2 defects, require **two forms of evidence** (e.g., screenshot + log snippet)
- Verify that referenced evidence URLs/paths actually exist when possible

## Coverage Threshold Checks

- If the project defines a coverage threshold, verify the run meets it
- Flag any feature area that drops below threshold compared to baseline
- Coverage must be reported by **feature area**, not just aggregate percentage
- A coverage decrease in a critical feature area is a blocker, even if aggregate is above threshold

## Result Integrity Checks

- **Total = pass + fail + skip + error** — if the math doesn't add up, reject the report
- Test counts should be roughly consistent between runs — a sudden drop in total tests means tests were removed or not discovered
- If total test count drops by >5% from baseline without explanation, flag it
- Execution time anomalies (>2x baseline duration or <50% baseline duration) should be noted

## Flaky Test Detection

- If a test fails, then passes on immediate retry, mark it as `FLAKY`
- Flaky tests do NOT count as passing for coverage purposes
- Track flaky test frequency — if a test is flaky >3 times in 30 days, it needs a fix or removal
- Flaky tests should be reported separately in the summary

## Verification Checklist (run for every test report)

1. ☐ All skip reasons are documented and acceptable
2. ☐ Regression diff computed against last baseline
3. ☐ Every failure has evidence attached
4. ☐ Total = pass + fail + skip + error
5. ☐ Coverage thresholds met (if defined)
6. ☐ No unexplained test count changes from baseline
7. ☐ Flaky tests identified and flagged
8. ☐ S1/S2 defects have dual evidence

### Drive Convention Gate
- ✅ PASS if agent used `work-publish` for artifact uploads
- ⚠️ WARN if agent used raw `drive-upload` — suggest `work-publish` next time
- ✅ PASS if no artifacts were produced (read-only mission)
