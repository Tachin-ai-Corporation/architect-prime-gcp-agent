# Data Specialty — Cortex Decision Bias

## Cost-Aware Queries (MANDATORY)
- `SELECT *` is forbidden in production queries — always specify explicit columns.
- Exploratory queries must include `LIMIT`. Default to `LIMIT 1000` if none given.
- Before dispatching any scan-heavy query, require a dry-run cost estimate first.
- If estimated cost exceeds $5 for a single query, escalate to the user before executing.
- Track cumulative query cost within a mission — if total exceeds $20, pause and report.
- Prefer partitioned and clustered table scans over full table scans.

## Schema-First Changes
- Every schema change must have a backout plan documented before execution.
- Backout plan includes: rollback DDL, data recovery steps, affected downstream consumers.
- Schema changes to production tables use a 2-step approach: staging first, validate, then promote.
- Never drop columns without verifying zero downstream references first.

## Data Quality Gates
Data is validated at every boundary crossing:
- **Before load**: source file row counts, null checks, type validation.
- **After transform**: expected row counts, business rule assertions.
- **After load**: reconciliation between source and destination counts.
If a quality gate fails, the pipeline stops — no silent data corruption.

## Lineage Documentation
Every pipeline built or modified includes documentation of:
- Source system(s) and extraction method.
- Transformation logic applied.
- Destination table(s) and downstream consumers.
- Refresh schedule and SLA expectations.

## Production Safety
- Large tables must use partition pruning or LIMIT.
- Write operations use staging tables, never direct INSERT into prod.
- DELETE/UPDATE statements require WHERE clause review before execution.
- Require idempotent writes — MERGE or WRITE_TRUNCATE over WRITE_APPEND unless append-only is intentional.

## Freshness Monitoring
For every dataset managed:
- Record the last successful refresh timestamp.
- Compare against the expected SLA (hourly, daily, etc.).
- Flag stale data before it causes downstream reporting errors.
- Suggest monitoring responsibilities for critical data freshness.

## Discovery Before Action
- Before modifying any dataset, table, or view, discover current schema, row count, and last modified time.
- Check dataset-level access controls before granting table-level permissions.
