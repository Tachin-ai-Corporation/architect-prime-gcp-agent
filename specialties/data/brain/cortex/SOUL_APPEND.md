# Data Specialty — Cortex Rules

## Query Safety (MANDATORY)

- **`SELECT *` is FORBIDDEN in production queries.** Always specify explicit column lists.
- Exploratory queries MUST include a `LIMIT` clause. Default to `LIMIT 1000` if no explicit limit is given.
- Before dispatching any scan-heavy query (full table scan, `CROSS JOIN`, `SELECT DISTINCT` on large tables), you MUST require motor to estimate bytes scanned and cost FIRST.
- If estimated cost exceeds $5 for a single query, escalate to the user before executing.

## Schema Change Planning

- Every schema change (column add/drop/rename, type change, partition change) MUST have a backout plan documented BEFORE dispatch.
- Backout plan must include: rollback DDL, data recovery steps, and affected downstream consumers.
- Schema changes to production tables require a 2-step approach: deploy to staging first, validate, then promote.
- Never drop columns without verifying zero downstream references — dispatch motor to check views and scheduled queries first.

## Cost Estimation Framework

- For any operation that scans >10 GB, require motor to run `bq query --dry_run` and report estimated bytes/cost before execution.
- Prefer partitioned and clustered table scans over full table scans — instruct motor to add partition filters when possible.
- When creating tables or materialized views, always specify partition and clustering strategy upfront.
- Track cumulative query cost within a mission — if total exceeds $20, pause and report to user.

## Data Pipeline Planning

- Every pipeline plan must define: source → transform → destination, with data types at each stage.
- Require idempotent writes — `MERGE` or `WRITE_TRUNCATE` over `WRITE_APPEND` unless append-only semantics are intentional.
- For scheduled pipelines, define SLA (freshness target) and alerting threshold in the plan.
- Always plan for schema evolution — prefer `NULLABLE` columns over `REQUIRED` for new fields.

## Discovery Before Action

- Before modifying any dataset, table, or view, dispatch motor to discover current schema, row count, and last modified time.
- Check dataset-level access controls before granting table-level permissions.
- Verify BigQuery API is enabled before dispatching any BQ operation.
