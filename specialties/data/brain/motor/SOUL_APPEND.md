# Data Specialty — Motor Operational Procedures

## Dry-Run First (MANDATORY)

Always run `--dry_run` before executing any BigQuery query or DML statement.

```bash
# Estimate bytes scanned before executing
bq query --dry_run --use_legacy_sql=false 'SELECT col1, col2 FROM dataset.table WHERE partition_date = "2025-01-01"'
```

- Parse the `totalBytesProcessed` from dry-run output.
- Calculate cost: `bytes / 1e12 * $6.25` (on-demand pricing).
- If cost > $5, STOP and report to cortex. Do not execute.
- Include the cost estimate in your execution report.

## Cost Estimation Commands

```bash
# Dry-run a query
bq query --dry_run --use_legacy_sql=false 'QUERY_HERE'

# Check table size
bq show --format=prettyjson dataset.table | grep -E '"numBytes"|"numRows"|"lastModifiedTime"'

# Check dataset tables and sizes
bq ls --format=prettyjson dataset | head -60
```

## Partition Requirements

- Tables expected to exceed 1 GB MUST be partitioned.
- Default partition strategy: time-based partitioning on ingestion time or a date column.
- Always include clustering on high-cardinality filter columns (up to 4 columns).
- When creating partitioned tables:
  ```bash
  bq mk --table \
    --time_partitioning_field=event_date \
    --time_partitioning_type=DAY \
    --clustering_fields=user_id,event_type \
    project:dataset.table \
    schema.json
  ```

## Data Validation Before Load

Before loading data into any production table:

1. **Row count check**: Count source rows and compare to expected.
2. **Schema compatibility**: Validate source schema matches target (`bq show` the target first).
3. **Null check**: Verify required fields have no nulls in the source.
4. **Duplicate check**: Verify primary key uniqueness in the source.
5. **Sample inspection**: `SELECT * FROM source LIMIT 10` — eyeball data quality.

Only proceed with load after all 5 checks pass.

## Schema Change Workflow

1. **Discover current state**:
   ```bash
   bq show --schema --format=prettyjson dataset.table
   ```
2. **Check downstream dependencies**:
   ```bash
   # List views referencing the table
   bq ls --format=prettyjson dataset | grep -i view
   # Check scheduled queries
   bq ls --transfer_config --project_id=PROJECT --transfer_location=US
   ```
3. **Apply change in staging first** (if staging dataset exists).
4. **Validate** — run downstream views/queries against staging.
5. **Apply to production** only after validation passes.
6. **Document** — report the before/after schema diff in your output.

## Safety Rules

- **Never DROP TABLE without explicit user confirmation** — report the table name, row count, and size first.
- **Never DELETE FROM without a WHERE clause** — always scope deletes.
- **Never overwrite production data without a backup** — create a snapshot or copy first.
- **Always verify dataset and table existence** before attempting operations on them.
- **Quote project, dataset, and table names** in backtick format for BQ SQL: `` `project.dataset.table` ``.

## Error Recovery

| Error | Discovery | Fix |
|-------|-----------|-----|
| Not found (404) | `bq show dataset.table` | Verify project/dataset/table name |
| Access denied (403) | `bq show --format=prettyjson dataset` | Check IAM, report missing role |
| Quota exceeded | `bq show --format=prettyjson --project_id=PROJECT` | Report quota, suggest partition pruning |
| Schema mismatch | `bq show --schema dataset.table` | Compare schemas, report diff |
| Invalid query | Review error message | Fix syntax, re-run dry_run |
