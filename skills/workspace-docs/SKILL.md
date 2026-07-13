# Skill: Google Docs (v7)

> [!IMPORTANT]
> **Execution Instructions**: All commands listed below are CLI scripts. You MUST execute them using the `run_command` tool. Do NOT try to invoke them as native functions or tools, and do NOT hallucinate their JSON responses. Run the command and wait for the actual output.

## When to Use
Use when creating formatted Google Docs from Markdown or HTML, performing surgical text/style edits, managing NamedRanges, exporting/importing `.docx` files, cloning templates, setting page formatting (margins, headers, footers), leaving feedback comments, or suggesting edits via tab suggestions on Google Docs.

---

## 1. Commands

### Read & Inspect
- `docs-cat <doc_id>` — Read a Google Doc's **plain text body** (includes table cell text), printed directly to stdout so you can pipe/grep it. Pass `--json` for the structured `{docId,title,text,chars}` wrapper. Flags for large docs:
  - `--meta` — title, total chars, and heading outline with char offsets (no body text). **Always run this first on unfamiliar docs.**
  - `--find "TEXT" [--context N]` — case-insensitive search; returns every match (max 20) with char offset and ±N chars of context (default 800).
  - `--offset N --limit M` — read a window of M chars starting at char N; response includes `next_offset` when more remains.
  - `--max-chars N` — cap a full read; adds `truncated: true` + `next_offset`.
- `docs-get --doc <doc_id>` — Structured read. Returns JSON containing document plain text, element start/end character indices mapping, named ranges, and style info. Uses `suggestionsViewMode=SUGGESTIONS_INLINE`.

> [!WARNING]
> **Tool output is capped (~8,000 chars per step).** A bare `docs-cat` on a large doc gets cut off mid-body and later sections silently vanish. For any doc you haven't measured: `docs-cat ID --meta` first, then read the sections you need with `--find` or `--offset/--limit` windows.

### Lane A — Markdown Write-Surface
- `docs-create --title "TITLE" [--body "PLAIN_TEXT"] [--folder FOLDER_ID] [--from-markdown FILE_PATH]` — Create a new Doc. If `--from-markdown` is used, performs a `multipart/related` Drive upload to convert a Markdown file into a formatted Google Doc (name = `--title`, parent = `--folder`).
- `docs-replace-md --doc <doc_id> (--file FILE_PATH | --text "MARKDOWN")` — Replace a target Doc's body completely with formatted Markdown via temporary Doc multipart conversion and in-place structured elements copying.
- `docs-write --doc <doc_id> (--text "CONTENT" | --file FILE_PATH) [--append | --overwrite] [--markdown]` — Write text to document. If `--append` is specified, appends to the end; if `--overwrite` is specified, clears and overwrites. If `--markdown` is specified, parses and converts content as formatted Markdown instead of plain text. Note: Overwriting requires the explicit `--overwrite` flag.

### Lane A+ — HTML Write-Surface (rich formatting)
- `docs-create --title "TITLE" --from-html FILE_PATH [--folder FOLDER_ID]` — Create a new Doc from an HTML file via `multipart/related` Drive upload with `Content-Type: text/html`. Google converts HTML to native Doc formatting: `<h1>` → Heading 1, `<table>` → native tables, inline CSS `color`/`font-family`/`font-size`/`background-color` → text/paragraph styles. **Use this lane when you need colors, custom fonts, styled tables, or any formatting Markdown cannot express.**

### Lane B — Surgical Edits (Formatting-Preserving)
- `docs-find-replace --doc <doc_id> --find "OLD" --replace "NEW" [--match-case]` — Global find and replace all instances of a string.
- `docs-batch-replace --doc <doc_id> --file PAIRS_FILE.json` — Apply an array of `{find, replace}` pairs atomically in a single `replaceAllText` batchUpdate.
- `docs-anchor-insert --doc <doc_id> --anchor "phrase" --text "text" [--position before|after]` — Resolve a unique anchor phrase index and insert text immediately before or after it.
- `docs-section-delete --doc <doc_id> (--from-anchor "phrase" [--keep-anchor] | --start N --end N)` — Delete a contiguous region: from a unique anchor phrase to the **end of the document** (default), everything **after** the anchor (`--keep-anchor`), or an explicit character-index range. This is the tool for stripping a trailing section (e.g. a review/redline block) that `docs-find-replace` can't target and that rebuilding the whole body would risk. Anchor matching spans table and TOC text.
- `docs-style --doc <doc_id> (--anchor "phrase" | --start START_IDX --end END_IDX) --style "STYLE"` — Apply typography/headings/alignment/color to a unique anchor or range. Style can be comma-separated list of: `bold`, `italic`, `underline`, `strikethrough`, `align=CENTER|LEFT|RIGHT|JUSTIFIED`, `color=#RRGGBB`, `HEADING_1` to `HEADING_6`, `TITLE`, `SUBTITLE`, `NORMAL_TEXT`.
- `docs-insert-table --doc <doc_id> --anchor "phrase" --rows N --cols M` — Insert a table at a resolved anchor index.
- `docs-insert-image --doc <doc_id> --anchor "phrase" --url IMAGE_URL` — Insert inline image from public URL at a resolved anchor index (enforces PNG/JPEG/GIF format, <50MB, <25MP, URL <2KB).
- `docs-namedrange-create --doc <doc_id> --name "RANGE_NAME" (--anchor "phrase" | --start START_IDX --end END_IDX)` — Create a named range around a resolved anchor or character index range.
- `docs-namedrange-replace --doc <doc_id> --name "RANGE_NAME" --text "text"` — Replace named range text in-place without index tracking.

### Lane C — DOCX Round-Trip
- `docs-export-docx --doc <doc_id> --out OUTPUT_FILE.docx` — Export a Doc to local `.docx` format.
- `docs-import-docx --file FILE_PATH.docx --title "TITLE" [--folder FOLDER_ID]` — Import local `.docx` as a native Google Doc via Drive multipart conversion.

### Lane D — Templates
- `docs-clone-template --template DOC_ID --title "TITLE" [--folder FOLDER_ID] [--replacements FILE]` — Clone a template Doc via Drive `files.copy`, optionally filling `{{placeholder}}` tags from a JSON replacements file `[{"find":"{{client}}","replace":"Acme Corp"},...]`.

### Page Formatting
- `docs-format-page --doc <doc_id> [--margins "1in"] [--header "text"] [--footer "text"] [--page-numbers] [--orientation portrait|landscape]` — Set document-level page formatting: margins (inches/cm/pt), header text, footer text, page numbers, page orientation. Apply after creating content to add professional page chrome.

### Comments & Review Polyfills
- `docs-comments-list --doc <doc_id> [--include-resolved]` — List document-level comments.
- `docs-comments-add --doc <doc_id> --content "TEXT"` — Add a document-level comment.
- `docs-tab-list <doc_id>` — List tabs with IDs, titles, and hierarchy.
- `docs-tab-clone --doc <doc_id> --source-tab <tab_id> [--title "TITLE"]` — Clone a tab's text content into a suggestion tab (highlights suggestion yellow).
- `docs-tab-suggest --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id> --file <suggestions.json>` — Make batched suggestion edits in the cloned tab.
- `docs-tab-finalize --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id> --file <suggestions.json>` — Apply suggestions to original tab (excluding struck-through text) and clean up.

---

## 2. Decision Framework

| Intent | Lane | Tools |
|---|---|---|
| "Create a doc with custom fonts, colors, or styled tables" | A+ | Write HTML with inline CSS → `docs-create --from-html` |
| "Create a doc / write a report / draft a brief" | A | `docs-create --from-markdown` |
| "Rewrite / regenerate this whole document" | A/A+ | `docs-replace-md` or recreate via `--from-html` |
| "Add a section to the end" | A | `docs-write --markdown --append` |
| "Create a document from our standard template" | D | `docs-clone-template --template ID --replacements file` |
| "Fix this typo / update this clause / change these values" | B | `docs-find-replace`, `docs-batch-replace` |
| "Delete this section / strip the review notes at the end / remove everything after X" | B | `docs-section-delete --from-anchor` |
| "Finalize this redlined doc: apply the notes, then remove the notes section" | B | `docs-find-replace`/`docs-batch-replace` to apply, then `docs-section-delete --from-anchor` to strip |
| "Insert a table / image / heading here" | B | `docs-insert-table`, `docs-insert-image`, `docs-style` |
| "This field updates every cycle (template/report)" | B | `docs-namedrange-create` → `docs-namedrange-replace` |
| "Apply our branded template / exact typography / complex tables" | C | `docs-export-docx` → OOXML tooling → `docs-import-docx` |
| "Produce tracked-changes / a redline I can accept-reject" | C | `docs-export-docx` → OOXML `w:ins`/`w:del` → `docs-import-docx` |
| "Add margins, headers, footers, or page numbers" | — | `docs-format-page` (use after any lane's creation step) |
| "Suggest edits for human approval (lightweight)" | polyfill | `docs-tab-clone` → `docs-tab-suggest` × N → human reviews → `docs-tab-finalize` |
| "Leave feedback / flag an issue" | polyfill | `docs-comments-add` |

**Default lane selection:** If the document needs any visual styling beyond what Markdown supports (custom colors, branded fonts, table borders, colored headings), use Lane A+ (HTML). Otherwise, Lane A (Markdown) is simpler. For recurring documents with fixed layouts, use Lane D (Templates).

---

## 3. Procedures

### Create a Professional Document (Lane A+ — recommended for styled output)
1. Write content as an HTML file with inline CSS styles following the Design System (Section 6):
   ```bash
   cat > report.html << 'HTMLEOF'
   <h1 style="color:#1a1a2e; font-size:24pt;">Quarterly Report</h1>
   <p style="color:#636e72; font-size:11pt; line-height:1.4;">Executive summary text...</p>
   <h2 style="color:#2d3436; font-size:16pt;">Key Metrics</h2>
   <table style="width:100%; border-collapse:collapse;">
     <tr style="background-color:#f5f5f5;">
       <th style="padding:6px 10px; border:1px solid #ddd; text-align:left; font-size:10pt;">Metric</th>
       <th style="padding:6px 10px; border:1px solid #ddd; text-align:right; font-size:10pt;">Value</th>
     </tr>
     <tr>
       <td style="padding:6px 10px; border:1px solid #ddd; font-size:10pt;">Revenue</td>
       <td style="padding:6px 10px; border:1px solid #ddd; text-align:right; font-size:10pt;">$1.48M</td>
     </tr>
   </table>
   HTMLEOF
   ```
2. Create: `docs-create --title "Q3 Report" --from-html report.html --folder FOLDER_ID`
3. Add page chrome: `docs-format-page --doc DOC_ID --margins "1in" --header "Company — Confidential" --footer "Prepared October 2026"`
4. Verify: `docs-get --doc DOC_ID` — confirm headings are styled, table has correct columns, header/footer present.

### Create a Formatted Document (Lane A — Markdown)
1. Write the content as a local Markdown file (e.g. `report.md`).
2. Run `docs-create --title "Q3 Summary" --from-markdown report.md --folder FOLDER_ID`.
3. Verify formatting structure by running `docs-get --doc DOC_ID` and reviewing text layout.

### Create from Template (Lane D)
1. Identify the template doc ID (ask the project context or Drive search). Templates should have `{{placeholder}}` tags where dynamic content goes.
2. Create a replacements file:
   ```json
   [
     {"find": "{{client_name}}", "replace": "Acme Corp"},
     {"find": "{{report_date}}", "replace": "July 2026"},
     {"find": "{{prepared_by}}", "replace": "Design Team"}
   ]
   ```
3. Clone and fill: `docs-clone-template --template TEMPLATE_DOC_ID --title "Acme Corp Report" --folder FOLDER_ID --replacements replacements.json`
4. Verify: `docs-cat NEW_DOC_ID` — confirm all `{{` placeholders resolved.

### Reading Large Documents (paginated reads)
1. Measure first: `docs-cat DOC_ID --meta` — returns total `chars` and the heading `outline` with char offsets.
2. If the doc is under ~6,000 chars, a plain `docs-cat DOC_ID` is fine.
3. To read a specific section, search for its heading: `docs-cat DOC_ID --find "LEGAL REVIEW REDLINES" --context 3000` — returns the section content around the match.
4. To read sequentially, window through it: `docs-cat DOC_ID --offset 0 --limit 6000`, then continue from the returned `next_offset` until `truncated` is absent.
5. Never treat a single full read of a large doc as complete — if `chars` exceeds what you received, the tail is missing.

### Finalize a Redlined Document (apply notes, then strip the notes section)
A common request: a doc has review/redline notes appended at the end; incorporate them into the body, then remove the notes so the doc is clean.
1. `docs-cat DOC_ID --meta` — locate the notes section heading and its char offset (e.g. `[LEGAL REVIEW REDLINES]`).
2. `docs-cat DOC_ID --find "LEGAL REVIEW REDLINES" --context 3000` — read the notes so you know exactly what changes they call for.
3. Apply each change to the body with `docs-find-replace` (one clause at a time) or `docs-batch-replace` (a `{find,replace}` pairs file) — surgical, formatting-preserving.
4. Strip the notes: `docs-section-delete --doc DOC_ID --from-anchor "[LEGAL REVIEW REDLINES]"` — deletes the heading and everything after it. The document is now a clean final version.
5. Verify: `docs-cat DOC_ID --meta` — confirm the notes heading is gone and the body carries the applied changes.

Do NOT try to reconstruct the whole body from `docs-cat` text and re-`--overwrite` it — that loses formatting and is exactly what failed before `docs-section-delete` existed.

### Edit in Place Preserving Formatting (Lane B)
1. Read the target document structure using `docs-get --doc DOC_ID`.
2. Locate a unique anchor phrase nearby the desired edit location.
3. Prepare a find-and-replace list or define the edit:
   - For simple inserts: run `docs-anchor-insert --doc DOC_ID --anchor "anchor phrase" --text "New info" --position after`.
   - For batch edits: create `pairs.json` and run `docs-batch-replace --doc DOC_ID --file pairs.json`.
4. Validate changes using `docs-get --doc DOC_ID`. Never delete and re-write the entire body for small localized changes.

### Templated/Recurring Updates (Named Ranges)
1. Locate or create a NamedRange on the target text using `docs-namedrange-create --doc DOC_ID --name "ReportDate" --anchor "January 1, 2026"`.
2. Update the field in subsequent runs using `docs-namedrange-replace --doc DOC_ID --name "ReportDate" --text "February 1, 2026"`. This preserves surrounding styles and formatting.

### High-Fidelity/Tracked-Changes (Lane C Round-Trip)
1. Export the Google Doc using `docs-export-docx --doc DOC_ID --out local.docx`.
2. Perform OOXML manipulations locally (e.g., adding `w:ins`/`w:del` tracked changes or templates via `docx-js`/Office scripts).
3. Import the updated document using `docs-import-docx --file local.docx --title "Q3 Redlines" --folder FOLDER_ID`.

### Suggest Edits via Tab Review Polyfill
1. Run `docs-tab-list DOC_ID` to get target tab ID.
2. Run `docs-tab-clone --doc DOC_ID --source-tab t.0` to create suggestion tab.
3. Create `suggestions.json` and apply edits using `docs-tab-suggest --doc DOC_ID --source-tab t.0 --suggestion-tab t.new --file suggestions.json`.
4. Leave review comment: `docs-comments-add --doc DOC_ID --content "📋 I've added suggestions in the review tab. Review and reply here when finished."`
5. On human confirmation: run `docs-tab-finalize --doc DOC_ID --source-tab t.0 --suggestion-tab t.new --file suggestions.json` to apply approved changes.

---

## 4. Important Notes / Limitations

- **No Native Suggesting Mode**: The Google Docs API has no toggle for "Suggesting Mode". Use the Tab Suggestion polyfill or Lane C (OOXML redlines).
- **Comments are Unanchored**: Programmatically created comments appear in the Document Comments sidebar rather than being highlighted on specific text.
- **Markdown Image Limitation**: Google Drive's Markdown converter does **not** fetch and embed Markdown image syntax (`![caption](url)`). Use `docs-insert-image` (Lane B) to place images at resolved anchors after creation.
- **Markdown Formatting Limits**: Markdown conversion cannot produce custom colors, custom fonts, table borders, background shading, or fine-grained spacing. For these, use Lane A+ (HTML) instead.
- **Markdown Code Blocks**: Converted as indented plain text, not monospace-styled blocks. Apply monospace font via `docs-style` post-creation if needed.
- **Markdown Complex Tables**: Merged cells, column spans, and nested tables may not render. Use Lane B `docs-insert-table` for complex layouts.
- **HTML CSS Limits**: Inline CSS is supported for colors, fonts, sizes, padding, borders, alignment. CSS flexbox, grid, and class-based selectors are stripped during conversion. Use only inline `style=""` attributes.
- **Multipart Conversion Requirement**: All Markdown, HTML, and DOCX conversions require `multipart/related` Drive upload type (`uploadType=multipart`), passing both metadata and body parts in a single request.
- **Named Ranges Fragmentation**: If a named range is edited by human collaborators, it can split. `docs-namedrange-replace` only replaces the first fragment; re-create the range if it fragments.
- **Image Constraints**: Public URL image insertions must strictly be under 50 MB, PNG/JPEG/GIF formats only, under 25 megapixels, and URL length under 2KB.
- **Headers/Footers via Conversion**: Neither Markdown nor HTML conversion includes headers, footers, or page numbers. Always apply these with `docs-format-page` as a post-creation step.

---

## 5. Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|---|---|---|
| `403 forbidden` / `401 unauthorized` | Lack of permissions | Check that the target Google Doc is shared with the agent's service account email address. |
| Doc text cut off mid-body / a known section is missing from output | Doc larger than the per-step output cap | `docs-cat ID --meta` for total chars + outline, then `--find "section heading" --context 3000` or `--offset/--limit` windows to read the missing part. |
| `--find` returns 0 matches for text visible in the doc | Text lives in a suggestion, header/footer, or differs in whitespace | Try a shorter, distinctive substring of the phrase; check `docs-get` for suggestions view. Table cell text IS searchable. |
| Converted document is unformatted / plain-text | Failed multipart upload conversion | Verify that the file upload was sent to `/upload/drive/v3/files?uploadType=multipart`, with metadata MIME type set to `application/vnd.google-apps.document`. |
| HTML styles not applied | CSS syntax error or unsupported property | Use only inline `style=""` attributes. Verify no typos in hex colors. Avoid class selectors, flexbox, grid. |
| Headings render as bold plain text | Used `<b>` instead of `<h1>`-`<h6>` | Google maps `<h1>` to Heading 1 etc. Manual bold is not a heading. Use heading tags. |
| Table has no borders in final doc | Missing inline border CSS | Add `border: 1px solid #ddd` to both `<table>` and `<td>`/`<th>` elements. Set `border-collapse: collapse` on the `<table>`. |
| Anchor phrase matches zero or multiple | Anchor text is not unique | Read the text via `docs-get`, identify a more distinct unique anchor phrase, and retry. |
| Named range replacement has no effect | Named range name mismatch / split | Call `docs-get` to inspect namedRanges keys. If split, re-create the NamedRange. |
| Image insertion rejected | Image constraint violation | Verify image file format is PNG/JPEG/GIF, size < 50MB, dimensions < 25MP, and URL < 2KB. |
| Accidental overwrite error | Missing write mode | Make sure to specify `--append` or `--overwrite` when calling `docs-write`. |
| Template clone returns 404 | Template doc deleted or not shared | Verify template doc exists and is shared with agent email. |
| Page format has no effect | Empty or malformed margin value | Use format: `"1in"`, `"2.54cm"`, or `"72pt"`. Bare numbers default to inches. |

---

## 6. Document Design System

When creating documents, apply these design tokens for professional output.
Agents should use these values in HTML inline styles (Lane A+) or `docs-style`
calls (Lane B). These are defaults; override with project brand guidelines when
available in project context.

### Typography
| Element | Size | Weight | Color | Spacing |
|---|---|---|---|---|
| Title | 24pt | bold | `#1a1a2e` | 24pt space after |
| Heading 1 | 18pt | bold | `#2d3436` | 16pt above, 8pt below |
| Heading 2 | 14pt | bold | `#636e72` | 12pt above, 6pt below |
| Heading 3 | 12pt | bold | `#636e72` | 10pt above, 4pt below |
| Body | 11pt | normal | `#2d3436` | 1.15 line spacing, 6pt after |
| Caption | 9pt | italic | `#636e72` | 4pt after |

### Page Layout
| Property | Default |
|---|---|
| Margins | 1 inch (all sides) |
| Page size | US Letter (8.5 × 11 in) |
| Orientation | Portrait |
| Header | 9pt, gray (#666), company name or doc type |
| Footer | 9pt, gray (#666), date or confidentiality + page number |

### Tables
| Property | Value |
|---|---|
| Header row background | `#f5f5f5` |
| Header row text | bold, 10pt |
| Data row text | 10pt, normal |
| Cell padding | 6px vertical, 10px horizontal |
| Borders | 1px solid `#dddddd` |
| Alternating rows | Optional: `#fafafa` on even rows for large tables |

### Color Palette
| Role | Hex | Usage |
|---|---|---|
| Primary | `#1a1a2e` | Titles, key emphasis |
| Secondary | `#636e72` | Subheadings, captions, metadata |
| Body text | `#2d3436` | All body copy |
| Accent | `#0984e3` | Links, callout borders, highlights |
| Table header bg | `#f5f5f5` | Table header row shading |
| Table border | `#dddddd` | All table borders |
| Success | `#00b894` | Status indicators, positive metrics |
| Warning | `#fdcb6e` | Caution indicators |
| Error | `#d63031` | Error indicators, negative metrics |

### Professional Document Checklist
Before marking any document-creation task as complete:
- Title or header section is present and styled
- Heading hierarchy is consistent (no skipped levels)
- Body text is 11pt in a readable font
- Tables have styled header rows distinct from data rows
- Page margins are set (not default narrow)
- Headers and/or footers applied if the doc is more than 1 page
- Links use accent color and are consistently styled
- No raw Markdown syntax visible in the final doc
