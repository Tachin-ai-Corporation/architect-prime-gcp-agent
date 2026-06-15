# Finance Specialty — Motor Operational Procedures

## Currency Formatting (MANDATORY)

- All monetary values MUST be formatted with exactly **2 decimal places**.
- Use comma separators for thousands: `$1,234.56`, not `$1234.56`.
- Always specify the currency code when context is ambiguous: `USD $1,234.56`.
- Negative values use parentheses in formal reports: `($1,234.56)`, minus sign in sheets: `-$1,234.56`.
- Round to 2dp AFTER all calculations are complete — do not round intermediate values.

## Append-Only Sheet History (MANDATORY)

- Financial sheets are **append-only**. NEVER delete rows from financial tracking sheets.
- To correct an error, add an **adjustment row** with:
  - Original row reference
  - Adjustment amount (positive or negative)
  - Reason for adjustment
  - Date of adjustment
  - Who requested the adjustment
- Use `sheets-append` to add new data. Use `sheets-update` ONLY for:
  - Correcting formulas (not values)
  - Updating status columns
  - Adding notes/comments to existing rows
- Before any sheet modification, read current state with `sheets-get` first.

## Formula Audit Trail

- When adding formulas to financial sheets, always include a comment documenting:
  - What the formula calculates
  - Source cells/ranges referenced
  - Any assumptions embedded in the formula
- Prefer named ranges over cell references where the sheet supports it.
- Never hardcode tax rates, exchange rates, or discount percentages — reference them from a dedicated "Assumptions" row/section.

## Billing Query Patterns

Common GCP billing export queries:

```sql
-- Monthly cost by service
SELECT
  service.description AS service,
  ROUND(SUM(cost), 2) AS total_cost,
  ROUND(SUM(credits.amount), 2) AS total_credits
FROM `billing_export.gcp_billing_export`
LEFT JOIN UNNEST(credits) AS credits
WHERE invoice.month = 'YYYY-MM'
GROUP BY service.description
ORDER BY total_cost DESC

-- Daily cost trend
SELECT
  DATE(usage_start_time) AS usage_date,
  ROUND(SUM(cost), 2) AS daily_cost
FROM `billing_export.gcp_billing_export`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY usage_date
ORDER BY usage_date

-- Cost by project
SELECT
  project.id AS project_id,
  project.name AS project_name,
  ROUND(SUM(cost), 2) AS total_cost
FROM `billing_export.gcp_billing_export`
WHERE invoice.month = 'YYYY-MM'
GROUP BY project.id, project.name
ORDER BY total_cost DESC

-- Top SKUs by cost
SELECT
  service.description AS service,
  sku.description AS sku,
  ROUND(SUM(cost), 2) AS total_cost
FROM `billing_export.gcp_billing_export`
WHERE invoice.month = 'YYYY-MM'
GROUP BY service.description, sku.description
ORDER BY total_cost DESC
LIMIT 20
```

## Report Generation Workflow

1. **Gather data**: Query billing export or read from sheets.
2. **Validate**: Cross-check totals against invoice or billing console.
3. **Format**: Apply currency formatting, sort by impact.
4. **Annotate**: Add variance explanations for any line item >5% change.
5. **Output**: Write to designated sheet or include in mission summary.

## Safety Rules

- **Never delete financial data** — append adjustments only.
- **Never modify historical values** — add correction rows instead.
- **Never assume billing data is real-time** — it can lag 24-48 hours.

## Error Recovery

| Error | Discovery | Fix |
|-------|-----------|-----|
| Sheet not found | `sheets-get SPREADSHEET_ID` | Verify spreadsheet ID, check sharing |
| Permission denied | Check service account permissions | Report to user, request share |
| Billing export empty | Check export table existence | Verify billing export is configured |
| Stale billing data | Check `export_time` in billing table | Note lag in report, use most recent available |
| Formula error | Read cell value and formula | Fix formula, document in adjustment log |
