# Data Specialty — Cerebellum Verification Rules

## ETL Completion Verification (MANDATORY)

Every ETL or data load completion MUST be verified with ALL of the following checks before reporting success:

### Row Count Verification
- Compare source row count to destination row count.
- If counts diverge by more than 0.1%, flag as anomaly — do not auto-approve.
- Report exact counts: `Source: N rows → Destination: M rows (delta: D)`.

### Schema Verification
- After any load or transform, verify the destination schema matches expectations.
- Run `bq show --schema dataset.table` and compare to the planned schema.
- Flag any unexpected column additions, type changes, or missing columns.

### Freshness Verification
- Check `lastModifiedTime` of the destination table after load.
- Verify it is within the expected SLA window (e.g., updated within the last N hours).
- Report: `Last modified: TIMESTAMP (age: X hours)`.

## Data Lineage Validation

- For any derived table or view, verify that ALL source tables exist and are accessible.
- Check that source tables have been updated since the last pipeline run.
- If a source table is stale (older than expected), flag the lineage as potentially broken.
- Report lineage chain: `source_table → transform → destination_table`.

## Null Anomaly Detection

- After every load, check null rates for key columns.
- Expected null rates should be defined per column — if not defined, flag any column with >5% nulls.
- Query pattern:
  ```sql
  SELECT
    COUNTIF(column_name IS NULL) AS null_count,
    COUNT(*) AS total_count,
    ROUND(COUNTIF(column_name IS NULL) / COUNT(*) * 100, 2) AS null_pct
  FROM `dataset.table`
  ```
- If null rate exceeds threshold, report as WARNING — do not fail silently.

## Cost Verification

- After every query or pipeline execution, verify the actual bytes billed.
- Compare actual cost to the dry-run estimate provided by motor.
- If actual cost exceeds estimate by >20%, flag as cost anomaly.
- Track cumulative mission cost and report in summary.
- Report format: `Estimated: $X.XX | Actual: $Y.YY | Delta: Z%`.

## Data Quality Assertions

- Verify primary key uniqueness after any MERGE or INSERT operation.
- Check for orphaned foreign key references after any schema or data change.
- Validate date ranges — no future dates in historical columns, no dates before project start.
- Check for duplicate rows using a hash of all columns on a sample.

## Evidence Requirements

- Every verification claim MUST cite the specific `bq` command output or query result.
- Do not approve a pipeline run based on cortex's plan alone — require motor's execution evidence.
- Screenshots or raw output of row counts, schema diffs, and freshness checks must be included in the verification report.
- If any check cannot be performed (e.g., access denied), report it as UNVERIFIED, not as passed.
