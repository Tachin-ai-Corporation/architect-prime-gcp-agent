# Finance Specialty — Cerebellum Verification Rules

## Numeric Traceability (MANDATORY)

- Every numeric claim in a report or recommendation MUST trace back to a specific source row, cell, or query result.
- Verify by checking: Does the motor output contain the raw data that supports this number?
- If a number appears in the cortex synthesis but has no motor-provided evidence, flag it as UNVERIFIED.
- Format verification: `Claim: $1,234.56 → Source: [Sheet] Cell D15 = $1,234.56 ✓`

## Cross-Validation of Totals

- When a report contains subtotals and a grand total, verify that subtotals sum to the grand total.
- Tolerance: allow rounding discrepancies up to $0.02 per subtotal line. Flag anything beyond.
- When comparing two sources (e.g., billing export vs. invoice), report both values and the delta.
- If delta exceeds 1%, flag as DISCREPANCY and require explanation before approving.
- Check that percentage breakdowns sum to 100% (±0.1% for rounding).

## Stale Data Detection

- Check the freshness of every data source used in a report.
- Billing export data older than 72 hours MUST be flagged: `⚠ Data as of DATE — may not reflect last 48-72 hours`.
- Sheet data without a "last updated" timestamp should be flagged as UNVERIFIED FRESHNESS.
- If a report combines data from multiple sources with different freshness, note the oldest source.
- Never approve a report that silently uses stale data — make staleness visible.

## Variance Threshold Alerts

Apply these thresholds to all cost comparisons:

| Variance | Severity | Action |
|----------|----------|--------|
| <5% | INFO | Note in report, no flag needed |
| 5–15% | WARNING | Flag in report, require attribution |
| 15–30% | HIGH | Flag prominently, require root cause analysis |
| >30% | CRITICAL | Escalate to user, require immediate investigation |

- Apply thresholds to both month-over-month AND budget-vs-actual comparisons.
- For new services (no prior month baseline), compare against the budgeted amount only.
- One-time charges should be separated from recurring cost analysis.

## Currency and Formatting Verification

- Verify all monetary values use exactly 2 decimal places.
- Verify comma separators are used for values ≥ $1,000.
- Verify currency is consistent throughout the report (no mixing USD/EUR without conversion).
- Verify negative values are formatted consistently (all parentheses OR all minus signs, not mixed).

## Evidence Requirements

- Every financial report must include:
  - Data sources used (with freshness timestamps)
  - Query or sheet references for each major number
  - Date range of the analysis
  - Any assumptions made (e.g., annualization, proration)
- Do not approve a recommendation that lacks a cost impact estimate.
- Do not approve a variance analysis that skips the attribution step.
- If motor could not access a data source, report that gap — do not substitute guessed values.

### Drive Convention Gate
- ✅ PASS if agent used `work-publish` for artifact uploads
- ⚠️ WARN if agent used raw `drive-upload` — suggest `work-publish` next time
- ✅ PASS if no artifacts were produced (read-only mission)
