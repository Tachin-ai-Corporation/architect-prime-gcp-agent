# Skill: Google Docs (v19)

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
- `docs-style` — adjust styling on a range when needed (read its SKILL header for syntax).
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
   `docs-cat <templateId> --meta` then `docs-cat <templateId> --out template.txt`, and copy its
   placeholders **verbatim out of that output** (e.g. `[Advisor Name]`, `[Effective Date]`,
   `[Project Fee]`). Exact spelling, case, and brackets matter — they are the find-strings in
   step 3. **Find-strings invented from the request's phrasing match nothing:** the fill reports
   zero occurrences and you ship N copies with the placeholders still in them. You cannot infer a
   template's tokens from the task description, and you may not skip this read because the
   template "obviously" contains a field. If the folder holds lookalike templates whose names
   differ only by a suffix, this read is also how you confirm you picked the right one — its
   placeholder set is the evidence, and confirming it *after* making N copies is too late.
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
