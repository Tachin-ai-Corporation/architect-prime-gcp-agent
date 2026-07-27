# Skill: Google Docs (v27)

> [!IMPORTANT]
> All commands below are CLI scripts. Run them with the `run_command` tool and read the
> **real** output — never invoke them as functions and never hallucinate a JSON response.

## The model — edit in place, surgically

To change an existing Doc, edit **only what changes** and leave everything else untouched.
Google Docs keeps full version history, so in-place edits are safe and reversible — and
**formatting is preserved because you never rewrite the parts you are not changing** (the
header, tables, fonts, and every passage you didn't touch stay exactly as they were).

There are two paths, and the first is the default for nearly all real work:

- **Targeted edit (default):** the surgical Docs-API verbs — swap a passage's text, delete a
  section, insert at an anchor. Untouched content is preserved byte-for-byte. This covers
  revise / finalize / replace-a-section work.
- **Wholesale rebuild (rare):** only when the structure changes so much that surgical edits
  are impractical (reordering most of the document, rebuilding from a template). Export to
  `.docx`, edit locally with python-docx, apply once — then verify, because the
  Doc→docx→Doc conversion shifts some formatting.

**NEVER edit by reading the doc to plain text and writing the text back.** That flattens
every style to nothing. `docs-cat` text (including `--out`) is for **reading and planning
only**; `docs-replace-file` refuses `.txt`/`.md` for the same reason.

## The loop (every edit)

**mark → read & fingerprint → edit surgically → verify (incl. formatting) → note & clean up.**

## Commands

### Read (never written back)
- `docs-cat <doc_id>` — plain-text body (pipe/grep-able). Flags:
  - `--meta` — title, total chars, heading/tab outline with offsets (**run first on unfamiliar docs**).
  - `--fingerprint` — structural **formatting signature**: paragraph counts by style, tables + dims, image count, the set of distinct text styles/fonts. Capture **before and after** an edit and diff to prove formatting was preserved.
  - `--find "TEXT" [--context N]` — case-insensitive search, offsets + context.
  - `--out FILE` — write the COMPLETE text to FILE (read/plan only; coverage check: `--out` `chars` == `--meta` `chars`).
- `docs-tab-list <doc_id>` — list the doc's tabs with ids, titles and hierarchy. Run this first on a multi-tab doc: the edit tools default to the first tab, so an anchor "not found" on a tabbed doc usually means you are looking at the wrong tab.

**Every docs-\* tool takes a Doc ID, never a path.** The id is the token between `/d/` and
`/edit` in the doc's URL. An argument containing `/` or `\`, or ending in `.pdf`/`.docx`/`.txt`/
`.md`/`.json`, is refused **before any API call** — `docs-cat sara_agreement.pdf` is an argument
mistake, not a missing document. Get the real id from `drive-ls <folderId>` or
`drive-search --query "name contains '<fragment of the actual filename>'"`; if the file is not a
native Doc, convert it with `drive-to-doc --file <driveFileId>` and use the `docId` it returns.

**An identifier is never almost-right.** A 404 means the id is *wrong*, not close. Re-resolve it
from a listing (`drive-ls`) or a search and copy it verbatim. **Changing a character of an id and
retrying is never correct** — an id you edited is an id you invented. The same rule holds for
folder ids and file ids: copy, never retype, never repair.

### Restore point
- `docs-revision <doc_id> [--list]` — record the pre-edit head revision (keep its `modifiedTime` as the "restore to here" anchor); `--list` shows recent revisions.

### Targeted edits — surgical, formatting-preserving (the default)
Resolve **all** your edits against a single fresh read, then apply them together. Text-based
replacement is the robust default (no index math, formatting inherited); anchor-based
inserts/deletes are for structural moves. Anchor on a **unique, structural** phrase (a heading
beats a clause sentence) and match the **exact live text** — smart quotes, whitespace, and
section numbers included.

- `docs-batch-edit --doc <id> --file ops.json` — **apply many mixed edits in ONE atomic
  batchUpdate** (the preferred path for a multi-edit finalize). Reports every replacement's
  `occurrences` and collects any find-string that matched zero times in `zero_match_finds` —
  read that list before declaring the edit done. `ops.json` is a JSON array of
  `{"op":"replace","find":"…","replace":"…"}`, `{"op":"insert_after"|"insert_before","anchor":"…","text":"…"}`,
  `{"op":"delete_section","from_anchor":"…"}`. Resolves every anchor from one read, applies
  index ops highest-index-first (so edits never shift each other), guarded by the doc's
  revision. **Fail-fast:** if any anchor is not found / not unique, nothing is applied and each
  miss is reported — fix that string and re-run.
- `docs-find-replace --doc <id> --find "old" --replace "new" [--match-case]` — swap one known string (text-based; replacement inherits the matched formatting). Reports `occurrences` (0 = not matched).
- `docs-batch-replace --doc <id> --file pairs.json` — many swaps in one call; `[{"find","replace","matchCase"}]`, applied in order (can cascade). Reports per-pair `applied`/`absent`.
- `docs-section-delete --doc <id> --from-anchor "PHRASE" [--keep-anchor]` — delete from a **unique** anchor to the end of the doc. Or `--start N --end N` (raw Docs-API indices from `docs-get`).
- `docs-anchor-insert --doc <id> --anchor "PHRASE" --text "..." [--position before|after]` — insert at a **unique** anchor (inherits adjacent formatting). For several inserts/deletes, prefer `docs-batch-edit` (atomic, reverse-ordered).
- `docs-style --doc <id> (--anchor "phrase" | --start N --end N) --style "tokens"` — apply
  formatting. Comma-separated tokens:
  - **Text:** `bold`, `italic`, `underline`, `strikethrough`, `color=#HEX`, `highlight=#HEX`
    (text background), `font=FontName` (Google Docs font, e.g. Montserrat, Open Sans, Roboto),
    `size=Npt` (font size in points)
  - **Paragraph:** `align=LEFT|CENTER|RIGHT|JUSTIFIED`, `HEADING_1`..`HEADING_6`, `TITLE`,
    `SUBTITLE`, `NORMAL_TEXT`, `lineSpacing=N` (100=single, 115=1.15x, 200=double),
    `spaceAbove=Npt`, `spaceBelow=Npt`, `indent=Npt`, `shade=#HEX` (paragraph background)
  - Example: `--style "font=Montserrat, size=14, color=#1B2A4A, bold, spaceBelow=6"`
- `docs-insert-table --doc <id> --anchor "phrase" --rows N --cols M` — insert a table at a **unique** anchor.
- `docs-insert-image --doc <id> --anchor "phrase" --url IMAGE_URL` — insert an inline image from a public URL at a **unique** anchor (PNG/JPEG/GIF, <50MB, <25MP).
- `docs-format-page --doc <id> [--margins "1in"] [--header "text"] [--footer "text"] [--orientation portrait|landscape]` — page-level formatting only; does not touch body text.

**Fields that change every cycle — use a named range, not an anchor.** A named range is a
label attached to a span, so it survives edits that would move or break a text anchor:
- `docs-namedrange-create --doc <id> --name RANGE_NAME (--anchor "phrase" | --start N --end N)` — label the span once.
- `docs-namedrange-replace --doc <id> --name RANGE_NAME --text "new content"` — replace by label, no index math.
  If a human edit splits the range, `--replace` only hits the first fragment — re-create the range.

### Wholesale rebuild (only when surgical is impractical)
- `docs-export-docx --doc <id> --out edit.docx` — pull the live doc to a local `.docx`.
- `docs-replace-file --doc <id> --file edit.docx` — apply an edited `.docx` (or styled `.html`) back in one atomic call; preserves id + version history. **Refuses `.txt`/`.md`** (they destroy formatting).
- `docs-import-docx --file FILE.docx --title TITLE [--folder FOLDER_ID]` — import a local `.docx` as a **new** native Doc (the inbound half of the round-trip).
- `docs-write --doc <id> (--text "…" | --file FILE) [--append | --overwrite] [--markdown]` — append to, or overwrite, the body. `--append` is safe; **`--overwrite` discards the existing body and its formatting.**
- `docs-replace-md --doc <id> (--file FILE | --text "…")` — replace the whole body from Markdown. Same caveat: you are re-authoring the document, not editing it. Only for a doc you own end-to-end.

### Create a new document
- `docs-create --title "TITLE" (--from-markdown FILE | --from-html FILE) [--folder FOLDER_ID]` — create a formatted Doc from local Markdown or HTML (Drive converts it). Use HTML for colors/fonts/styled tables; Markdown otherwise.
  There is **no `--from-doc`**. To start from an existing Doc, use `docs-clone-template` below.
- `docs-clone-template --template DOC_ID --title "New Title" [--folder FOLDER_ID] [--replacements FILE]` — **copy an existing Doc and optionally fill its placeholders in the same call.** This is the tool for "duplicate the master template for each X". `--replacements` takes a JSON file of `{"[Placeholder]": "value"}` pairs (a `[{"find":…,"replace":…}]` list is accepted too), so clone-and-fill is one command, not four.
  Output includes the new `docId`, plus per-placeholder `replacements` counts and a `zero_match_finds` list — a placeholder that matched nothing means the template's token is not what you wrote, and that copy shipped unfilled. The template is never modified.

### Review comments
- `docs-comments-add --doc <id> --content "TEXT" [--quote "exact clause this is about"]` — leave a comment. **Always pass `--quote`** so it is self-contextualizing. Plain comments only — **never `@mention`** anyone (an @mention emails them; C-27).
- `docs-comments-list --doc <id> [--include-resolved]` · `docs-comments-resolve --doc <id> --comment-id <id>` · `docs-comments-delete --doc <id> --comment-id <id>`
- `docs-suggest --doc <id> [--tab <tab>] --find "text" --replace "text" [--reason "why"]` — propose a change for a human to accept or reject, instead of applying it. Use when the edit is a *recommendation*, not an instruction you were given.

---

## Procedure: duplicate a template and fill it (one per subject)

For "make N copies of this template, one per person/item". The whole job is **one command per
copy** — do not export, re-create, or hand-build the document.

1. **Read the template first — MANDATORY, before you write a single find-string.**
   `docs-cat <templateId> --out template.txt` then `readFile template.txt`. Copy placeholders
   **verbatim out of that output**. Exact spelling, case, and brackets matter — they are the
   find-strings in step 2. **Find-strings invented from the request's phrasing match nothing:**
   the fill reports zero occurrences and you ship copies with the placeholders still in them.
   Example: the task says "Contractor: ACME LLC, Rate: $10,000/mo" → you write
   `{"CONTRACTOR": "ACME LLC", "RATE": "$10,000"}` → but the template actually says
   `NAME/ENTITY` and `[$_____ per month]`. Zero replacements applied. You must read the template
   to discover `NAME/ENTITY`, `[$_____ per month]`, `[DURATION]`, etc. — every template uses
   different tokens and you cannot guess them from the task description.
2. **Write one replacements file per subject**, `{"[Advisor Name]": "…", "[Project Fee]": "…"}`,
   using only tokens that appeared in step 1's output. Leave a value as `""` for anything
   genuinely unknown — an empty field in a draft is honest and expected; inventing a value is not.
3. **Clone and fill in one call, per subject:**
   `docs-clone-template --template <templateId> --title "<Subject> - <DocName>" --folder <destFolderId> --replacements subject.json`
4. **Verify each copy** — check the call's own report first (`replacements`, `zero_match_finds`,
   `replacements_applied`), then `docs-cat <newDocId> --find "["`, which should return no
   unresolved placeholders you intended to fill. Compare `docs-cat --fingerprint` against the
   template to confirm the formatting survived.
5. The copies land directly in `--folder`; no separate move step is needed.

> If `--replacements` is impractical (values discovered later), clone first, then **read the
> clone** — `docs-cat <newDocId> --find "["` (or `--out clone.txt`) — to harvest its **actual**
> placeholder tokens, and only then write the ops file and apply it with **one**
> `docs-batch-edit` per copy — never a sequence of single replacements. Writing an ops file from
> the request text without reading the clone is how a batch of addendums ended up with every
> find-string matching nothing.
>
> **A zero-match report is a re-read signal, not a retry signal.** `zero_match_finds` from
> `docs-batch-edit` (or `replacements_applied: 0` / `zero_match_finds` from
> `docs-clone-template`) means the placeholders differ from what you assumed — re-read the clone
> and rebuild those find strings verbatim. Re-running the same replacements changes nothing, and
> a different template than the one you read has different placeholders: confirm you cloned the
> template you actually read.

---

## Procedure: edit or finalize an existing document (surgical — the default)
Apply a set of edits, revise passages, remove a section. Change only what moves; leave the
rest — and its formatting — untouched.

1. **Mark the restore point.** `docs-revision DOC_ID` — keep `modifiedTime` (the step-5 undo anchor).
2. **Read, plan, and fingerprint.** `docs-cat DOC_ID --meta` (outline + total chars), then
   `docs-cat DOC_ID --fingerprint` — save this as the **BEFORE** signature. Read detail with
   `docs-cat DOC_ID --find "..."` or `--out doc.txt` (read/plan **only** — never written back).
   Enumerate **every** change: which exact strings become which, which section to remove,
   where to insert. Advisory items ("consider adding…") are judgement calls: make your best
   edit and flag it in the step-5 comment; never block on them.
3. **Apply the edits from that one read** (untouched content keeps its formatting):
   - **A multi-edit finalize → assemble every change into one `docs-batch-edit` ops file and
     apply it once** — replaces + inserts + a section delete, atomically and reverse-ordered.
     One read, one write, no cross-edit drift.
   - A single change → `docs-find-replace` (wording) or `docs-anchor-insert` (one paragraph).
   - **On a miss** (`occurrences: 0`, `absent`, or `anchor not found / not unique`): the edit
     is **not** impossible — your string just didn't match the live text. Re-read the exact
     text with `docs-cat DOC_ID --find "<nearby words>"`, copy the **verbatim** string (smart
     quotes, whitespace, section numbers, and all), and retry. Treat a miss as a signal to
     re-derive, never as evidence the tool or the API "can't" do it.
4. **Verify (B-28):**
   - `docs-cat DOC_ID --fingerprint` = the **AFTER** signature. Diff it against BEFORE:
     tables, heading styles, and the distinct-text-style set must be **preserved** — only the
     counts you intentionally changed should move. A collapse (tables→0, styles→a single
     default) means formatting was destroyed — investigate before reporting done.
   - `docs-cat DOC_ID --find` spot-checks: the new text is present, removed sections are
     gone, untouched content survives.
5. **Note + clean up.** `docs-comments-add DOC_ID --content "<what changed + any advisory items to review; to undo, restore the version from <modifiedTime> in File > Version history>"` (plain comment, no @mention). `rm -f` any temp files (`doc.txt`, etc.) — leave the workspace clean.

## Procedure: wholesale rebuild (rare — only when surgical is impractical)
When the structure changes so much that surgical edits don't make sense:
1. `docs-revision DOC_ID` (restore point) + `docs-cat DOC_ID --fingerprint` (BEFORE).
2. `docs-export-docx --doc DOC_ID --out edit.docx`.
3. Edit `edit.docx` with python-docx (see patterns), save.
4. `docs-replace-file --doc DOC_ID --file edit.docx` (one atomic call).
5. **Verify with a `--fingerprint` diff** — the Doc→docx→Doc conversion shifts some
   formatting; check headings/tables/fonts and, if something regressed, fix it in the docx
   and re-apply.
6. Note + clean up (`rm -f edit.docx`).

## Procedure: create a new document

**Use `docs-create-branded` (see the PRIMARY procedure below).** It takes structured JSON
content and handles ALL HTML generation, branding, fonts, and page formatting internally.
Do NOT write raw HTML yourself — `docs-create-branded` does it better and the motor does
not need to produce any HTML.

For plain-text-only docs with zero formatting (rare): `docs-create --title "…" --from-markdown file.md --folder FOLDER_ID`.

## Procedure: review a document and leave feedback (don't edit the body)
For a review pass where you give feedback rather than change the text.
1. Read fully (`docs-cat DOC_ID --out doc.txt`).
2. For each passage you have feedback on, leave one quoted comment:
   `docs-comments-add --doc DOC_ID --quote "<exact snippet>" --content "<feedback + reasoning>"`.
3. **Never append a "[REVIEW NOTES]" or similar section to the body** — that becomes debt a
   later edit must find and delete. Feedback lives in comments, beside the passage.
4. Keep comments plain and factual. On re-review, `docs-comments-list` and resolve stale
   comments instead of stacking duplicates.

---

## Branding system

A **brand guide** is a Google Doc or JSON file that defines colors, fonts, and formatting
standards. When a mission references a brand guide, read it first and use its values for every
document you create or format. When no brand guide is specified, use the **default brand** below.

### Default brand values (use when no brand guide is provided)

| Element | Value |
|---|---|
| Primary color | `#1B2A4A` (deep navy) |
| Secondary color | `#3D5A80` (steel blue) |
| Accent color | `#E07A5F` (warm coral) |
| Heading text color | `#1B2A4A` |
| Body text color | `#2D3748` |
| Table header background | `#1B2A4A` |
| Table header text | `#FFFFFF` |
| Table alt-row background | `#F7F8FA` |
| Heading font | Montserrat |
| Body font | Open Sans |
| Title size | 26pt |
| Heading 1 size | 22pt |
| Heading 2 size | 16pt |
| Heading 3 size | 13pt |
| Body size | 11pt |
| Line spacing | 1.15 (= `lineSpacing=115`) |
| Margins | 1in |
| Accent divider | 2px solid primary color |

### Brand guide format

A brand guide document uses this structure — the agent reads it with `docs-cat` and extracts
values by line prefix. Missing lines fall back to the defaults above.

```
Brand Guide: [Company Name]

COLORS
Primary: #HEX
Secondary: #HEX
Accent: #HEX
Heading Text: #HEX
Body Text: #HEX
Table Header Background: #HEX
Table Header Text: #HEX
Table Row Alt: #HEX

TYPOGRAPHY
Heading Font: FontName
Body Font: FontName
Title Size: N
Heading 1 Size: N
Heading 2 Size: N
Heading 3 Size: N
Body Size: N
Line Spacing: N

PAGE
Margins: 1in
Header: text for the header
Footer: text for the footer

ELEMENTS
Logo URL: https://publicly-accessible-image-url
Divider Color: #HEX
Link Color: #HEX
```

### Reading a brand guide

1. `docs-cat <brandGuideId> --out brand.txt`
2. Parse each `Key: Value` line. Missing keys → default brand values.
3. Store the parsed values as variables for HTML generation or `docs-style` calls.
4. `rm -f brand.txt` after extracting values.

---

## Auto-enrichment — every document must look professional

When the user's request is sparse ("create a status report", "draft a proposal"), you are
responsible for adding the formatting detail they didn't specify. The skill owns the standard
of quality, not the prompt. Apply ALL of the following automatically unless the user
explicitly opts out:

- **Brand colors and fonts** — read the brand guide if one is referenced, otherwise use
  default brand values above. Never create a document in the default Google Docs style.
- **Heading hierarchy** — every document gets a styled title (H1), subtitle line, and at
  least one H2 section heading. Add H3 sub-sections where the content warrants it.
- **Callout boxes** — summaries, key takeaways, or important notes go in a styled callout
  (ice-blue background, steel-blue left border).
- **Tables** — any data that has columns belongs in a styled table with a navy header row,
  white header text, and alternating row shading. Never present tabular data as plain text.
- **Emphasis** — key terms and critical values get accent color + bold. Secondary info gets
  muted color.
- **Footer disclaimer** — add a muted 9pt footer line (e.g. "Confidential" or
  "Draft — for internal use") unless the user provides one.
- **Page formatting** — 1in margins, branded header and footer text via `docs-format-page`.

- **Sample content** — when the user provides no specific data ("make a status report",
  "create a performance summary"), populate the document with **realistic sample data**
  (example metrics, placeholder names, representative numbers). Never ask for data or
  block the mission — a beautifully formatted document with sample content is far more
  useful than no document. The user can fill in real values later.

The goal: a user who asks for "a report" gets back a document that looks like it came from
a design team, not a text editor. **Never respond with `needs_input` for a document
creation request** — the document type itself tells you what sections and sample content
to include.

---

## Procedure: create a professionally formatted document (THE ONLY PATH)

> [!IMPORTANT]
> **ALWAYS use `docs-create-branded` for new documents.** Never write raw HTML yourself.
> This tool generates the HTML internally with correct fonts (Google Fonts loaded), brand
> colors, tables, callouts, and page formatting. The motor's job is to write a JSON content
> file — the tool handles ALL design.

Use `docs-create-branded` for all new documents. This tool takes structured JSON content and
handles ALL HTML generation, branding, and page formatting internally. The motor provides the
*content* — the tool handles the *design*.

**`--brand-doc` reads the brand guide FOR YOU.** Pass the brand guide's Doc ID and the tool
reads it, extracts colors/fonts/sizes, and applies them. Do NOT `docs-cat` the brand guide
yourself, do NOT parse its content, do NOT extract hex values manually. The tool does all of
that internally. If `--brand-doc` is omitted, professional defaults are used.

**Pixel-perfect brand compliance.** The tool uses a two-pass approach: (1) HTML import for
document structure, then (2) Docs API `batchUpdate` to set exact font families, sizes, colors,
and spacing for each element type (title, H2, H3, body, table headers). This ensures the
final document matches the brand guide precisely — `docs-cat --fingerprint` will show the
exact brand values. No post-creation `docs-style` fixup is needed.

**This is a SINGLE motor task.** Write a JSON file with the document sections, then run one
command. Do NOT split "read brand guide" and "create document" into separate tasks.

### Steps

1. **Write a content JSON file** (`sections.json`) with the document structure:

```json
[
  {"type": "callout", "content": "**Executive Summary:** Overview of key findings and recommendations."},
  {"type": "heading", "level": 2, "text": "Project Status"},
  {"type": "paragraph", "text": "The following table summarizes active projects."},
  {"type": "table", "headers": ["Project", "Status", "Lead", "Budget", "Completion"],
   "rows": [["Alpha Platform", "Active", "John D.", "$50K", "75%"],
            ["Beta Launch", "Planning", "Jane S.", "$30K", "20%"]]},
  {"type": "heading", "level": 2, "text": "Key Highlights"},
  {"type": "bullets", "items": ["**Revenue up 15%** quarter-over-quarter.", "New client onboarded.", "Team expanded by 2 hires."]},
  {"type": "heading", "level": 2, "text": "Risks & Mitigations"},
  {"type": "numbered", "items": ["**Supply chain delay** — mitigated by dual sourcing.", "**Budget pressure** — reduced scope for Phase 2."]},
  {"type": "divider"},
  {"type": "footer", "text": "Confidential — for internal use only."}
]
```

2. **Create the doc** (one command):
   `docs-create-branded --title "Q3 2026 Project Status Report" --subtitle "Prepared by Operations — July 2026" --content sections.json --folder <folderId> --brand-doc <brandGuideDocId> --header "Company Name" --footer "Confidential"`

3. **Verify:** `docs-cat <newDocId> --meta` + `docs-cat <newDocId> --fingerprint`
4. **Clean up:** `rm -f sections.json`

Section types: `callout`, `heading` (level 1-6), `paragraph`, `table` (headers + rows),
`bullets`, `numbered`, `divider`, `footer`.

**Text markup** (use in any text/content field — the tool renders them as styled HTML):
- `**bold text**` → strong/bold
- `{{accent:key metric}}` → accent color (coral) + bold weight
- `{{muted:secondary info}}` → muted color (slate gray)
- Plain text → body color, normal weight

**Never write raw HTML tags** (`<b>`, `<span>`, `<strong>`, etc.) in JSON content — they
appear as literal text in the document. Use the markup patterns above instead.

Omit `--brand-doc` to use built-in defaults (Montserrat headings, Open Sans body, navy/steel-blue/coral palette).

The tool's output includes `page_formatting` confirming margins, header, and footer were
applied, plus `fonts` and `colors` showing which brand values were used.

---

## Alternative: create from raw HTML (advanced)

For documents that need custom HTML layout beyond what `docs-create-branded` supports.
Use `docs-create --from-html` with a hand-crafted HTML file. The motor must write the
complete HTML to a file and run the command in ONE task.

1. **Write a complete HTML file** to `doc.html` using `cat <<'HTMLEOF' > doc.html`.
   Use the template below, substituting brand values and filling in real content:

```html
<html><head><style>
  body { font-family: 'Open Sans', sans-serif; font-size: 11pt; color: #2D3748; line-height: 1.4; }
  h1 { font-family: 'Montserrat', sans-serif; font-size: 22pt; color: #1B2A4A; border-bottom: 2px solid #1B2A4A; padding-bottom: 4pt; margin-bottom: 12pt; }
  h2 { font-family: 'Montserrat', sans-serif; font-size: 16pt; color: #3D5A80; margin-top: 18pt; margin-bottom: 8pt; }
  h3 { font-family: 'Montserrat', sans-serif; font-size: 13pt; color: #3D5A80; margin-top: 14pt; margin-bottom: 6pt; }
  table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
  th { background-color: #1B2A4A; color: #FFFFFF; font-family: 'Montserrat', sans-serif; font-size: 10pt; font-weight: 600; text-align: left; padding: 8pt 12pt; }
  td { padding: 8pt 12pt; border-bottom: 1px solid #E2E8F0; font-size: 10pt; }
  tr:nth-child(even) td { background-color: #F7F8FA; }
  .accent { color: #E07A5F; font-weight: 600; }
  .callout { background-color: #F0F4F8; border-left: 4px solid #3D5A80; padding: 10pt 14pt; margin: 12pt 0; font-size: 10pt; }
  .divider { border: none; border-top: 2px solid #1B2A4A; margin: 18pt 0; }
  .subtitle { font-family: 'Open Sans', sans-serif; font-size: 13pt; color: #3D5A80; margin-top: -8pt; margin-bottom: 16pt; }
  .muted { font-size: 9pt; color: #718096; }
</style></head><body>

<h1>Document Title</h1>
<p class="subtitle">Subtitle — prepared by [Author], [Date]</p>

<div class="callout"><strong>Executive Summary:</strong> A brief overview paragraph
summarizing the document's key points and conclusions.</div>

<h2>Section Heading</h2>
<p>Body text here. Use <span class="accent">accent color</span> for key terms and
critical values.</p>

<h2>Data Section</h2>
<table>
  <tr><th>Column A</th><th>Column B</th><th>Column C</th><th>Status</th></tr>
  <tr><td>Item 1</td><td>Description</td><td>Value</td><td><span class="accent">Active</span></td></tr>
  <tr><td>Item 2</td><td>Description</td><td>Value</td><td>Complete</td></tr>
  <tr><td>Item 3</td><td>Description</td><td>Value</td><td>Pending</td></tr>
</table>

<h2>Key Points</h2>
<ul>
  <li><strong>First point</strong> — supporting detail.</li>
  <li><strong>Second point</strong> — supporting detail.</li>
  <li><strong>Third point</strong> — supporting detail.</li>
</ul>

<hr class="divider">
<p class="muted">Confidential — for internal use only.</p>

</body></html>
```

3. **Create the doc:** `docs-create --title "Document Title" --from-html doc.html --folder <folderId>`
4. **Apply page formatting** (headers and footers are page-level, NOT part of the HTML body):
   `docs-format-page --doc <newDocId> --margins "1in" --header "Company Name" --footer "Confidential"`
5. **Verify:** `docs-cat <newDocId> --meta` (structure) + `docs-cat <newDocId> --fingerprint` (styles/fonts).
6. **Clean up:** `rm -f doc.html brand.txt`

**Key boundary:** HTML covers the document BODY (text, headings, tables, callout boxes,
bullet lists, dividers, footer disclaimers). Page-level chrome (margins, running headers,
running footers) is `docs-format-page` — a separate command after the doc exists. Do not
try to put headers/footers in the HTML.

### CSS properties honored by Google Docs HTML import

| Category | Properties | Notes |
|---|---|---|
| **Text** | `color`, `font-family`, `font-size`, `font-weight`, `font-style`, `text-decoration`, `text-align`, `vertical-align` | Font must exist in Google Docs catalog (includes Google Fonts: Montserrat, Open Sans, Roboto, Lato, Poppins, Merriweather, Raleway, Playfair Display, etc.) |
| **Background** | `background-color` | Works on `td`, `th`, `div`, `span`, `p` |
| **Tables** | `border`, `border-collapse`, `border-color`, `border-width`, `padding`, `width` | Per-cell and per-table. `border-collapse: collapse` recommended. |
| **Spacing** | `margin-top`, `margin-bottom`, `padding`, `line-height` | Applied to paragraphs and block elements |
| **Layout** | `width` (on `table`, `img`), `text-indent` | Percentage widths on tables work |
| **Images** | `<img src="..." width="..." height="...">` | URL must be publicly accessible. Use HTML attributes, not CSS, for dimensions |
| **Lists** | `<ul>`, `<ol>`, `<li>` | Nested lists preserved. `list-style-type` partially honored |
| **NOT supported** | `flexbox`, `grid`, `position`, `float`, `@media`, CSS variables, `calc()`, `@import`, external stylesheets, `box-shadow`, `text-shadow`, `border-radius`, gradients, `transform`, `opacity` | Keep CSS simple — inline styles are most reliable |

### When to use which path

| Situation | Path |
|---|---|
| **New document — any professional format** | `docs-create-branded` with JSON sections (PRIMARY) |
| New document — custom HTML layout needed | `docs-create --from-html` with hand-crafted HTML (advanced) |
| New document from an existing template | `docs-clone-template` (inherits template's formatting) |
| Editing an existing doc — change text/sections | Surgical edits (`docs-batch-edit`, `docs-find-replace`) |
| Applying brand styles to an existing doc's headings | `docs-style` with brand font/size/color per heading |
| Complete reformat of an existing doc | `docs-export-docx` → edit with python-docx → `docs-replace-file` |

---

## Procedure: apply branding to an existing document

When you need to restyle an existing document to match a brand guide.

1. **Read the brand guide** (or use defaults).
2. `docs-cat <docId> --meta` — get the heading outline with offsets.
3. For the document title (if present):
   `docs-style --doc <id> --anchor "<title text>" --style "font=Montserrat, size=26, color=#1B2A4A, bold"`
4. For each Heading 1:
   `docs-style --doc <id> --anchor "<heading text>" --style "font=Montserrat, size=22, color=#1B2A4A, HEADING_1"`
5. For each Heading 2:
   `docs-style --doc <id> --anchor "<heading text>" --style "font=Montserrat, size=16, color=#3D5A80, HEADING_2"`
6. For body text ranges:
   `docs-style --doc <id> --start N --end M --style "font=Open Sans, size=11, color=#2D3748, lineSpacing=115"`
7. `docs-format-page --doc <id> --margins "1in" --header "Company Name" --footer "Confidential"`
8. `docs-cat <docId> --fingerprint` — confirm styles applied.

---

## python-docx patterns (rebuild path only)
Open once, change everything, save once: `d = docx.Document('edit.docx'); … ; d.save('edit.docx')`.

**Replace text while preserving run formatting.** Edit run text **in place** where the match
fits inside one run — formatting is untouched. Only rebuild a paragraph when a match spans
runs, and let the surviving run keep its own style so bold/italic/size survive:
```python
import docx
d = docx.Document('edit.docx')
edits = {'Net 30': 'Net 20', 'acme': 'Peregrine III'}   # your planned changes
def apply(paras):
    for p in paras:
        # Fast path — match sits inside one run: edit that run, formatting intact.
        for r in p.runs:
            for old, new in edits.items():
                if old in r.text:
                    r.text = r.text.replace(old, new)
        # Cross-run match: rebuild via the FIRST run so it keeps that run's font/bold/size.
        joined = p.text
        newtext = joined
        for old, new in edits.items():
            newtext = newtext.replace(old, new)
        if newtext != joined and p.runs:
            keep = p.runs[0]
            for r in p.runs[1:]:
                r.text = ''
            keep.text = newtext
apply(d.paragraphs)
for t in d.tables:                            # tables too
    for row in t.rows:
        for c in row.cells: apply(c.paragraphs)
d.save('edit.docx')
```

**Delete a trailing section** (everything from a heading to the end):
```python
import docx
d = docx.Document('edit.docx')
body = d.paragraphs
start = next((i for i, p in enumerate(body) if 'APPENDIX: NOTES' in p.text), None)
if start is not None:
    for p in body[start:]:
        p._element.getparent().remove(p._element)
d.save('edit.docx')
```

---

## Notes & limits
- **Surgical edits preserve untouched formatting perfectly — prefer them.** Reach for the
  rebuild path only when the structure genuinely must be rebuilt.
- **A Google Doc is already readable — never round-trip it.** If the file is a native Doc, read
  it with `docs-cat <docId>`. Do **not** `drive-download` it to `.pdf`/`.docx` and `drive-to-doc`
  the local file back: one agent did exactly that, burned several minutes, and produced nothing
  it did not already have (`drive-to-doc` on a Doc just answers `already_doc`). Conversion is
  only for files that are *not* Docs — a PDF, an image, a `.docx` you were sent. `docs-export-docx`
  is for the rebuild path, not for reading.
- **A Doc ID is not a filename, and never almost-right.** Ids come from `drive-ls`/`drive-search`
  output, copied verbatim; a path or filename is rejected before the API call, and a 404 is
  re-resolved from a listing, never patched a character at a time.
- **`docs-cat` text is READ/PLAN only.** Never write it back — it has no formatting and
  carries no styles, so a replace from it flattens the document. `docs-replace-file` refuses
  `.txt`/`.md` to enforce this.
- **Fingerprint before + after** to *prove* formatting survived — a passing content check is
  not a passing formatting check.
- **Version history is the safety net.** Every write adds a revision; nothing is irreversible.
- **A miss means re-derive, not "impossible."** An unmatched anchor or `occurrences: 0` means your string didn't match the live text — re-read the verbatim text and retry. The tools apply real edits; a mismatch is never evidence the API can't.
- **Stable anchors (optional).** For an edit that must survive intervening changes, create a named range from the initial read and target it by label — it survives edits an exact-text match would lose.
- **Sharing.** Creating or editing a doc does not share it — never share unless explicitly asked (sharing emails people; C-27).
- **Comments never `@mention`.** Plain, self-contextualizing (`--quote`) comments only.

## Error recovery
| Symptom | Cause | Recovery |
|---|---|---|
| `403`/`401` / access_denied | Doc not shared with the agent SA | Share the doc with the agent's service-account email. |
| `404` from the Docs API | One of three: (a) the id is wrong/invented, (b) the file exists but is **not** a native Doc (PDF/`.docx`/Sheet), (c) no permission | The tool prints all three with their fix. (a) Re-resolve the id — `drive-ls <containingFolderId>` or `drive-search --query "name contains '<fragment>'"` — and copy it verbatim. (b) `drive-to-doc --file <driveFileId>`, then `docs-cat` the returned `docId`. (c) Report the access block; retrying will not help. |
| Tempted to tweak an id and retry after a 404 | Treating an id as approximately right | **Never.** An id you edited is an id you invented — one mission mutated a single character and re-ran, which cannot succeed. Re-resolve from a listing or search. |
| `is a local path/filename, not a Google Doc ID` (instant, no API call) | A path/filename was passed where an id belongs (`docs-cat`, `docs-batch-edit --doc`, `docs-clone-template --template`) | `drive-ls <folderId>` / `drive-search` for the id; `drive-to-doc --file <driveFileId>` if the file is not a Doc, then use its `docId`. |
| Reaching for `drive-download` + `drive-to-doc` on a Doc | Treating a native Doc as a foreign file | Read it with `docs-cat <docId>`. The round-trip costs minutes and yields nothing; `drive-to-doc` on a Doc returns `already_doc`. |
| Instant (<20ms) `Command failed` / `Unknown arg` | An invented flag — the command died in argument parsing and never reached the API | Re-read the command's line above and use the documented flag. A sub-20ms failure is *always* your arguments. Do not try a third spelling, and do not switch to a different tool hoping its flags differ — look the flag up. |
| "I need to duplicate this Doc" | Reaching for `docs-create --from-doc` (does not exist) or `drive-copy` | `docs-clone-template --template <id> --title "…" [--folder …]`. See "duplicate a template and fill it" above. `drive-copy` (workspace-drive) is a plain file copy with no placeholder filling. |
| Anchor "not found" on a doc with tabs | The edit tools default to the first tab | `docs-tab-list <doc_id>`, then pass the right `--tab`. |
| `docs-cat` output cut off | Doc larger than the output cap | Use `--out FILE` (complete read), then grep/sed the local file. |
| `docs-find-replace`/`batch` reports `absent` (0 occurrences) | `find` text not present (already applied, or never matched) | Confirm the NEW text is in the doc; adjust the `find` string to match the live text exactly. |
| `docs-section-delete`/`anchor-insert` "anchor not unique/found", or `docs-batch-edit` `unresolved` | Phrase repeats or doesn't match the live text | Re-read the exact text (`docs-cat --find`), copy the **verbatim** string (smart quotes/whitespace/section numbers included), and retry — a miss means re-derive, not that the edit is impossible. A longer phrase disambiguates a non-unique anchor. |
| `docs-batch-edit` reports `zero_match_finds` (or `docs-clone-template` reports `zero_match_finds` / `replacements_applied: 0`) | Those find-strings are not in the document — the real placeholders differ from the ones you assumed (usually written from the request text instead of read from the doc) | Read the live doc (`docs-cat <id> --find "["` or `--out doc.txt`), copy the placeholders **verbatim**, and re-run only the misses. **Do not re-run the same replacements** — nothing will change. A `hint` of "present under different capitalisation" means drop `matchCase` or copy the exact casing. |
| `docs-batch-edit` reports `stale` | Doc changed since it was read (revisionId mismatch) | Re-read and rebuild the ops from the current text, then re-apply. |
| Fingerprint shows tables/styles collapsed after an edit | A plain-text/markdown round-trip flattened the doc | Restore the pre-edit version (File > Version history) and redo the change with the surgical verbs. |
| `docs-replace-file` refuses `.txt`/`.md` | Wholesale replace from plain text/markdown destroys formatting | For a targeted change use the surgical verbs; for a real rebuild supply `.docx`/`.html`. |
| `import docx` fails | python-docx missing | Ships via the skill's apt dependency (`python3-docx`); a redeploy reinstalls it. |
