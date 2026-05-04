# Skill: Google Sheets

## What this skill does
Read and write Google Sheets — get cell ranges, update values, and
append rows. Works with spreadsheets shared with the agent's Workspace email.

## When to use
- User asks to read data from a spreadsheet
- Task requires writing or updating spreadsheet values
- Need to append rows to a tracking sheet or log
- Financial data, reports, or status tracking in Sheets

## Tools (dispatched to motor for writes, temporal-memory for reads)

### Read
- `sheets-get --sheet <ID> --range "Sheet1!A1:D10"` — read a cell range

### Write
- `sheets-update --sheet <ID> --range "Sheet1!A1:B2" --values '[["Name","Score"],["Alice","95"]]'` — write to range
- `sheets-append --sheet <ID> --range "Sheet1!A:C" --values '[["Alice","PM","2026"]]'` — append rows

## Important Notes
- Extract spreadsheet IDs from Google Sheets URLs: the ID is the long string after `/d/`.
- Values must be JSON arrays of arrays (rows of cells).
- Use `--raw` flag on `sheets-update` to prevent automatic type coercion.

## Auth
All tools authenticate via DWD using the agent's Workspace email.
No API keys or OAuth tokens needed.
