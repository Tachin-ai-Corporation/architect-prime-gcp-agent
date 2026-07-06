# Skill: Google Docs

> [!IMPORTANT]
> **Execution Instructions**: All commands listed below are CLI scripts. You MUST execute them using the `run_command` tool. Do NOT try to invoke them as native functions or tools, and do NOT hallucinate their JSON responses. Run the command and wait for the actual output.

## When to Use
Use when creating formatted Google Docs from Markdown, performing surgical text/style edits, managing NamedRanges, exporting/importing `.docx` files, leaving feedback comments, or suggesting edits via tab suggestions on Google Docs.

---

## 1. Commands

### Read & Inspect
- `docs-cat <doc_id>` — Read a Google Doc's full plain text body.
- `docs-get --doc <doc_id>` — Structured read. Returns JSON containing document plain text, element start/end character indices mapping, named ranges, and style info. Uses `suggestionsViewMode=SUGGESTIONS_INLINE`.

### Lane A — Markdown Write-Surface
- `docs-create --title "TITLE" [--body "PLAIN_TEXT"] [--folder FOLDER_ID] [--from-markdown FILE_PATH]` — Create a new Doc. If `--from-markdown` is used, performs a `multipart/related` Drive upload to convert a Markdown file into a formatted Google Doc (name = `--title`, parent = `--folder`).
- `docs-replace-md --doc <doc_id> (--file FILE_PATH | --text "MARKDOWN")` — Replace a target Doc's body completely with formatted Markdown via temporary Doc multipart conversion and in-place structured elements copying.
- `docs-write --doc <doc_id> (--text "CONTENT" | --file FILE_PATH) [--append | --overwrite] [--markdown]` — Write text to document. If `--append` is specified, appends to the end; if `--overwrite` is specified, clears and overwrites. If `--markdown` is specified, parses and converts content as formatted Markdown instead of plain text. Note: Overwriting requires the explicit `--overwrite` flag.

### Lane B — Surgical Edits (Formatting-Preserving)
- `docs-find-replace --doc <doc_id> --find "OLD" --replace "NEW" [--match-case]` — Global find and replace all instances of a string.
- `docs-batch-replace --doc <doc_id> --file PAIRS_FILE.json` — Apply an array of `{find, replace}` pairs atomically in a single `replaceAllText` batchUpdate.
- `docs-anchor-insert --doc <doc_id> --anchor "phrase" --text "text" [--position before|after]` — Resolve a unique anchor phrase index and insert text immediately before or after it.
- `docs-style --doc <doc_id> (--anchor "phrase" | --start START_IDX --end END_IDX) --style "STYLE"` — Apply typography/headings/alignment/color to a unique anchor or range. Style can be comma-separated list of: `bold`, `italic`, `underline`, `strikethrough`, `align=CENTER|LEFT|RIGHT|JUSTIFIED`, `color=#RRGGBB`, `HEADING_1` to `HEADING_6`, `TITLE`, `SUBTITLE`, `NORMAL_TEXT`.
- `docs-insert-table --doc <doc_id> --anchor "phrase" --rows N --cols M` — Insert a table at a resolved anchor index.
- `docs-insert-image --doc <doc_id> --anchor "phrase" --url IMAGE_URL` — Insert inline image from public URL at a resolved anchor index (enforces PNG/JPEG/GIF format, <50MB, <25MP, URL <2KB).
- `docs-namedrange-create --doc <doc_id> --name "RANGE_NAME" (--anchor "phrase" | --start START_IDX --end END_IDX)` — Create a named range around a resolved anchor or character index range.
- `docs-namedrange-replace --doc <doc_id> --name "RANGE_NAME" --text "text"` — Replace named range text in-place without index tracking.

### Lane C — DOCX Round-Trip
- `docs-export-docx --doc <doc_id> --out OUTPUT_FILE.docx` — Export a Doc to local `.docx` format.
- `docs-import-docx --file FILE_PATH.docx --title "TITLE" [--folder FOLDER_ID]` — Import local `.docx` as a native Google Doc via Drive multipart conversion.

### Comments & Review Polyfills
- `docs-comments-list --doc <doc_id> [--include-resolved]` — List document-level comments.
- `docs-comments-add --doc <doc_id> --content "TEXT"` — Add a document-level comment.
- `docs-suggest --doc <doc_id> [--tab <tab_id>] --file <suggestions.json>` — Make batched suggestion edits in-place, highlighting changes in yellow.

---

## 2. Decision Framework

Map the task requirements to the correct lane and tools using the following matrix:

| Intent | Lane | Tools |
|---|---|---|
| "Create a doc / write a report / draft a brief" | A | `docs-create --from-markdown` |
| "Rewrite / regenerate this whole document" | A | `docs-replace-md` |
| "Add a section to the end" | A | `docs-write --markdown --append` |
| "Fix this typo / update this clause / change these values" | B | `docs-find-replace`, `docs-batch-replace` |
| "Insert a table / image / heading here" | B | `docs-insert-table`, `docs-insert-image`, `docs-style` |
| "This field updates every cycle (template/report)" | B | `docs-namedrange-create` → `docs-namedrange-replace` |
| "Apply our branded template / exact typography / complex tables" | C | `docs-export-docx` → OOXML tooling → `docs-import-docx` |
| "Produce tracked-changes / a redline I can accept-reject" | C | `docs-export-docx` → OOXML `w:ins`/`w:del` → `docs-import-docx` |
| "Suggest edits for human approval (lightweight)" | polyfill | `drive-copy` → `docs-suggest` × N → `drive-share` |
| "Leave feedback / flag an issue" | polyfill | `docs-comments-add` |

---

## 3. Procedures

### Create a Formatted Document (Lane A)
1. Write the content as a local Markdown file (e.g. `report.md`).
2. Run `docs-create --title "Q3 Summary" --from-markdown report.md --folder 1AbC_folder_id`.
3. Verify formatting structure by running `docs-get --doc 1AbC_doc_id` and reviewing text layout.

### Edit in Place preserving Formatting (Lane B)
1. Read the target document structure using `docs-get --doc 1AbC_doc_id`.
2. Locate a unique anchor phrase nearby the desired edit location.
3. Prepare a find-and-replace list or define the edit:
   - For simple inserts: run `docs-anchor-insert --doc 1AbC_doc_id --anchor "anchor phrase" --text "New info" --position after`.
   - For batch edits: create `pairs.json` and run `docs-batch-replace --doc 1AbC_doc_id --file pairs.json`.
4. Validate changes using `docs-get --doc 1AbC_doc_id`. Never delete and re-write the entire body for small localized changes.

### Templated/Recurring Updates (Named Ranges)
1. Locate or create a NamedRange on the target text using `docs-namedrange-create --doc 1AbC_doc_id --name "ReportDate" --anchor "January 1, 2026"`.
2. Update the field in subsequent runs using `docs-namedrange-replace --doc 1AbC_doc_id --name "ReportDate" --text "February 1, 2026"`. This preserves surrounding styles and formatting.

### High-Fidelity/Tracked-Changes (Lane C Round-Trip)
1. Export the Google Doc using `docs-export-docx --doc 1AbC_doc_id --out local.docx`.
2. Perform OOXML manipulations locally (e.g., adding `w:ins`/`w:del` tracked changes or templates via `docx-js`/Office scripts).
3. Import the updated document using `docs-import-docx --file local.docx --title "Q3 Redlines" --folder 1AbC_folder_id`.

### Suggest Edits via Copy-and-Suggest Polyfill
1. Run `drive-copy --file 1AbC_doc_id --title "Suggested Edits - Document Name"` to make a full copy of the original document. Wait for the new file ID.
2. Create `suggestions.json` and apply edits to the **copied** document using `docs-suggest --doc NEW_COPY_ID --file suggestions.json`. The edits will replace text and be highlighted in yellow.
3. Share the copied document with the original requester using `drive-share --file NEW_COPY_ID --to user:email@example.com --role writer`.
4. The human will review the copied document. They can use strikethrough to reject edits or manually merge the copied document back into their original document as they see fit.

---

## 4. Important Notes / Limitations

- **No Native Suggesting Mode**: The Google Docs API has no toggle for "Suggesting Mode". Use the Copy-and-Suggest polyfill or Lane C (OOXML redlines).
- **Comments are Unanchored**: Programmatically created comments appear in the Document Comments sidebar rather than being highlighted on specific text.
- **Markdown Image Limitation**: Google Drive's Markdown converter does **not** fetch and embed Markdown image syntax (`![caption](url)`). Use `docs-insert-image` (Lane B) to place images at resolved anchors.
- **Multipart Conversion Requirement**: All Markdown and DOCX conversions require `multipart/related` Drive upload type (`uploadType=multipart`), passing both metadata and body parts in a single request.
- **Named Ranges Fragmentation**: If a named range is edited by human collaborators, it can split. `docs-namedrange-replace` only replaces the first fragment; re-create the range if it fragments.
- **Image Constraints**: Public URL image insertions must strictly be under 50 MB, PNG/JPEG/GIF formats only, under 25 megapixels, and URL length under 2KB.

---

## 5. Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|---|---|---|
| `403 forbidden` / `401 unauthorized` | Lack of permissions | Check that the target Google Doc is shared with the agent's service account email address. |
| Converted document is unformatted / plain-text | Failed multipart upload conversion | Verify that the file upload was sent to `/upload/drive/v3/files?uploadType=multipart`, with metadata MIME type set to `application/vnd.google-apps.document`. |
| Anchor phrase matches zero or multiple | Anchor text is not unique | Read the text via `docs-get`, identify a more distinct unique anchor phrase, and retry. |
| Named range replacement has no effect | Named range name mismatch / split | Call `docs-get` to inspect namedRanges keys. If split, re-create the NamedRange. |
| Image insertion rejected | Image constraint violation | Verify image file format is PNG/JPEG/GIF, size < 50MB, dimensions < 25MP, and URL < 2KB. |
| Accidental overwrite error | Missing write mode | Make sure to specify `--append` or `--overwrite` when calling `docs-write`. |
