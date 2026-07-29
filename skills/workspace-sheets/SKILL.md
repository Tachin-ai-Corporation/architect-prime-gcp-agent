# Skill: Google Sheets

## When to Use
When a task involves reading from, understanding, or writing to a Google Sheets
spreadsheet — reading cell ranges, updating existing records in place, or
appending new rows.

## Core principle: discover, then edit in place

You are usually handed a spreadsheet you have never seen. **Never assume a tab is
called "Sheet1"** and never rewrite a whole table to change a few cells. Two
facts drive everything below:

1. A spreadsheet has one or more **tabs**, each with its own name and size. You
   must discover the real names before you can read or write — `sheets-info`.
2. Writing **values** to a cell (`sheets-update` / `sheets-batch-update`) changes
   only those cells' contents. It does **not** touch formatting, merges,
   formulas, borders, or conditional formatting anywhere — those are preserved for
   free. So the way to "keep the formatting" is simply to update the specific
   cells that change and leave everything else alone.

## Commands

### Discover
- `sheets-info --sheet <ID>` — Structure of the whole spreadsheet: title, and for
  every tab its exact `title`, `rows`, `cols`, `lastColumn` letter, and any
  `frozenRows`. **Run this first** unless you already know the exact tab names.

### Read
- `sheets-get --sheet <ID> --tab "<Tab Name>" --range "A1:D10"` — Read a range.
  Output: JSON `{range, rows, values}` where `values` is an array of row arrays.
- `sheets-get --sheet <ID> --range "'Tab Name'!A1:D10"` — Equivalent, if you'd
  rather write the full A1 range yourself.

### Write (in place)
- `sheets-update --sheet <ID> --tab "<Tab Name>" --range "F5" --values '[["Done"]]'`
  — Overwrite one cell or a contiguous block. Formatting of those cells is kept.
- `sheets-batch-update --sheet <ID> --data '[{"range":"'"'"'Tab Name'"'"'!F5","values":[["Done"]]}, ...]'`
  — **Preferred for more than one change**: apply many scattered updates in ONE
  call. Ranges live in the request body, so no URL quirks. Also accepts
  `--data-file <path>` when the update set is large.

### Append
- `sheets-append --sheet <ID> --tab "<Tab Name>" --range "A:N" --values '[[...]]'`
  — Add new row(s) below the last filled row of the table in that column span.

Add `--raw` to a write to store text verbatim; omit it (default `USER_ENTERED`)
to let Sheets interpret dates, numbers, and formulas the way the UI would.

## A1 notation & tab names
- A range is `'<Tab Name>'!<span>`, e.g. `'Q3 Plan'!B2:B10`.
- A tab name with spaces, punctuation, or a `/` **must be wrapped in single
  quotes** inside the range. Prefer `--tab "<name>"` and let the tool quote it —
  pass the tab name exactly as `sheets-info` reported it.
- A `span` is a cell (`F5`), a block (`A1:D10`), a whole column (`F:F`), or a
  column span for append (`A:N`).
- Column letters past Z continue `AA, AB, …`; `sheets-info` gives you
  `lastColumn` so you never have to count.

## Procedures

### Understand an unfamiliar sheet
1. `sheets-info --sheet <ID>` → note each tab's exact name and its `rows`/`cols`.
2. Read the tab that holds the data: `sheets-get --sheet <ID> --tab "<name>"
   --range "A1:<lastColumn><rows-or-a-safe-cap>"`.
3. Identify the **header row** (often the first non-title row, or a frozen row)
   and which column holds each field. This mapping — "column F is Status" — is
   how you will locate cells to change. Note it before editing.
4. Verify: the values returned match the tab you intended and contain the
   header/labels you expect.

### Update existing records in place
1. Discover + read as above so you have the current values and the header map.
2. For each change, **locate the exact cell** by matching the row's key/label to
   the values you read (row index = its position in the sheet) and the field to
   its column letter. Example: the row whose key cell equals "Onboarding" is row
   9 and Status is column F, so the target is `F9`.
3. Apply the changes to those cells only:
   - one change → `sheets-update --tab … --range F9 --values '[["In progress"]]'`
   - several → one `sheets-batch-update` with a `{range,values}` entry per cell.
   Untouched cells (and all formatting) stay exactly as they were.
4. Verify: re-read the changed cells (`sheets-get`) and confirm the new values
   are present; confirm you did not overwrite neighbouring cells.

### Append new records
1. Discover + read the header row so your new row's cells line up with the
   existing columns (same order, same meaning).
2. `sheets-append --tab "<name>" --range "<A:lastColumn>" --values '[[...]]'` with
   the new row's cells in column order; leave a cell `""` where you have no value.
3. Verify: the response `updatedRange` sits directly below the previously last
   filled row, and the columns align with the header.

### Work within a template's intent
When a sheet is a structured template (a header block, one or more labelled
tables, status columns, etc.), respect its shape: put a value in the column that
already means that thing, match the vocabulary already used in that column
(e.g. reuse the exact status words already present rather than inventing new
ones), and add a new row rather than repurposing an unrelated one. Read enough of
the existing rows first to see the conventions before you write.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `400 ... Unable to parse range` | Tab name not quoted, or you guessed a tab that doesn't exist | Run `sheets-info` and use the exact tab name via `--tab`, or single-quote it in the range. |
| `400 ... exceeds grid limits. Max rows/columns` | Range goes past the tab's real size | Use the `rows`/`cols`/`lastColumn` from `sheets-info`; don't read/write past them. |
| `404 notFound` | Wrong spreadsheet ID | Confirm the ID (the string between `/d/` and `/edit` in the URL), or `drive-search` by name. |
| `{"status":"access_denied"}` | The agent's Workspace account can't open the sheet | Ask the user to share it with the agent email shown in the message (Editor, to write). |
| Change landed in the wrong row | Row index mis-counted from the read | Re-read the region, recount the row from row 1 (values are 1-indexed to the sheet), retry the single cell. |
| Formatting looks lost after a write | A whole block/table was overwritten instead of the specific cells | Update only the cells that change (`sheets-update`/`sheets-batch-update` on exact A1 targets); value writes never alter formatting, but replacing a large block can drop content in cells you didn't mean to set. |
| Append added a row inside the table | `--range` span didn't match the table's columns | Use the table's full column span (e.g. `A:N`); append inserts below the last filled row in that span. |
