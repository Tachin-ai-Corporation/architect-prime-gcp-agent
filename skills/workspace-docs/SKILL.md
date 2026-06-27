# Skill: Google Docs

## When to Use
When a task involves creating, reading, editing, or commenting on Google Docs.

## Commands

### Read
- `docs-cat <doc_id>` — Read a Google Doc's full text.
  Output: String of the document's body text.
- `docs-comments-list --doc <doc_id> [--include-resolved]` — List comments associated with the document.
  Output: JSON array of comment metadata including `id`, `author`, `content`, and status.

### Write
- `docs-create --title "TITLE" [--body "INITIAL_TEXT"] [--folder FOLDER_ID]` — Create a new Google Doc.
  Output: Created document metadata including `id` and `url`.
- `docs-write --doc <doc_id> (--text "CONTENT" | --file FILE_PATH) [--append]` — Write text to the document. If `--append` is true, appends to the end; otherwise, overwrites the entire document body.
  Output: Success confirmation.
- `docs-find-replace --doc <doc_id> --find "OLD" --replace "NEW" [--match-case]` — Find and replace text inside the document.
  Output: Confirmation with replacement counts.
- `docs-comments-add --doc <doc_id> --content "TEXT"` — Add a document-level comment to the Doc.
  Output: Success confirmation.

### Tab Management
- `docs-tab-list <doc_id>` — List all tabs with IDs, titles, and hierarchy.
  Output: JSON with tab tree.
- `docs-tab-clone --doc <doc_id> --source-tab <tab_id> [--title "TITLE"]` — Clone a tab's text content into a new suggestion tab. Preserves paragraph structure and heading styles.
  Output: JSON with `sourceTabId`, `suggestionTabId`, `suggestionTabTitle`.
- `docs-tab-suggest --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id> --find "ORIGINAL" --replace "NEW" [--reason "WHY"]` — Make a tracked edit: replaces text in the suggestion tab, highlights it yellow, and adds a reject-checkbox entry at the top. Does not touch the original tab.
  Output: JSON with `changeId`.
- `docs-tab-finalize --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id>` — Finalize reviewed suggestions: apply approved changes to the original tab (unchecked = approved, checked/strikethrough = rejected), delete the suggestion tab, resolve the review comment.
  Output: JSON summary of applied and rejected changes.

## Important Notes
- **Document IDs:** Extract document IDs from Docs URLs. The ID is the long string of alphanumeric characters between `/d/` and `/edit` in the address bar.
- **Accidental Overwrites:** Using `docs-write` without `--append` will wipe the existing document text. Always check if you should use `--append`.
- **Suggesting Mode / Redlines (API Limitation):** The Google Docs API **does NOT support** native "Suggesting Mode" or anchored comments. All API writes are permanent changes. To make "suggestions" or "redlines", you MUST append a `[LEGAL REVIEW REDLINES]` or `[PROPOSED CHANGES]` section to the bottom of the document using `docs-write --append`, and leave a document-level comment pointing to it using `docs-comments-add`. Never try to turn on suggestion mode.
- **Tab-based suggestions:** Agents use a clone-edit-finalize workflow via document tabs. The suggestion tab shows changes highlighted yellow, with a reject-checklist at the top. The human checks any change they want to reject (checked items get strikethrough). Unchecked items are applied to the original tab on finalization. One comment total.
- **Tab IDs in batchUpdate:** Include `tabId` in every `location` and `range` object when targeting a specific tab. Omitting `tabId` defaults to the first tab.
- **Tab-scoped replaceAllText:** Use `tabsCriteria: {tabIds: ["TAB_ID"]}` to scope replacements to one tab. Without `tabsCriteria`, `replaceAllText` applies across ALL tabs.

## Procedures

### Suggest edits via tab-based review
1. Run `docs-tab-list <DOC_ID>` to find the target tab's ID.
2. Run `docs-tab-clone --doc <DOC_ID> --source-tab <TAB_ID>`.
3. For each proposed change: `docs-tab-suggest --doc <DOC_ID> --source-tab <TAB_ID> --suggestion-tab <NEW_TAB_ID> --find '<original>' --replace '<new>' --reason '<why>'`.
4. Post one comment: `docs-comments-add --doc <DOC_ID> --content "📋 I've prepared N suggested edits in the '✏️ Edits — TAB_NAME' tab. Changes are highlighted yellow. Check any to reject — unchecked changes will be applied. Reply here when done."`.
5. Wait for the human to reply (mission enters needs_input).
6. On reply: `docs-tab-finalize --doc <DOC_ID> --source-tab <TAB_ID> --suggestion-tab <NEW_TAB_ID>`.
7. Report summary: which changes were applied, which rejected.

### Read and analyze a document
1. Resolve the target document ID.
2. Run `docs-cat <DOC_ID>` to read the full body content.
3. If comments are relevant to the task, run `docs-comments-list --doc <DOC_ID>` to fetch comments.
4. Verify: Check that output text is returned and represents the target document.

### Create a new document in a folder
1. Resolve the destination folder ID using `drive-search`.
2. Run `docs-create --title '<title>' --body '<initial_text>' --folder <FOLDER_ID>`.
3. Record the returned document ID.
4. Verify: Confirm the output lists the new document ID and URL.

### Edit a document's content
1. Resolve the document ID.
2. If adding new text to the end, run `docs-write --doc <DOC_ID> --text '<content>' --append`.
3. If performing keyword replacements, run `docs-find-replace --doc <DOC_ID> --find '<find_keyword>' --replace '<replacement_keyword>'`.
4. Run `docs-cat <DOC_ID>` to verify that the edit applied correctly.

### Add feedback comments
1. Resolve the document ID.
2. Run `docs-comments-add --doc <DOC_ID> --content '<feedback_text>'`.
3. Verify: Confirm success output.

### Make suggested redlines (Workaround)
1. Resolve the document ID.
2. Draft the redlines and reasoning locally.
3. Run `docs-write --doc <DOC_ID> --file redlines.md --append` to inject the suggestions at the end of the document.
4. Run `docs-comments-add --doc <DOC_ID> --content 'I have appended my suggested redlines and reasoning to the bottom of this document for your review.'` to notify the author.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account lacks share access | Ask the user to share the Google Doc with the agent's Workspace email address (shown in the error response). |
| `404 notFound` | Invalid document ID | Run `drive-search` to find the correct document name and locate the fresh ID. |
| `429 rateLimitExceeded` | Too many Docs API requests | Wait 30 seconds, then retry the edit once. |
| Text overwritten | Ran `docs-write` without `--append` | Restore previous text using Google Drive version history if available, or recreate it from your task logs. |
| `docs-tab-finalize` reports `0 occurrences` for an approved change | Original tab text was modified after suggestion was created | Re-read the original tab, find current text, apply manually with `docs-find-replace` |
| `docs-tab-suggest` returns `text_not_found` | Text already changed by a prior suggestion in the same session | Re-read the suggestion tab with `docs-get` to get current text after prior edits |
| `docs-tab-clone` creates tab but text is empty | Source tab has content primarily in tables/images | Clone preserves paragraph text only; note this to the human |
| No strikethrough detected on any checklist items after human checked some | `BULLET_CHECKBOX` created non-strikethrough variant | Switch `docs-tab-finalize` to ✅ fallback mechanism (see plan) |

## Decision Framework

| Signal in the task | Pattern | Tools |
|---|---|---|
| "Edit", "update", "fix", "format" — agent has authority | **Direct Edit** | `docs-batch-update`, `docs-insert`, `docs-find-replace` |
| "Review", "suggest", "propose" — needs approval | **Tab-Based Suggestion** | `docs-tab-clone` → `docs-tab-suggest` × N → human reviews → `docs-tab-finalize` |
| Heavy rewrite, full restructure | **Shadow Copy** | `drive-copy` → edit copy → compare link |
| Template application, format conversion | **DOCX Round-Trip** | `docs-export` → local processing → `drive-upload` |

## Examples

### Example: Tab-based document review with inline approve/deny
  Task: "Review Q3 Strategy and suggest improvements"

  Step 1: docs-tab-list abc123
  → {tabs: [{tabId: "t.0", title: "Q3 Strategy"}]}

  Step 2: docs-tab-clone --doc abc123 --source-tab t.0
  → {suggestionTabId: "t.new1", suggestionTabTitle: "✏️ Edits — Q3 Strategy"}

  Step 3: docs-tab-suggest --doc abc123 --source-tab t.0 --suggestion-tab t.new1 \
    --find "We will probably finish by Q4" --replace "We project completion by end of Q4" --reason "Remove hedging"
  → {changeId: 1}

  Step 4: docs-tab-suggest ... (change 2)
  Step 5: docs-tab-suggest ... (change 3)

  Step 6: docs-comments-add --doc abc123 --content "📋 I've prepared 3 suggested edits in the '✏️ Edits — Q3 Strategy' tab. Changes are highlighted yellow. Check any to reject. Reply here when done."
  → mission enters needs_input

  (Human reviews: accepts changes 1 and 3, checks checkbox on change 2 to reject it, replies "done")

  Step 7: docs-tab-finalize --doc abc123 --source-tab t.0 --suggestion-tab t.new1
  → {applied: [{changeId: 1}, {changeId: 3}], rejected: [{changeId: 2}], tabDeleted: true}

  Outcome: Changes 1 and 3 applied to original tab. Change 2 skipped. Suggestion tab removed. One comment resolved.

### Example: Create a document and write content
```
Task: "Create a new document called 'Project Plan' and add the project overview."

Step 1: docs-create --title "Project Plan" --body "Project Overview:" --folder 12345_folder_id
→ Result: { "id": "doc_abc123_id", "title": "Project Plan", "url": "https://docs.google.com/document/d/doc_abc123_id/edit" }

Step 2: docs-write --doc doc_abc123_id --text "\n\nPhase 1: Build the prototype." --append
→ Result: Success

Outcome: Document created and text appended.
```

### Example: Find and replace text in a document
```
Task: "Update the document 'Pricing Model' to replace 'USD' with 'EUR'."

Step 1: docs-find-replace --doc doc_pricing_id --find "USD" --replace "EUR"
→ Result: { "replacements": 4, "success": true }

Outcome: 4 instances of "USD" replaced with "EUR".
```

### Example: Recovering from Access Denied
```
Task: "Read the contents of the document with ID '1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk'."

Step 1: docs-cat 1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk
→ Result: { "status": "access_denied", "docId": "1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk", "message": "Doc access denied. Share with assistant-agent-millie@tachin.ag" }

Step 2: GChat message to user: "Hey there! I tried to read the document you shared, but it looks like I don't have access. Could you please share it with assistant-agent-millie@tachin.ag with Commenter or Editor access?"

Outcome: Agent correctly flags the permissions issue to the user and provides their email address for sharing.
```
