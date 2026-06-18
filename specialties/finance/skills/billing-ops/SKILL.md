# Skill: GCP Billing Operations

## When to Use
When analyzing GCP billing data, tracking budgets, calculating burn rates, identifying cost anomalies, or generating cost summary reports.

## Commands

No custom corekit scripts are governed directly by this skill. Standard `gcloud` and `bq` CLI commands are used.

## Procedures

### Discover billing details and linked projects
1. Run `gcloud billing accounts list --format=json` to fetch the active billing account ID.
2. Run `gcloud billing projects list --billing-account=<ACCOUNT_ID>` to list all projects linked to that billing account.
3. Verify: Ensure the command returns a list of projects showing billing enabled status.

### Query daily cost by service
1. Formulate the query targeting the billing export table in BigQuery.
2. Run a dry run first to estimate query cost:
   ```bash
   bq query --nouse_legacy_sql --dry_run \
     'SELECT service.description AS service, SUM(cost) AS total_cost FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID` WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) GROUP BY service ORDER BY total_cost DESC'
   ```
3. Check the estimated bytes scanned (ensure it is < 1 GB).
4. Run the query to fetch daily costs:
   ```bash
   bq query --nouse_legacy_sql --format=json --max_rows=100 'SELECT ...'
   ```
5. Verify: Check that the output contains a JSON list of services and total costs.

### Check spend vs budget
1. Run `gcloud billing budgets list --billing-account=<ACCOUNT_ID> --format=json` to list budget limits.
2. Run a query to calculate current month spend:
   ```bash
   bq query --nouse_legacy_sql \
     'SELECT SUM(cost) AS current_spend FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID` WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)'
   ```
3. Verify: Compare the current spend against the budget threshold from Step 1.

---

## Detailed Reference

### Cost Discovery Commands
```
# List billing accounts
gcloud billing accounts list --format=json

# List budgets
gcloud billing budgets list --billing-account=ACCOUNT_ID --format=json
```

### BigQuery Billing Export Queries

```sql
-- Daily cost by service (last 30 days)
SELECT
   service.description AS service,
   SUM(cost) AS total_cost,
   SUM(usage.amount) AS usage_amount,
   usage.unit
 FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
 WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
 GROUP BY service, usage.unit
 ORDER BY total_cost DESC

-- Daily cost by project
SELECT
   project.id AS project,
   DATE(usage_start_time) AS date,
   SUM(cost) AS daily_cost
 FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
 WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
 GROUP BY project, date
 ORDER BY date DESC, daily_cost DESC
```

### Cost Trend Analysis
```sql
-- Weekly cost trend (last 12 weeks)
SELECT
   DATE_TRUNC(DATE(usage_start_time), WEEK) AS week,
   SUM(cost) AS weekly_cost
 FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
 WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 84 DAY)
 GROUP BY week
 ORDER BY week DESC
```

## Safety Rules
- **Always dry-run BigQuery queries first** — billing tables can be massive
- Never modify billing configuration without explicit approval
- Use date filters to limit scan scope — avoid full-table scans
- Use `--format=json` for machine-readable output when chaining commands
- Verify billing account ID and dataset names before querying
- Report costs in USD with two decimal places
