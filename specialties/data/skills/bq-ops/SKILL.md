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
