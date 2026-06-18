# Skill: Google Sheets

## When to Use
When a task involves reading from, writing to, or appending rows in Google Sheets spreadsheets.

## Commands

### Read
- `sheets-get --sheet <ID> --range "Sheet1!A1:D10"` — Read cell values from a spreadsheet range.
  Output: JSON array of arrays containing cell values.

### Write
- `sheets-update --sheet <ID> --range "Sheet1!A1:B2" --values "JSON_ROWS" [--raw]` — Overwrite cells in a spreadsheet range.
  Output: Success confirmation.
- `sheets-append --sheet <ID> --range "Sheet1!A:C" --values "JSON_ROWS"` — Append row(s) to a spreadsheet, inserting below the last filled row.
  Output: Success confirmation with updated range details.

## Important Notes
- **Spreadsheet IDs:** Extract spreadsheet IDs from the URL. The ID is the long alphanumeric string after `/d/` and before `/edit`.
- **Value Formatting:** The `--values` parameter must be a JSON-formatted string representing an array of arrays (e.g. `'[["Header1", "Header2"], ["Val1", "Val2"]]'`).

## Procedures

### Read sheet data
1. Resolve the spreadsheet ID from Drive search or URL.
2. Run `sheets-get --sheet <ID> --range "Sheet1!A1:Z100"` to read sheet rows.
3. Verify: Check that output data is returned and represents the target sheet correctly.

### Append row to tracking log
1. Resolve the spreadsheet ID.
2. Format the new row as a JSON array of arrays: `[["value1", "value2", "value3"]]`.
3. Run `sheets-append --sheet <ID> --range "Sheet1!A:C" --values '[["value1", "value2", "value3"]]'`.
4. Verify: Ensure the output confirms row insertion below the last populated row.

### Update specific cells
1. Resolve the spreadsheet ID.
2. Format the updates as a JSON array of arrays.
3. Run `sheets-update --sheet <ID> --range "Sheet1!B5:B6" --values '[["UpdatedValue1"], ["UpdatedValue2"]]'`.
4. Verify: Confirm the output displays a success state.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account lacks share access | Ask the user to share the sheet with the agent's Workspace email address (shown in the error response). |
| `404 notFound` | Invalid spreadsheet ID | Run `drive-search` to find the correct spreadsheet by name and obtain the active ID. |
| `400 invalidArgument` | Range syntax is invalid, or values are not a valid JSON array of arrays | Verify range parameter format (e.g. "Sheet1!A1"). Ensure values are double-nested arrays like `[[ ... ]]` and JSON-encoded. |
| Row appended in wrong place | Range parameter does not match table bounds | Use a generic column range (like `Sheet1!A:E`) to find the next empty row for the table. |
