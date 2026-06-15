# Skill: GCP Billing Operations

## What this skill does
GCP billing procedures — cost breakdown, budget tracking, trend analysis, anomaly detection, monthly summaries

## When to use
When analyzing GCP billing data, tracking budgets, or generating cost reports

Use these procedures when performing GCP billing analysis tasks via `exec`.

## Cost Breakdown Discovery

| What | Command |
|------|---------|
| List billing accounts | `gcloud billing accounts list --format=json` |
| Account details | `gcloud billing accounts describe ACCOUNT_ID` |
| Linked projects | `gcloud billing projects list --billing-account=ACCOUNT_ID --format="table(projectId,billingEnabled)"` |
| List budgets | `gcloud billing budgets list --billing-account=ACCOUNT_ID --format=json` |
| Budget details | `gcloud billing budgets describe BUDGET_ID --billing-account=ACCOUNT_ID` |
| Enabled services | `gcloud services list --enabled --project=PROJECT --format="table(name)"` |

## BigQuery Billing Export Queries

**Prerequisites:** Billing export must be configured to BigQuery.

```bash
# Daily cost by service (last 30 days)
bq query --nouse_legacy_sql --dry_run \
  'SELECT
     service.description AS service,
     SUM(cost) AS total_cost,
     SUM(usage.amount) AS usage_amount,
     usage.unit
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   GROUP BY service, usage.unit
   ORDER BY total_cost DESC'

# Daily cost by project
bq query --nouse_legacy_sql \
  'SELECT
     project.id AS project,
     DATE(usage_start_time) AS date,
     SUM(cost) AS daily_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   GROUP BY project, date
   ORDER BY date DESC, daily_cost DESC'

# Cost by SKU (detailed breakdown)
bq query --nouse_legacy_sql \
  'SELECT
     service.description AS service,
     sku.description AS sku,
     SUM(cost) AS total_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
   GROUP BY service, sku
   HAVING total_cost > 0
   ORDER BY total_cost DESC
   LIMIT 50'

# Cost by label
bq query --nouse_legacy_sql \
  'SELECT
     l.key AS label_key,
     l.value AS label_value,
     SUM(cost) AS total_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`,
     UNNEST(labels) AS l
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
   GROUP BY label_key, label_value
   ORDER BY total_cost DESC'
```

## Cost Trend Analysis

```bash
# Weekly cost trend (last 12 weeks)
bq query --nouse_legacy_sql \
  'SELECT
     DATE_TRUNC(DATE(usage_start_time), WEEK) AS week,
     SUM(cost) AS weekly_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 84 DAY)
   GROUP BY week
   ORDER BY week DESC'

# Month-over-month comparison
bq query --nouse_legacy_sql \
  'SELECT
     FORMAT_DATE("%Y-%m", DATE(usage_start_time)) AS month,
     service.description AS service,
     SUM(cost) AS monthly_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
   GROUP BY month, service
   ORDER BY month DESC, monthly_cost DESC'

# Day-over-day for current month
bq query --nouse_legacy_sql \
  'SELECT
     DATE(usage_start_time) AS date,
     SUM(cost) AS daily_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)
   GROUP BY date
   ORDER BY date'
```

## Budget Threshold Checking

```bash
# List all budgets with amounts
gcloud billing budgets list \
  --billing-account=ACCOUNT_ID \
  --format="table(name,displayName,amount.specifiedAmount.units,budgetFilter.projects)"

# Get current spend vs budget
# (Requires billing export + budget config)
bq query --nouse_legacy_sql \
  'SELECT
     SUM(cost) AS current_spend
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)'

# Calculate burn rate
bq query --nouse_legacy_sql \
  'WITH monthly AS (
     SELECT SUM(cost) AS spend,
            DATE_DIFF(CURRENT_DATE(), DATE_TRUNC(CURRENT_DATE(), MONTH), DAY) + 1 AS days_elapsed,
            DATE_DIFF(LAST_DAY(CURRENT_DATE()), DATE_TRUNC(CURRENT_DATE(), MONTH), DAY) + 1 AS days_in_month
     FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
     WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)
   )
   SELECT spend AS current_spend,
          spend / days_elapsed AS daily_rate,
          (spend / days_elapsed) * days_in_month AS projected_monthly
   FROM monthly'
```

## Cost Anomaly Detection

```bash
# Compare today vs 7-day average
bq query --nouse_legacy_sql \
  'WITH daily AS (
     SELECT DATE(usage_start_time) AS date,
            service.description AS service,
            SUM(cost) AS daily_cost
     FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
     WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
     GROUP BY date, service
   ),
   averages AS (
     SELECT service,
            AVG(daily_cost) AS avg_cost,
            STDDEV(daily_cost) AS stddev_cost
     FROM daily
     WHERE date < CURRENT_DATE()
     GROUP BY service
   ),
   today AS (
     SELECT service, daily_cost
     FROM daily
     WHERE date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
   )
   SELECT t.service,
          t.daily_cost,
          a.avg_cost,
          (t.daily_cost - a.avg_cost) / NULLIF(a.stddev_cost, 0) AS z_score
   FROM today t JOIN averages a ON t.service = a.service
   WHERE (t.daily_cost - a.avg_cost) / NULLIF(a.stddev_cost, 0) > 2
   ORDER BY z_score DESC'

# Top cost spikes by service
bq query --nouse_legacy_sql \
  'SELECT
     DATE(usage_start_time) AS date,
     service.description AS service,
     SUM(cost) AS daily_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
   WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
   GROUP BY date, service
   HAVING daily_cost > 10
   ORDER BY daily_cost DESC
   LIMIT 20'
```

## Monthly Summary Generation

```bash
# Full monthly summary
bq query --nouse_legacy_sql --format=json \
  'SELECT
     service.description AS service,
     SUM(cost) AS total_cost,
     COUNT(DISTINCT project.id) AS projects,
     SUM(credits.amount) AS total_credits
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
     LEFT JOIN UNNEST(credits) AS credits
   WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)
   GROUP BY service
   ORDER BY total_cost DESC'

# Summary with credits breakdown
bq query --nouse_legacy_sql \
  'SELECT
     SUM(cost) AS gross_cost,
     SUM(credits.amount) AS total_credits,
     SUM(cost) + SUM(credits.amount) AS net_cost
   FROM `PROJECT.BILLING_DATASET.gcp_billing_export_v1_ACCOUNT_ID`
     LEFT JOIN UNNEST(credits) AS credits
   WHERE DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH)'
```

## Safety Rules
- **Always dry-run BigQuery queries first** — billing tables can be massive
- Never modify billing configuration without explicit approval
- Use date filters to limit scan scope — avoid full-table scans
- Use `--format=json` for machine-readable output when chaining commands
- Verify billing account ID and dataset names before querying
- Report costs in USD with two decimal places
