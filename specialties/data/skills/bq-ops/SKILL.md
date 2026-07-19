# Skill: BigQuery Operations

## When to Use
When performing BigQuery operations via the `bq` CLI including running queries, checking table schema, loading data, managing partitioned tables, and exporting data to Cloud Storage.

## Commands

No custom corekit scripts are governed directly by this skill. Standard `bq` CLI command is used.

## Procedures

### Execute a query with cost estimation
1. Formulate the SQL query using Standard SQL syntax.
2. Run a dry run first to estimate query cost and data processed:
   ```bash
   bq query --nouse_legacy_sql --dry_run 'SELECT ...'
   ```
3. Check the dry run output. Warn if scan is > 1 GB, and block if > 100 GB.
4. Execute the query with a row limit:
   ```bash
   bq query --nouse_legacy_sql --max_rows=100 'SELECT ...'
   ```
5. Verify: Check that the command returns a JSON or tabular format of the query results.

### Create a table and load data
1. Run `bq mk --table PROJECT:DATASET.TABLE schema.json` to create the table with a schema definition.
2. Load data from GCS or a local file (e.g. CSV or JSONL):
   ```bash
   bq load --source_format=CSV --skip_leading_rows=1 PROJECT:DATASET.TABLE gs://BUCKET/file.csv
   ```
3. Verify: Run `bq show PROJECT:DATASET.TABLE` and check that the row count is greater than zero and matches expectations.

### Export data to Cloud Storage
1. Ensure the destination bucket exists.
2. Run the extract command:
   ```bash
   bq extract --destination_format=CSV PROJECT:DATASET.TABLE gs://BUCKET/exports/TABLE_*.csv
   ```
3. Verify: Check the GCS bucket to confirm the exported files exist.

---

## BigQuery Reference

### Table Discovery Reference
| What | Command |
|------|---------|
| List datasets | `bq ls --project_id=PROJECT` |
| List tables in dataset | `bq ls PROJECT:DATASET` |
| Show table schema | `bq show --schema PROJECT:DATASET.TABLE` |
| Table details | `bq show --format=prettyjson PROJECT:DATASET.TABLE` |

### Safety Rules
- **Always dry-run queries first** — check cost before executing
- Never DROP or DELETE without explicit approval and a backup plan
- Use `--max_rows` to limit output for exploratory queries
- Use `--format=json` for machine-readable output when chaining commands
- Verify table exists with `bq show` before loading or modifying
- Prefer partitioned queries — always filter on partition column when available

---

### Cost estimation mechanics

1. Dry-run the query and parse `totalBytesProcessed` from the output:
   ```bash
   bq query --nouse_legacy_sql --dry_run 'SELECT col1, col2 FROM dataset.table WHERE partition_date = "2025-01-01"'
   ```
2. Calculate on-demand cost: `bytes / 1e12 * $6.25` (per-TiB on-demand pricing).
3. Include the cost estimate in the execution report. Escalation thresholds (per the specialty SOUL): stop and report to cortex above $5 per query.
4. Check a table's size before scanning it:
   ```bash
   bq show --format=prettyjson dataset.table | grep -E '"numBytes"|"numRows"|"lastModifiedTime"'
   ```
5. Survey a dataset's tables and sizes:
   ```bash
   bq ls --format=prettyjson dataset | head -60
   ```

### Create a partitioned and clustered table

Tables expected to exceed 1 GB MUST be partitioned. Default strategy: time-based partitioning on ingestion time or a date column, plus clustering on high-cardinality filter columns (up to 4).

1. Create the table with partitioning and clustering flags:
   ```bash
   bq mk --table \
     --time_partitioning_field=event_date \
     --time_partitioning_type=DAY \
     --clustering_fields=user_id,event_type \
     project:dataset.table \
     schema.json
   ```
2. Verify: `bq show --format=prettyjson project:dataset.table` and confirm the `timePartitioning` and `clustering` blocks match the plan.

### Schema change workflow

1. Discover current state:
   ```bash
   bq show --schema --format=prettyjson dataset.table
   ```
2. Check downstream dependencies:
   ```bash
   # List views referencing the table
   bq ls --format=prettyjson dataset | grep -i view
   # Check scheduled queries
   bq ls --transfer_config --project_id=PROJECT --transfer_location=US
   ```
3. Apply the change in staging first (if a staging dataset exists).
4. Validate — run downstream views/queries against staging.
5. Apply to production only after validation passes.
6. Verify: report the before/after schema diff in the output.

### Error recovery

| Error | Discovery | Fix |
|-------|-----------|-----|
| Not found (404) | `bq show dataset.table` | Verify project/dataset/table name |
| Access denied (403) | `bq show --format=prettyjson dataset` | Check IAM, report missing role |
| Quota exceeded | `bq show --format=prettyjson --project_id=PROJECT` | Report quota, suggest partition pruning |
| Schema mismatch | `bq show --schema dataset.table` | Compare schemas, report diff |
| Invalid query | Review error message | Fix syntax, re-run dry run |

### Post-load null-rate check

After every load, check null rates for key columns (cerebellum flags any key column above 5% nulls when no per-column expectation is defined):

```sql
SELECT
  COUNTIF(column_name IS NULL) AS null_count,
  COUNT(*) AS total_count,
  ROUND(COUNTIF(column_name IS NULL) / COUNT(*) * 100, 2) AS null_pct
FROM `dataset.table`
```

Run via `bq query --nouse_legacy_sql` and include the result in the verification evidence.
