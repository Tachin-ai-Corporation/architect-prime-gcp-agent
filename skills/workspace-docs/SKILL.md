# Skill: Google Docs (v15)

> [!IMPORTANT]
> All commands below are CLI scripts. Run them with the `run_command` tool and read the
> **real** output — never invoke them as functions and never hallucinate a JSON response.

## The model — edit locally, apply once
A Google Doc is edited by working on a **local copy** and applying the whole result back in
**one call** — never by many inline mutations to the live document. Google Docs keeps full
version history, so this is safe, reversible, and idempotent on retry. Every edit follows:

**mark → export → edit the `.docx` locally → apply once → verify → note & clean up.**

Reading is direct (`docs-cat`). Creating a brand-new doc is direct (`docs-create`). Leaving
review feedback is direct (`docs-comments-add --quote`). Any change to an existing doc's
*content* goes through the edit loop above — that is the whole skill.

Editing the local `.docx` uses **python-docx** (installed as `python3 -c "import docx"`).
You have the full document as an object model: paragraphs, runs, tables. Make every planned
change there, save, and push it back once.

## Commands

### Read
- `docs-cat <doc_id>` — plain-text body (pipe/grep-able). Flags for large docs:
  - `--meta` — title, total chars, heading outline with offsets (**run first on unfamiliar docs**).
  - `--out FILE` — write the COMPLETE text to FILE in one call; returns `{written, chars}`. The way to read a whole doc. Coverage check: `--out` `chars` should equal `--meta` `chars` (both are character counts — never `wc -c`, which counts bytes).
  - `--find "TEXT" [--context N]` — case-insensitive search, offsets + context.
  - `--offset N --limit M` — a window of M chars from offset N.

### Create a new document
- `docs-create --title "TITLE" (--from-markdown FILE | --from-html FILE) [--folder FOLDER_ID]` — create a formatted Doc from a local Markdown or HTML file (Drive converts it: `<h1>`→Heading 1, tables, inline CSS colors/fonts). Use HTML when you need colors, fonts, or styled tables; Markdown otherwise.

### Edit an existing document (the docx loop)
- `docs-revision <doc_id> [--list]` — record the pre-edit head revision (the restore point); `--list` shows recent revisions with authors/timestamps.
- `docs-export-docx --doc <doc_id> --out FILE.docx` — pull the live doc to a local `.docx`.
- `docs-replace-file --doc <doc_id> --file FILE.docx` — apply the edited `.docx` back in **one atomic call**. Preserves the doc id and adds a revision (version history intact). Also accepts `.html`/`.md`/`.txt`. Surfaces the real HTTP status + body on failure.

### Review comments
- `docs-comments-add --doc <doc_id> --content "TEXT" [--quote "exact text this is about"]` — leave a comment. Comments are document-level, so **always pass `--quote`** with the exact clause the note is about, so it is self-contextualizing. Plain comments only — **never `@mention`** anyone (an @mention emails them, an outbound side effect; C-27).
- `docs-comments-list --doc <doc_id> [--include-resolved]` · `docs-comments-resolve --doc <doc_id> --comment-id <id>` · `docs-comments-delete --doc <doc_id> --comment-id <id>`

---

## Procedure: edit or finalize an existing document
The core task — apply changes to a live doc (incorporate redlines, revise clauses, remove a
section, restructure). Do it on a local copy and apply once; do **not** hunt-and-peck the
live doc with repeated edits.

1. **Mark the restore point.** `docs-revision DOC_ID` — keep the returned `modifiedTime`; it
   is the "restore to here" anchor for step 6.
2. **Read fully + plan every change.** `docs-cat DOC_ID --meta`, then `docs-cat DOC_ID --out doc.txt`
   (coverage passes when `--out` `chars` == `--meta` `chars`). From the local text, enumerate
   **all** the edits you intend to make — this is your plan. Advisory items ("consider adding…")
   are judgement calls: make your best edit and flag it in the step-6 comment; never block on them.
3. **Export to a local docx.** `docs-export-docx --doc DOC_ID --out edit.docx`.
4. **Make every edit locally with python-docx**, then save. See "python-docx patterns" below.
   All changes — text replacements, clause rewrites, deleting a trailing notes/redlines
   section — happen here, in `edit.docx`.
5. **Apply once.** `docs-replace-file --doc DOC_ID --file edit.docx` — the whole edited
   document replaces the live content in a single call, preserving id + version history.
6. **Verify + note + clean up.**
   - Verify (B-28): `docs-cat DOC_ID --meta` + `docs-cat DOC_ID --find "..."` spot-checks —
     confirm the intended changes are present, removed sections are gone, and untouched
     content survived. Doc→docx→Doc conversion can shift some formatting; check headings/tables.
   - Recovery note: `docs-comments-add DOC_ID --content "<what changed + any advisory items to review; to undo, restore the version from <modifiedTime> in File > Version history>"` (plain comment, no @mention).
   - **Clean up the workspace:** `rm -f edit.docx doc.txt` (and any other temp files). Always
     leave the workspace clean — stray exports confuse the next mission.

## Procedure: create a new document
1. Write the content locally as Markdown (`report.md`) or, for colors/fonts/styled tables, HTML (`report.html`).
2. `docs-create --title "Q3 Report" --from-markdown report.md --folder FOLDER_ID` (or `--from-html`).
3. Verify: `docs-cat NEW_DOC_ID --meta`. Clean up the local source file if it was a scratch build.

## Procedure: review a document clause-by-clause (leave feedback, don't edit)
For legal/contract review where you give feedback rather than change the text.
1. Read fully (`docs-cat DOC_ID --out doc.txt`).
2. For each clause you have feedback on, leave one quoted comment:
   `docs-comments-add --doc DOC_ID --quote "<exact clause snippet>" --content "<feedback + reasoning>"`.
3. **Never append a "[REVIEW NOTES]" / redline section to the body** — that becomes debt a
   later finalize must find and delete. Feedback lives in comments, beside the clause.
4. Keep comments plain and factual (no emoji, no "please review" chatter). On re-review,
   `docs-comments-list` and resolve stale comments instead of stacking duplicates.

---

## python-docx patterns (editing `edit.docx`)
Open once, change everything, save once: `d = docx.Document('edit.docx'); ... ; d.save('edit.docx')`.

**Replace text.** python-docx splits a paragraph's text across "runs", so a phrase that spans
runs won't match run-by-run. Rebuild at the paragraph level:
```python
import docx
d = docx.Document('edit.docx')
edits = {'Net 30': 'Net 20', 'peregrine3': 'Peregrine III'}   # your planned changes
def apply(paras):
    for p in paras:
        new = p.text
        for old, repl in edits.items(): new = new.replace(old, repl)
        if new != p.text and p.runs:
            for r in p.runs: r.text = ''      # clear runs
            p.runs[0].text = new              # write the full replaced text to the first run
apply(d.paragraphs)
for t in d.tables:                            # tables too
    for row in t.rows:
        for c in row.cells: apply(c.paragraphs)
d.save('edit.docx')
```
(The paragraph-rebuild drops intra-paragraph run formatting only for *changed* paragraphs.)

**Delete a trailing section** (e.g. everything from a `[LEGAL REVIEW REDLINES]` heading to the end):
```python
import docx
d = docx.Document('edit.docx')
body = d.paragraphs
start = next((i for i,p in enumerate(body) if 'LEGAL REVIEW REDLINES' in p.text), None)
if start is not None:
    for p in body[start:]:
        p._element.getparent().remove(p._element)   # remove the paragraph elements
d.save('edit.docx')
```

**Insert a paragraph** after an anchor: `anchor.insert_paragraph_before(...)` on the following
paragraph, or `d.add_paragraph(...)` to append. Reorder by removing and re-inserting elements.

---

## Notes & limits
- **Version history is the safety net.** Every `docs-replace-file` adds a revision; nothing is
  irreversible. That is why editing in place (one apply) is safe and needs no backup copy.
- **Fidelity.** Doc→docx→Doc conversion is high-fidelity but not perfect — verify headings,
  tables, and lists after applying; re-export and fix in the docx if something shifted.
- **Always clean up** local temp files (`edit.docx`, `doc.txt`, scratch sources) when done.
- **Sharing.** Creating or editing a doc does not share it — never share unless explicitly asked (sharing emails people; C-27).
- **Comments never `@mention`.** Plain, self-contextualizing (`--quote`) comments only.

## Error recovery
| Symptom | Cause | Recovery |
|---|---|---|
| `403`/`401` / access_denied | Doc not shared with the agent SA | Share the doc with the agent's service-account email. |
| `docs-cat` output cut off | Doc larger than the output cap | Use `--out FILE` (complete read), then grep/sed the local file. |
| `--out` chars ≠ `--meta` chars | Genuinely incomplete read | Re-run `--out`; do not edit until they match. |
| `import docx` fails | python-docx missing | It ships via the skill's apt dependency (`python3-docx`); a redeploy reinstalls it. |
| `docs-replace-file` non-200 | Bad file / auth / conversion | Read the surfaced HTTP status + body; confirm the local file is a valid `.docx`. |
| Formatting shifted after apply | Doc↔docx conversion | Re-export, adjust in the docx, re-apply; for pure styling use `--from-html` on a rebuild. |
