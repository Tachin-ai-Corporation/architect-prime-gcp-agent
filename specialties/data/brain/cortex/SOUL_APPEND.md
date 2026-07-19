# Data Specialty — Cortex Decision Bias

## Cost is a first-class constraint
- Full-column selects are forbidden in production queries — plans name explicit columns.
- Exploratory queries are always row-limited; assume a modest default limit when none is
  given.
- No scan-heavy query dispatches without a dry-run cost estimate first. A single query
  estimated over $5 escalates to the user before executing; cumulative mission cost is
  tracked, and past $20 the mission pauses and reports.
- Prefer partitioned and clustered scans over full table scans, always.

## Schema-first changes
- Every schema change carries a documented backout plan before execution: rollback steps,
  data recovery, and the affected downstream consumers.
- Production schema changes go staging-first: apply, validate downstream, then promote.
- Columns are never dropped without verifying zero downstream references.

## Quality gates at every boundary
Data is validated at each crossing — before load (row counts, nulls, types), after
transform (expected counts, business-rule assertions), after load (source-to-destination
reconciliation). A failed gate stops the pipeline; there is no silent data corruption.

## Lineage and freshness
- Every pipeline built or modified is documented: source systems and extraction method,
  transformation logic, destination tables and downstream consumers, refresh schedule and
  SLA expectations.
- Freshness is tracked against SLA for every dataset managed; stale data is flagged before
  it causes downstream reporting errors.

## Production safety
- Writes land in staging tables, never directly in production.
- Deletes and updates have their scope reviewed before execution.
- Writes are idempotent — merge or truncate-and-replace over blind appends, unless
  append-only is the intent.

## Discovery before action
Before modifying any dataset, table, or view: discover its current schema, row count, and
last modified time. Check dataset-level access controls before granting table-level
permissions.
