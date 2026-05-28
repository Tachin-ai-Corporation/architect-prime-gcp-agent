# Skill: BigQuery Operations

Use these procedures when performing BigQuery tasks via `exec`.

## Table Discovery

| What | Command |
|------|---------|
| List datasets | `bq ls --project_id=PROJECT` |
| List tables in dataset | `bq ls PROJECT:DATASET` |
| Show table schema | `bq show --schema PROJECT:DATASET.TABLE` |
| Table details | `bq show --format=prettyjson PROJECT:DATASET.TABLE` |
| Table row count | `bq query --nouse_legacy_sql 'SELECT COUNT(*) FROM \`PROJECT.DATASET.TABLE\`'` |
| Recent tables | `bq ls --max_results=20 --sort_by=lastModifiedTime PROJECT:DATASET` |
| Search table names | `bq ls PROJECT:DATASET \| grep PATTERN` |

## Query Execution with Cost Estimation

**Always dry-run first to estimate cost.**

```bash
# Step 1: Dry run — check bytes processed (cost estimate)
bq query --nouse_legacy_sql --dry_run \
  'SELECT col1, col2 FROM `PROJECT.DATASET.TABLE` WHERE date > "2026-01-01"'

# Step 2: If bytes reasonable, execute
bq query --nouse_legacy_sql --max_rows=100 \
  'SELECT col1, col2 FROM `PROJECT.DATASET.TABLE` WHERE date > "2026-01-01"'

# JSON output for parsing
bq query --nouse_legacy_sql --format=json --max_rows=1000 \
  'SELECT col1, col2 FROM `PROJECT.DATASET.TABLE` LIMIT 1000'

# Save results to table
bq query --nouse_legacy_sql \
  --destination_table=PROJECT:DATASET.RESULT_TABLE \
  --replace \
  'SELECT * FROM `PROJECT.DATASET.TABLE` WHERE condition'
```

### Cost Estimation Rule
- $5 per TB scanned (on-demand pricing)
- Dry-run returns `totalBytesProcessed`
- **WARN if > 1 GB** — confirm before executing
- **BLOCK if > 100 GB** — require explicit approval

## Schema Management

```bash
# Create dataset
bq mk --dataset --description="Description" PROJECT:DATASET

# Create table with schema
bq mk --table PROJECT:DATASET.TABLE schema.json

# Create table with inline schema
bq mk --table PROJECT:DATASET.TABLE \
  name:STRING,created_at:TIMESTAMP,value:FLOAT64,active:BOOL

# Update table schema (add columns only)
bq update PROJECT:DATASET.TABLE new_schema.json

# Add description to table
bq update --description="Table description" PROJECT:DATASET.TABLE

# Add column description
bq query --nouse_legacy_sql \
  'ALTER TABLE `PROJECT.DATASET.TABLE` ALTER COLUMN col SET OPTIONS(description="Column description")'
```

## Data Loading

```bash
# Load CSV from local file
bq load --source_format=CSV --skip_leading_rows=1 \
  PROJECT:DATASET.TABLE file.csv schema.json

# Load JSON (newline-delimited)
bq load --source_format=NEWLINE_DELIMITED_JSON \
  PROJECT:DATASET.TABLE file.jsonl schema.json

# Load from GCS
bq load --source_format=CSV --skip_leading_rows=1 \
  PROJECT:DATASET.TABLE gs://BUCKET/PATH/*.csv schema.json

# Load Parquet (auto-detect schema)
bq load --source_format=PARQUET --autodetect \
  PROJECT:DATASET.TABLE gs://BUCKET/PATH/*.parquet

# Append vs replace
bq load --replace --source_format=CSV \
  PROJECT:DATASET.TABLE file.csv schema.json
```

## Partition and Clustering

```bash
# Create time-partitioned table
bq mk --table \
  --time_partitioning_field=created_at \
  --time_partitioning_type=DAY \
  --clustering_fields=user_id,region \
  PROJECT:DATASET.TABLE schema.json

# Check partition info
bq show --format=prettyjson PROJECT:DATASET.TABLE | grep -A5 "timePartitioning"

# Query specific partition (cost-efficient)
bq query --nouse_legacy_sql \
  'SELECT * FROM `PROJECT.DATASET.TABLE` WHERE DATE(created_at) = "2026-05-01"'

# List partitions
bq query --nouse_legacy_sql \
  'SELECT table_name, partition_id, total_rows, total_logical_bytes
   FROM `PROJECT.DATASET.INFORMATION_SCHEMA.PARTITIONS`
   WHERE table_name = "TABLE"
   ORDER BY partition_id DESC LIMIT 20'
```

## Table Freshness Check

```bash
# Last modified time
bq show --format=prettyjson PROJECT:DATASET.TABLE | grep "lastModifiedTime"

# Row count trend (if time-partitioned)
bq query --nouse_legacy_sql \
  'SELECT DATE(created_at) as dt, COUNT(*) as rows
   FROM `PROJECT.DATASET.TABLE`
   WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
   GROUP BY dt ORDER BY dt DESC'

# Check INFORMATION_SCHEMA for staleness
bq query --nouse_legacy_sql \
  'SELECT table_name,
          TIMESTAMP_MILLIS(last_modified_time) as last_modified,
          TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(last_modified_time), HOUR) as hours_stale
   FROM `PROJECT.DATASET.__TABLES__`
   ORDER BY last_modified_time DESC'
```

## Export to GCS

```bash
# Export to CSV
bq extract --destination_format=CSV \
  PROJECT:DATASET.TABLE gs://BUCKET/exports/TABLE_*.csv

# Export to JSON
bq extract --destination_format=NEWLINE_DELIMITED_JSON \
  PROJECT:DATASET.TABLE gs://BUCKET/exports/TABLE_*.jsonl

# Export to Parquet
bq extract --destination_format=PARQUET \
  PROJECT:DATASET.TABLE gs://BUCKET/exports/TABLE_*.parquet

# Export with compression
bq extract --destination_format=CSV --compression=GZIP \
  PROJECT:DATASET.TABLE gs://BUCKET/exports/TABLE_*.csv.gz
```

## Safety Rules
- **Always dry-run queries first** — check cost before executing
- Never DROP or DELETE without explicit approval and a backup plan
- Use `--max_rows` to limit output for exploratory queries
- Use `--format=json` for machine-readable output when chaining commands
- Verify table exists with `bq show` before loading or modifying
- Prefer partitioned queries — always filter on partition column when available
