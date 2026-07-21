# Skill: Google Docs (v17)

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

### Restore point
- `docs-revision <doc_id> [--list]` — record the pre-edit head revision (keep its `modifiedTime` as the "restore to here" anchor); `--list` shows recent revisions.

### Targeted edits — surgical, formatting-preserving (the default)
- `docs-find-replace --doc <id> --find "old" --replace "new" [--match-case]` — swap one known string. The replacement inherits the matched text's formatting. Reports `occurrences`.
- `docs-batch-replace --doc <id> --file pairs.json` — many swaps in ONE atomic call. `pairs.json` is a list of `{"find": "...", "replace": "...", "matchCase": false}`. Pairs apply **in order** and can cascade (A→B then B→C) — order them intentionally. Reports per-pair `applied`/`absent`.
- `docs-section-delete --doc <id> --from-anchor "PHRASE" [--keep-anchor]` — delete from a **unique** anchor phrase to the end of the doc (the way to strip a trailing notes/appendix section: anchor on its heading). Or `--start N --end N` for an explicit **raw Docs-API** index range (from `docs-get`, not `docs-cat` offsets).
- `docs-anchor-insert --doc <id> --anchor "PHRASE" --text "..." [--position before|after]` — insert text at a **unique** anchor (inherits adjacent formatting; use `docs-style` if it must differ). `\n`/`\t` in `--text` become real breaks.
- `docs-style` — adjust styling on a range when needed (read its SKILL header for syntax).

### Wholesale rebuild (only when surgical is impractical)
- `docs-export-docx --doc <id> --out edit.docx` — pull the live doc to a local `.docx`.
- `docs-replace-file --doc <id> --file edit.docx` — apply an edited `.docx` (or styled `.html`) back in one atomic call; preserves id + version history. **Refuses `.txt`/`.md`** (they destroy formatting).

### Create a new document
- `docs-create --title "TITLE" (--from-markdown FILE | --from-html FILE) [--folder FOLDER_ID]` — create a formatted Doc from local Markdown or HTML (Drive converts it). Use HTML for colors/fonts/styled tables; Markdown otherwise.

### Review comments
- `docs-comments-add --doc <id> --content "TEXT" [--quote "exact clause this is about"]` — leave a comment. **Always pass `--quote`** so it is self-contextualizing. Plain comments only — **never `@mention`** anyone (an @mention emails them; C-27).
- `docs-comments-list --doc <id> [--include-resolved]` · `docs-comments-resolve --doc <id> --comment-id <id>` · `docs-comments-delete --doc <id> --comment-id <id>`

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
3. **Apply each change surgically** (untouched content keeps its formatting):
   - Revise wording → `docs-find-replace` (one) or `docs-batch-replace` (many, atomic). Use
     `find` text unique enough to match exactly the intended spot.
   - Remove a section (e.g. a trailing notes/appendix section) → `docs-section-delete --from-anchor "<the section's unique heading>"`.
   - Add a paragraph → `docs-anchor-insert` at a unique nearby phrase.
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
1. Write the content locally as Markdown (`report.md`) or, for colors/fonts/styled tables, HTML (`report.html`).
2. `docs-create --title "Q3 Report" --from-markdown report.md --folder FOLDER_ID` (or `--from-html`).
3. Verify: `docs-cat NEW_DOC_ID --meta`. Clean up the local source file if it was a scratch build.

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

## python-docx patterns (rebuild path only)
Open once, change everything, save once: `d = docx.Document('edit.docx'); … ; d.save('edit.docx')`.

**Replace text while preserving run formatting.** Edit run text **in place** where the match
fits inside one run — formatting is untouched. Only rebuild a paragraph when a match spans
runs, and let the surviving run keep its own style so bold/italic/size survive:
```python
import docx
d = docx.Document('edit.docx')
edits = {'Net 30': 'Net 20', 'peregrine3': 'Peregrine III'}   # your planned changes
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
- **`docs-cat` text is READ/PLAN only.** Never write it back — it has no formatting and
  carries no styles, so a replace from it flattens the document. `docs-replace-file` refuses
  `.txt`/`.md` to enforce this.
- **Fingerprint before + after** to *prove* formatting survived — a passing content check is
  not a passing formatting check.
- **Version history is the safety net.** Every write adds a revision; nothing is irreversible.
- **Sharing.** Creating or editing a doc does not share it — never share unless explicitly asked (sharing emails people; C-27).
- **Comments never `@mention`.** Plain, self-contextualizing (`--quote`) comments only.

## Error recovery
| Symptom | Cause | Recovery |
|---|---|---|
| `403`/`401` / access_denied | Doc not shared with the agent SA | Share the doc with the agent's service-account email. |
| `docs-cat` output cut off | Doc larger than the output cap | Use `--out FILE` (complete read), then grep/sed the local file. |
| `docs-find-replace`/`batch` reports `absent` (0 occurrences) | `find` text not present (already applied, or never matched) | Confirm the NEW text is in the doc; adjust the `find` string to match the live text exactly. |
| `docs-section-delete`/`anchor-insert` "anchor not unique/found" | Phrase repeats or doesn't match | Pick a longer, unique anchor phrase copied from `docs-cat` output. |
| Fingerprint shows tables/styles collapsed after an edit | A plain-text/markdown round-trip flattened the doc | Restore the pre-edit version (File > Version history) and redo the change with the surgical verbs. |
| `docs-replace-file` refuses `.txt`/`.md` | Wholesale replace from plain text/markdown destroys formatting | For a targeted change use the surgical verbs; for a real rebuild supply `.docx`/`.html`. |
| `import docx` fails | python-docx missing | Ships via the skill's apt dependency (`python3-docx`); a redeploy reinstalls it. |
