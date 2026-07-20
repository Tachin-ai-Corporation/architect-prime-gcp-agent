# Skill: Google Docs (v14)

> [!IMPORTANT]
> **Execution Instructions**: All commands listed below are CLI scripts. You MUST execute them using the `run_command` tool. Do NOT try to invoke them as native functions or tools, and do NOT hallucinate their JSON responses. Run the command and wait for the actual output.

## When to Use
Use when creating formatted Google Docs from Markdown or HTML, performing surgical text/style edits, managing NamedRanges, exporting/importing `.docx` files, cloning templates, setting page formatting (margins, headers, footers), leaving feedback comments (add/list/resolve/delete), or suggesting in-place edits for human review on Google Docs.

---

## 1. Commands

### Read & Inspect
- `docs-cat <doc_id>` — Read a Google Doc's **plain text body** (includes table cell text), printed directly to stdout so you can pipe/grep it. Pass `--json` for the structured `{docId,title,text,chars}` wrapper. Flags for large docs:
  - `--meta` — title, total chars, and heading outline with char offsets (no body text). **Always run this first on unfamiliar docs.**
  - `--out FILE` — write the **complete** document text to FILE in ONE call (immune to the output cap) and return `{written, chars}`. **The way to read a whole large doc**: `docs-cat ID --out doc.txt`, check `chars` matches `--meta`, then `grep -n` / `sed -n 'A,Bp'` the local file. Never paginate a full read through your own context, and never repeat a bare `docs-cat` hoping for more output — its return is capped every time.
  - `--find "TEXT" [--context N]` — case-insensitive search; returns every match (max 20) with char offset and ±N chars of context (default 800).
  - `--offset N --limit M` — read a window of M chars starting at char N; response includes `next_offset` when more remains.
  - `--max-chars N` — cap a full read; adds `truncated: true` + `next_offset`.
- `docs-get --doc <doc_id> [--tab <tab>]` — Structured read (per-tab; defaults to the first tab, paginated for large docs). Returns JSON containing the document plain text plus a compact per-textRun index map — segments `[{startIndex,endIndex,text}]` carrying the **raw Docs API indices** — named ranges, and style info. Uses `suggestionsViewMode=SUGGESTIONS_INLINE`. This is the only valid source of the API indices that `--start/--end` flags consume.
- `docs-revision <doc_id>` — Record the current head revision as a **pre-edit restore point** (returns `{revisionId, modifiedTime}` + a restore hint); `--list` shows recent revisions with authors. Google Docs keeps full native version history, so this is how you make a live edit reversible without copying the doc. **Run this before any destructive live edit** (see §3 Safe Live-Edit Protocol).

> [!WARNING]
> **Tool output is capped (~8,000 chars per step).** A bare `docs-cat` on a large doc gets cut off mid-body and later sections silently vanish. For any doc you haven't measured: `docs-cat ID --meta` first, then read the sections you need with `--find` or `--offset/--limit` windows.

### Lane A — Markdown Write-Surface
- `docs-create --title "TITLE" [--body "PLAIN_TEXT"] [--folder FOLDER_ID] [--from-markdown FILE_PATH]` — Create a new Doc. If `--from-markdown` is used, performs a `multipart/related` Drive upload to convert a Markdown file into a formatted Google Doc (name = `--title`, parent = `--folder`).
- `docs-replace-md --doc <doc_id> (--file FILE_PATH | --text "MARKDOWN")` — Replace a target Doc's body completely with formatted Markdown via temporary Doc multipart conversion and in-place structured elements copying.
- `docs-write --doc <doc_id> (--text "CONTENT" | --file FILE_PATH) [--append | --overwrite] [--markdown]` — Write text to document. If `--append` is specified, appends to the end; if `--overwrite` is specified, clears and overwrites. If `--markdown` is specified, parses and converts content as formatted Markdown instead of plain text. Note: Overwriting requires the explicit `--overwrite` flag.

### Lane A+ — HTML Write-Surface (rich formatting)
- `docs-create --title "TITLE" --from-html FILE_PATH [--folder FOLDER_ID]` — Create a new Doc from an HTML file via `multipart/related` Drive upload with `Content-Type: text/html`. Google converts HTML to native Doc formatting: `<h1>` → Heading 1, `<table>` → native tables, inline CSS `color`/`font-family`/`font-size`/`background-color` → text/paragraph styles. **Use this lane when you need colors, custom fonts, styled tables, or any formatting Markdown cannot express.**

### Lane B — Surgical Edits (Formatting-Preserving)

> [!WARNING]
> **Two different index models — never mix them.** `docs-cat` (`--meta`/`--find`/`--offset`) emits **plain-text** character offsets. The `--start`/`--end` flags on `docs-section-delete`, `docs-style`, and `docs-namedrange-create` require **raw Docs API indices**, which come **only from `docs-get`** (its per-textRun segment map). On any doc containing tables or images the two diverge, and feeding a `docs-cat` offset into a `--start/--end` range corrupts the wrong region. Prefer `--anchor` (unambiguous) over raw indices; when you must use indices, source them from `docs-get`.

- `docs-find-replace --doc <doc_id> --find "OLD" --replace "NEW" [--match-case]` — Global find and replace all instances of a string.
- `docs-batch-replace --doc <doc_id> --file PAIRS_FILE.json` — Apply an array of `{find, replace}` pairs atomically in a single `replaceAllText` batchUpdate.
- `docs-anchor-insert --doc <doc_id> --anchor "phrase" --text "text" [--position before|after]` — Resolve a unique anchor phrase index and insert text immediately before or after it.
- `docs-section-delete --doc <doc_id> (--from-anchor "phrase" [--keep-anchor] | --start N --end N)` — Delete a contiguous region: from a unique anchor phrase to the **end of the document** (default), everything **after** the anchor (`--keep-anchor`), or an explicit character-index range. This is the tool for stripping a trailing section (e.g. a review/redline block) that `docs-find-replace` can't target and that rebuilding the whole body would risk. Anchor matching spans table and TOC text.
- `docs-style --doc <doc_id> (--anchor "phrase" | --start START_IDX --end END_IDX) --style "STYLE"` — Apply typography/headings/alignment/color to a unique anchor or range. Style can be comma-separated list of: `bold`, `italic`, `underline`, `strikethrough`, `align=START|CENTER|END|JUSTIFIED` (`LEFT`/`RIGHT` are accepted as aliases for `START`/`END`), `color=#RRGGBB`, `HEADING_1` to `HEADING_6`, `TITLE`, `SUBTITLE`, `NORMAL_TEXT`.
- `docs-insert-table --doc <doc_id> --anchor "phrase" --rows N --cols M` — Insert a table at a resolved anchor index.
- `docs-insert-image --doc <doc_id> --anchor "phrase" --url IMAGE_URL` — Insert inline image from public URL at a resolved anchor index (PNG/JPEG/GIF format, <50MB, and URL <2KB are checked locally; the megapixel limit is enforced server-side by Google, not client-side).
- `docs-namedrange-create --doc <doc_id> --name "RANGE_NAME" (--anchor "phrase" | --start START_IDX --end END_IDX)` — Create a named range around a resolved anchor or character index range.
- `docs-namedrange-replace --doc <doc_id> --name "RANGE_NAME" --text "text"` — Replace named range text in-place without index tracking.

### Lane C — DOCX Round-Trip
- `docs-export-docx --doc <doc_id> --out OUTPUT_FILE.docx` — Export a Doc to local `.docx` format.
- `docs-import-docx --file FILE_PATH.docx --title "TITLE" [--folder FOLDER_ID]` — Import local `.docx` as a **new** native Google Doc via Drive multipart conversion.
- `docs-replace-file --doc <doc_id> --file EDITED.docx` — Replace an **existing** doc's entire content in place from a local file (`.docx`/`.html`/`.md`/`.txt`) in **one atomic call**. Preserves the doc id and adds a revision, so version history stays intact. This is the "edit locally, apply all at once" path — plan a batch of edits on a local copy, then push the result back once, instead of many inline mutations to the live doc. (`docs-import-docx` makes a new doc; `docs-replace-file` updates the one you already have.)

### Lane D — Templates
- `docs-clone-template --template DOC_ID --title "TITLE" [--folder FOLDER_ID] [--replacements FILE]` — Clone a template Doc via Drive `files.copy`, optionally filling `{{placeholder}}` tags from a JSON replacements file `[{"find":"{{client}}","replace":"Acme Corp"},...]`.

### Page Formatting
- `docs-format-page --doc <doc_id> [--margins "1in"] [--header "text"] [--footer "text"] [--orientation portrait|landscape]` — Set document-level page formatting: margins (inches/cm/pt), header text, footer text, page orientation. Apply after creating content to add professional page chrome. Automatic page numbers are unsupported (Docs API v1 has no page-number request) — use the Lane C DOCX round-trip if you need them.

### Comments & Review
- `docs-comments-list --doc <doc_id> [--include-resolved]` — List document-level comments.
- `docs-comments-add --doc <doc_id> --content "TEXT" [--quote "exact text this is about"]` — Add a comment. Comments are document-level (the Drive API can't reliably pin one to a live text range in the Docs editor), so **always pass `--quote` with the exact clause/phrase the comment refers to** — it attaches that text to the comment so the reader sees *what* you're commenting on instead of a floating, context-free note. This is how you give per-clause review feedback (see the "Review a document clause-by-clause" procedure).
- `docs-comments-resolve --doc <doc_id> --comment-id <cid> [--content "note"]` — Resolve/close a review comment thread (Drive reply with `action=resolve`).
- `docs-comments-delete --doc <doc_id> --comment-id <cid>` — Permanently remove a comment (no undo).
- `docs-tab-list <doc_id>` — List tabs with IDs, titles, and hierarchy.

### Suggest & Review
- `docs-suggest --doc <doc_id> [--tab <tab>] (--find "OLD" --replace "NEW" [--reason "..."] | --file suggestions.json)` — In-place suggestion polyfill: replaces each matched string and highlights the new text yellow, descending-sorted in one atomic batchUpdate. **Destructive** — it deletes and re-inserts, so the original text survives only in the doc's version history. Leave a `docs-comments-add` note for the human, then close the thread with `docs-comments-resolve` once the edit is accepted.

---

## 2. Decision Framework

| Intent | Lane | Tools |
|---|---|---|
| "Create a doc with custom fonts, colors, or styled tables" | A+ | Write HTML with inline CSS → `docs-create --from-html` |
| "Create a doc / write a report / draft a brief" | A | `docs-create --from-markdown` |
| "Rewrite / regenerate this whole document" | A/A+ | `docs-replace-md` or recreate via `--from-html` |
| "Apply many edits / restructure an EXISTING doc (finalize a contract, batch of redlines)" | C | Edit locally, apply once: `docs-export-docx` → edit the `.docx` (python-docx) → `docs-replace-file`. **See §3 "Heavy or structural edits".** Avoids inline churn on the live doc. |
| "Add a section to the end" | A | `docs-write --markdown --append` |
| "Create a document from our standard template" | D | `docs-clone-template --template ID --replacements file` |
| "Fix this typo / update this clause / change these values" | B | `docs-find-replace`, `docs-batch-replace` |
| "Delete this section / strip the review notes at the end / remove everything after X" | B | `docs-section-delete --from-anchor` |
| "Safely edit / finalize a LIVE doc I can't afford to corrupt" | safe-edit | `docs-revision` (mark) → read fully → apply → verify NEW text → `docs-comments-add` recovery note. **See §3 Safe Live-Edit Protocol.** |
| "Finalize this redlined doc: apply the notes, then remove the notes section" | B | Safe Live-Edit Protocol: `docs-find-replace`/`docs-batch-replace` to apply + verify, then `docs-section-delete --from-anchor` to strip |
| "Insert a table / image / heading here" | B | `docs-insert-table`, `docs-insert-image`, `docs-style` |
| "This field updates every cycle (template/report)" | B | `docs-namedrange-create` → `docs-namedrange-replace` |
| "Apply our branded template / exact typography / complex tables" | C | `docs-export-docx` → OOXML tooling → `docs-import-docx` |
| "Produce tracked-changes / a redline I can accept-reject" | C | `docs-export-docx` → OOXML `w:ins`/`w:del` → `docs-import-docx` |
| "Add margins, headers, or footers" | — | `docs-format-page` (use after any lane's creation step; page numbers need Lane C DOCX) |
| "Suggest an edit for human review" | polyfill | `docs-suggest` (then `docs-comments-add` to flag it) |
| "Resolve/close a review comment" | polyfill | `docs-comments-resolve` |
| "Delete a comment" | polyfill | `docs-comments-delete` |
| "Leave feedback / flag an issue" | polyfill | `docs-comments-add` (pass `--quote` with the text it's about) |
| "Review a contract/doc clause-by-clause, leave feedback per clause" | review | One `docs-comments-add --quote "<clause>" --content "<note>"` per clause. **Do NOT append a review/redline section to the body.** See §3 "Review a document clause-by-clause". |

**Default lane selection:** If the document needs any visual styling beyond what Markdown supports (custom colors, branded fonts, table borders, colored headings), use Lane A+ (HTML). Otherwise, Lane A (Markdown) is simpler. For recurring documents with fixed layouts, use Lane D (Templates).

---

## 3. Procedures

### Safe Live-Edit Protocol (edit a doc in place without corrupting it)
Editing a live Google Doc is destructive and retries compound: a half-finished attempt leaves the doc in a state the next attempt misreads. Google Docs keeps **full native version history**, so the safe pattern is not to copy or back up the doc — it is to make every edit **reversible, idempotent, and positively verified**, then leave a note the human can act on. Follow this for any edit to a doc you cannot afford to corrupt (contracts, published docs, anything shared or high-stakes):

1. **Mark the restore point.** `docs-revision DOC_ID` — records the current revision + timestamp before you touch anything. Keep the returned `modifiedTime`; it is the "restore to here" anchor for step 5.
2. **Read completely first.** Never edit from a partial read. `docs-cat DOC_ID --meta`, then `docs-cat DOC_ID --out doc.txt`; coverage passes when `--out` `chars` equals `--meta` `chars` (both are character counts — do NOT recount with `wc -c`, which counts bytes and false-fails on smart quotes/em-dashes; use `wc -m` if you must). Plan the exact edits from the local file.
3. **Apply idempotently.** `docs-find-replace`/`docs-batch-replace` report per edit `applied:true` (occurrences>0) or `applied:false` (`0` = target not found: **already applied by a prior run, or never present**). This makes retries safe — an already-applied edit simply reports `absent`, it does not double-apply.
4. **Verify positively — re-derive, don't assume (B-28).** Re-read (`docs-cat DOC_ID --out doc2.txt`) and confirm the **NEW** text is present for each change. Checking only that the OLD text is gone is the trap that makes a run hunt for a section a prior run already removed. Never treat `absent` alone as success.
5. **Leave a recovery note.** `docs-comments-add DOC_ID --content "..."` — summarize what you changed and tell the human how to review and undo it, e.g. *"Edits made <date>; my changes are the revisions attributed to me in File → Version history. To undo, restore the version from <modifiedTime> or earlier."* Use a plain comment — **never @mention anyone**: an @mention sends an email (an outbound side effect, C-27); a sidebar comment does not.

Perform any irreversible step (deleting a source/notes section, overwriting the body) **only after** steps 2–4 pass. The step-5 comment is the audit trail — once a source section is removed it is the only durable record of what changed.

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

### Reading Large Documents (complete, verifiable reads)
1. Measure first: `docs-cat DOC_ID --meta` — returns total `chars` and the heading `outline` with char offsets.
2. If the doc is under ~6,000 chars, a plain `docs-cat DOC_ID` is fine.
3. **For the full content of anything larger, materialize it to disk in ONE call:**
   `docs-cat DOC_ID --out doc.txt` → returns `{written, chars}`.
   **Coverage check (mandatory before any edit):** compare the `chars` that `--out` returns to the `chars` in `--meta`. Both are **character** counts (Unicode code points) produced the same way, so a complete read makes them equal — `--out` reporting the same `chars` as `--meta` **is** your proof. Do NOT re-count the file with `wc -c`: that counts **bytes**, and any smart quote, em‑dash, or accent makes bytes > chars, so `wc -c` will look like a "mismatch" on a perfectly complete read. If you insist on a shell re-count, use `wc -m` (characters), never `wc -c`.
4. Analyze the LOCAL file, not more API reads: `grep -n "pattern" doc.txt`, `sed -n '100,200p' doc.txt`. This costs zero further doc reads and cannot be truncated.
5. To read just one section, take its heading offset (and the next heading's) from the `--meta` outline and read the span: `docs-cat DOC_ID --offset START --limit (END-START)`. Do NOT rely on `--find "HEADING" --context N` for long sections — it returns only ±N chars and silently drops the tail.
6. Anti-patterns that WILL fail: repeating a bare `docs-cat` (output is capped every time — you get the same head repeatedly and LoopGuard kills the session); paginating an entire large doc window-by-window through your own context (slow, token-heavy, and you lose track of coverage). Use `--out`.

### Finalize a Redlined Document (apply notes, then strip the notes section)
A common request: a doc has review/redline notes appended at the end; incorporate them into the body, then remove the notes so the doc is clean. This is a **destructive live edit** — it follows the Safe Live-Edit Protocol above, with these specializations.

**HARD ORDERING — deviation destroys content.** The notes section is the only copy of the requested changes: if you delete it before every change is applied AND positively verified, the changes are unrecoverable. Run NO mutation until step 2's coverage check passes.

1. **Mark + measure.** `docs-revision DOC_ID` (restore anchor), then `docs-cat DOC_ID --meta` — total chars + the notes heading (e.g. `[LEGAL REVIEW REDLINES]`) and its offset.
2. **Read fully + enumerate.** `docs-cat DOC_ID --out doc.txt`; **coverage passes when `--out` `chars` equals `--meta` `chars`** (both count characters; `wc -c` counts bytes and false-fails on any smart quote/em-dash — use `wc -m` if you must recount). From the local file (`grep -n`/`sed -n`), enumerate every redline as an explicit `{find, replace}` checklist. If the two char counts genuinely differ, STOP.
   - **Advisory redlines are not all mechanical.** Some notes read "consider adding a clause" rather than "replace X with Y." Apply the mechanical ones; for judgement calls, make your best edit **and** flag it in the step-6 comment for human review — do not block or fail the whole task because a redline resists a clean find/replace.
3. **Apply idempotently.** `docs-batch-replace DOC_ID --file pairs.json` (atomic) or `docs-find-replace` per clause — surgical, formatting-preserving. Read the per-pair `applied`/`absent` report.
4. **Verify positively.** Re-read (`docs-cat DOC_ID --out doc2.txt`) and confirm each checklist item's **NEW** text is present in the body. An `absent` in step 3 means either already-applied (new text present — fine) or never-applied (new text missing — fix before continuing). Do not proceed on `absent` alone.
5. **Only now strip the notes:** `docs-section-delete --doc DOC_ID --from-anchor "[LEGAL REVIEW REDLINES]"` — **always `--from-anchor`, never `--start/--end` raw indices** (plain-text offsets are not API indices; a raw-index delete here removes the wrong span).
6. **Verify final + leave the recovery note.** `docs-cat DOC_ID --meta` — notes heading gone, char count ≈ body-only, spot-check two applied changes. Then `docs-comments-add DOC_ID --content "..."` summarizing the changes applied (and any advisory items needing review) plus how to review/restore via File → Version history (plain comment, no @mention).

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

### Heavy or structural edits — edit locally, apply once (docx round-trip)
When a task needs **many** edits or **structural** changes to an existing doc (finalizing a contract, applying a batch of redlines, reorganizing sections), do NOT churn the live doc with many inline mutations across retries. Work on a local copy, plan and apply ALL edits there, then push the result back in **one** call. Version history is the restore point — nothing here is irreversible.

1. **Mark** the pre-edit revision: `docs-revision DOC_ID` (records the "restore to here" point).
2. **Export** to a local docx: `docs-export-docx --doc DOC_ID --out edit.docx`.
3. **Edit locally with python-docx** — open `edit.docx`, apply every planned change, save. python-docx splits a paragraph's text across "runs", so a phrase that spans runs won't match run-by-run; the robust pattern for text changes is to rebuild at the paragraph level:
   ```python
   import docx
   d = docx.Document('edit.docx')
   edits = {'Net 30': 'Net 20', 'peregrine3': 'Peregrine III'}   # your planned redlines
   def apply(paras):
       for p in paras:
           new = p.text
           for old, repl in edits.items(): new = new.replace(old, repl)
           if new != p.text and p.runs:
               for r in p.runs: r.text = ''          # clear existing runs
               p.runs[0].text = new                  # write the full replaced text back to the first run
   apply(d.paragraphs)
   for t in d.tables:
       for row in t.rows:
           for cell in row.cells: apply(cell.paragraphs)
   d.save('edit.docx')
   ```
   (The paragraph-rebuild drops intra-paragraph run formatting for changed paragraphs — fine for text redlines. If you must preserve bold/italic *within* a changed sentence, use the surgical Lane B `docs-batch-replace` instead.)
4. **Apply once**: `docs-replace-file --doc DOC_ID --file edit.docx` — replaces the live doc in a single atomic call, preserving its id and adding a revision.
5. **Verify** (B-28): `docs-cat DOC_ID --meta` plus `--find` spot-checks — confirm the changes landed and nothing was dropped. Doc→docx→Doc conversion can shift some formatting; check headings/tables if they matter, and fall back to Lane B for anything the round-trip mangled.
6. **Recovery note + clean up**: `docs-comments-add DOC_ID --content "<what changed + how to review/restore via File > Version history>"`, then **delete your local temp files** (`rm -f edit.docx doc.txt …`). Always leave the workspace clean — stray export/scratch files confuse the next mission.

### High-Fidelity/Tracked-Changes (Lane C Round-Trip)
1. Export the Google Doc using `docs-export-docx --doc DOC_ID --out local.docx`.
2. Perform OOXML manipulations locally (e.g., adding `w:ins`/`w:del` tracked changes or templates via `docx-js`/Office scripts).
3. Import the updated document using `docs-import-docx --file local.docx --title "Q3 Redlines" --folder FOLDER_ID`.

### Review a document clause-by-clause (leave targeted feedback)
For legal/contract review — feedback that must attach to specific clauses. **Leave one quoted comment per clause; never append a review/redline section to the document body.** An appended "[REVIEW NOTES]" section becomes debt a later "finalize" run must find, incorporate, and delete — the exact pattern that corrupts a doc across retries. Quoted comments keep the feedback *beside the clause* and leave the body clean.

1. Read the whole doc first: `docs-cat DOC_ID --out doc.txt` (coverage-check per "Reading Large Documents").
2. For each clause you have feedback on, take a short, exact, unique snippet of that clause from `doc.txt`.
3. Leave one self-contextualizing comment per clause:
   `docs-comments-add --doc DOC_ID --quote "<exact clause snippet>" --content "<feedback + reasoning>"`
   The reader sees the quoted clause next to your note. Keep the note plain and factual — no emoji, no voice, no "please review" chatter (a comment is an annotation, not a message; the mouth delivers messages).
4. Optionally post ONE brief summary comment (e.g. "12 review notes added inline; 3 are advisory"). Do not repeat it every run.
5. **Idempotent re-review**: before adding, `docs-comments-list --doc DOC_ID`; if you left comments on a prior pass, `docs-comments-resolve` the stale ones (or update in place) rather than stacking near-duplicates. Twelve clean quoted comments beat twenty floating repeats.

Use quoted comments for opinions/questions; reserve `docs-suggest` (the destructive yellow-highlight polyfill below) for concrete edits the human will accept or reject.

### Suggest → Review → Resolve
1. If the doc has multiple tabs, run `docs-tab-list DOC_ID` and pick the target tab; otherwise skip this step.
2. Apply the suggestion(s): `docs-suggest --doc DOC_ID [--tab t.X] --find "old clause" --replace "new clause" --reason "…"` (or `--file suggestions.json` for a batch). The replaced text is highlighted yellow.
3. Flag it for the human: `docs-comments-add --doc DOC_ID --content "Proposed edits highlighted in yellow — reply to approve."` (capture the returned comment ID).
4. On approval, optionally clear the yellow highlight with `docs-style` over the range (or leave it as the final look), then close the thread: `docs-comments-resolve --doc DOC_ID --comment-id CID`. To discard the thread entirely, `docs-comments-delete --doc DOC_ID --comment-id CID`.

---

## 4. Important Notes / Limitations

- **No Native Suggesting Mode**: The Google Docs API has no toggle for "Suggesting Mode". Use `docs-suggest` (the in-place highlighted-edit polyfill) for lightweight review, or Lane C (OOXML redlines) for accept/reject tracked changes.
- **Comments are document-level, but not context-free**: the Drive API does not reliably pin a comment to a live text range in the Docs editor, so a programmatic comment shows in the Comments sidebar rather than highlighted on the text. **Always pass `--quote "<exact text>"`** so the comment carries the clause it refers to (`quotedFileContent`) — the reader sees what you mean without a click-to-jump anchor. Emoji/voice do not belong in comments — keep them plain, factual annotations.
- **Markdown Image Limitation**: Google Drive's Markdown converter does **not** fetch and embed Markdown image syntax (`![caption](url)`). Use `docs-insert-image` (Lane B) to place images at resolved anchors after creation.
- **Markdown Formatting Limits**: Markdown conversion cannot produce custom colors, custom fonts, table borders, background shading, or fine-grained spacing. For these, use Lane A+ (HTML) instead.
- **Markdown Code Blocks**: Converted as indented plain text, not monospace-styled blocks. Apply monospace font via `docs-style` post-creation if needed.
- **Markdown Complex Tables**: Merged cells, column spans, and nested tables may not render. Use Lane B `docs-insert-table` for complex layouts.
- **HTML CSS Limits**: Inline CSS is supported for colors, fonts, sizes, padding, borders, alignment. CSS flexbox, grid, and class-based selectors are stripped during conversion. Use only inline `style=""` attributes.
- **Multipart Conversion Requirement**: All Markdown, HTML, and DOCX conversions require `multipart/related` Drive upload type (`uploadType=multipart`), passing both metadata and body parts in a single request.
- **Named Ranges Fragmentation**: If a named range is edited by human collaborators, it can split into multiple fragments. `docs-namedrange-replace` replaces **all** fragments of the range in a single call.
- **Image Constraints**: Public URL image insertions must be PNG/JPEG/GIF, under 50 MB, and URL length under 2KB (these are checked locally). The 25-megapixel dimension limit is enforced server-side by Google, not client-side.
- **Headers/Footers via Conversion**: Neither Markdown nor HTML conversion includes headers or footers. Apply these with `docs-format-page` as a post-creation step. Automatic page numbers are **unsupported** by `docs-format-page` (Docs API v1 has no page-number request) — use the Lane C DOCX round-trip if you need them.
- **Multi-line inserts**: `docs-anchor-insert`, `docs-write`, `docs-find-replace`, `docs-namedrange-replace`, and `docs-suggest` interpret `\n` and `\t` in `--text`/`--replace` as real line breaks and tabs — pass `"Clause 1.\nClause 2."` and get two lines. A literal backslash-n is never inserted verbatim.
- **Sharing**: Creating or editing a doc does not share it, and you should NOT share a document unless explicitly instructed — sharing sends notification emails, an outbound side effect agents do not initiate (C-27).

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
