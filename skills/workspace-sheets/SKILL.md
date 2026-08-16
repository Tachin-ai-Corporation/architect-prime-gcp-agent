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

### Create
- `sheets-create --title "<Name>" [--tab "<First tab>"] [--folder <FOLDER_ID>]` —
  Make a new spreadsheet. Prints `spreadsheetId` and `url`.
  - **Idempotent**: a spreadsheet of that name (in that folder, if given) is
    returned as `status: exists` rather than duplicated, so a re-planned step
    that runs twice leaves one file, not two.
  - Without `--folder` it lands in My Drive root. With one, it is created and
    then moved; if the move fails the spreadsheet still exists and the output
    says where it actually is.
  - `--name` works as an alias for `--title`.
  - It creates an EMPTY sheet. Put the header row in with `sheets-update`
    (see *Start a new tracker from nothing* below).

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
- `sheets-batch-update --sheet <ID> --tab "<Tab Name>" --data '[{"range":"F26","values":[["Done"]]},{"range":"F5","values":[["Yellow"]]}]'`
  — **Preferred for more than one change**: apply many scattered updates in ONE
  call. With `--tab`, the ranges are **bare spans** (`F26`, not `'Tab'!F26`) and the
  tool prepends the tab — so `--data` contains only double quotes and survives the
  shell. **Never embed a single-quoted tab name inside `--data`** (e.g.
  `'Tab'!F26`): those inner single quotes cannot be escaped on the command line and
  the call fails before it runs. For updates across MULTIPLE tabs, omit `--tab`,
  give full ranges, and pass `--data-file <path>` to sidestep the quoting.

### Add a row
- `sheets-insert-row --sheet <ID> --tab "<Tab Name>" --before-row N [--count 1]`
  — Insert blank row(s) above row N, shifting everything below DOWN so nothing is
  overwritten. New rows inherit the formatting of the row above. Then fill row N
  with `sheets-update`/`sheets-batch-update`. This is the safe way to add a row to
  a table that has other content beneath it.
- `sheets-append --sheet <ID> --tab "<Tab Name>" --range "A:N" --values '[[...]]'`
  — Add row(s) after the last filled row **in that column span**. Only safe when
  the tab is a single flat list — if any other block shares those columns lower
  down (a second table, a totals row), append lands after *that*, not after your
  table. When unsure, insert instead.

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

## Locating the right cell
- The **column** for a field is the one whose header-row cell holds that field's
  name. Find that column letter, and write to it — do not eyeball a neighbour. If
  "Status" is the 6th column, its letter is F; write to `F<row>`, not `E<row>`.
- The **row** is a record's position counted from row 1 (the values you read are
  1-indexed to the sheet). Match the record by a stable key cell (its name/id),
  not by guessing an offset.
- Use the spreadsheet **ID exactly as given** — copy it, never retype it; a single
  wrong character is a different (or missing) spreadsheet.
- After writing, the verify read is what catches an off-by-one column or row —
  always do it (see procedures).

## Procedures

### Start a new tracker from nothing
When the request is "make me a sheet that tracks X" and no spreadsheet exists yet.
1. `sheets-create --title "<Name>"` → note `spreadsheetId` and `url` from the output.
   If it returns `status: exists`, that IS your sheet — do not create another.
2. Write the header row: `sheets-update --sheet <ID> --range "A1:D1" --values
   '[["Task","Owner","Due","Status"]]'`.
3. Add the data rows with `sheets-append` (see *Add a new record to a table*).
4. **Verify by reading it back**: `sheets-get --sheet <ID> --range "A1:D50"` and
   count the rows returned. Report the `url` and the count you actually read —
   not the count you intended to write.

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
   - one change → `sheets-update --tab "<name>" --range F9 --values '[["In progress"]]'`
   - several → one `sheets-batch-update --tab "<name>" --data '[{"range":"F9","values":[["In progress"]]}, …]'`
     (bare spans in the ranges; the tool adds the tab — keeps `--data` quote-safe).
   Untouched cells (and all formatting) stay exactly as they were.
4. Verify: re-read the changed cells (`sheets-get`) and confirm the new values
   are present; confirm you did not overwrite neighbouring cells.

### Add a new record to a table
0. **Idempotency first (C-18): a write must be safe to re-run.** In-place value
   updates already are (setting a cell to the same value twice is a no-op). Adding
   a row is NOT — a naive re-run inserts a duplicate. So before you add, scan the
   table you just read for a row whose identifying field (its name/description/key)
   already matches the record you are about to add. If one exists, a previous
   attempt already added it — update that row in place if needed and STOP; do not
   insert a second copy.
1. Discover + read so you know the header row, which column holds each field, and
   **where the table ends** — the first empty row after its data, and whether more
   content (another table, notes, totals) sits below that.
2. Choose the landing row:
   - If one or more empty rows immediately follow the table and nothing below
     needs to stay put → fill the first empty row with `sheets-update`.
   - If the table butts directly against other content, or you must keep that
     content in place → `sheets-insert-row --before-row <first row after the
     table>` (optionally `--count`), then fill the new blank row.
   - Only use `sheets-append` when the tab is a single flat list with nothing
     below the table in those columns.
3. Write the new row's cells in column order (matching the header), leaving `""`
   where you have no value, and reuse the vocabulary the column already uses
   (e.g. the exact status wording seen in other rows).
4. Verify: read the new row back and confirm each value sits under the correct
   header, and that the row below it is the content you expected (you did not
   overwrite an existing row).

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
