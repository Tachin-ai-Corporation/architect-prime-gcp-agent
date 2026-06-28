# Skill: Google Docs

> [!IMPORTANT]
> **Execution Instructions**: All commands listed below are CLI scripts. You MUST execute them using the `runCommand` tool. Do NOT try to invoke them as native functions or tools, and do NOT hallucinate their JSON responses. Run the command using `runCommand` and wait for the actual output.

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
- `docs-tab-suggest --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id> --file <suggestions.json>` — Make tracked edits in batch. `suggestions.json` should contain an array of `{"find": "ORIGINAL", "replace": "NEW", "reason": "WHY"}`. Does not touch original tab.
  Output: JSON with applied changes array and not_found array.
- `docs-tab-finalize --doc <doc_id> --source-tab <tab_id> --suggestion-tab <tab_id>` — Finalize reviewed suggestions: apply approved changes to the original tab (unchecked = approved, checked/strikethrough = rejected), delete the suggestion tab, resolve the review comment.
  Output: JSON summary of applied and rejected changes.

## Important Notes
- **Document IDs:** Extract document IDs from Docs URLs. The ID is the long string of alphanumeric characters between `/d/` and `/edit` in the address bar.
- **Accidental Overwrites:** Using `docs-write` without `--append` will wipe the existing document text. Always check if you should use `--append`.
- **Suggesting Mode / Redlines (API Limitation):** The Google Docs API **does NOT support** native "Suggesting Mode" or anchored comments. All API writes are permanent changes. To make "suggestions" or "redlines", you MUST append a `[LEGAL REVIEW REDLINES]` or `[PROPOSED CHANGES]` section to the bottom of the document using `docs-write --append`, and leave a document-level comment pointing to it using `docs-comments-add`. Never try to turn on suggestion mode.
- **Tab-based suggestions:** Agents use a clone-edit-finalize workflow via document tabs. The suggestion tab displays changes inline: the new text is highlighted yellow and is immediately followed by a marker like `📝[☐ Reject (was: "OLD" -> "NEW")]`. The human can reject a change by changing `☐` to `☑` or by striking through the marker using Google Docs strikethrough formatting (Alt+Shift+5). Unchecked/un-struck items are applied to the original tab on finalization. One comment total.
- **Tab IDs in batchUpdate:** Include `tabId` in every `location` and `range` object when targeting a specific tab. Omitting `tabId` defaults to the first tab.
- **Tab-scoped replaceAllText:** Use `tabsCriteria: {tabIds: ["TAB_ID"]}` to scope replacements to one tab. Without `tabsCriteria`, `replaceAllText` applies across ALL tabs.

## Procedures

### Suggest edits via tab-based review
1. Execute `runCommand({"command": "docs-tab-list <DOC_ID>"})` to find the target tab's ID.
2. Execute `runCommand({"command": "docs-tab-clone --doc <DOC_ID> --source-tab <TAB_ID>"})`.
3. Create a JSON file (e.g., `suggestions.json`) containing an array of your edits: `[{"find": "...", "replace": "...", "reason": "..."}]`.
4. Execute `runCommand({"command": "docs-tab-suggest --doc <DOC_ID> --source-tab <TAB_ID> --suggestion-tab <NEW_TAB_ID> --file suggestions.json"})`.
5. Post one comment: `docs-comments-add --doc <DOC_ID> --content "📋 I've prepared N suggested edits in the '✏️ Edits — TAB_NAME' tab. Changes are applied inline and highlighted yellow. To reject a change, either change the ☐ to a ☑, or apply Strikethrough to the marker. Reply here when done."`.
6. Wait for the human to reply (mission enters needs_input).
7. On reply: execute `runCommand({"command": "docs-tab-finalize --doc <DOC_ID> --source-tab <TAB_ID> --suggestion-tab <NEW_TAB_ID>"})`.
8. Report summary: which changes were applied, which rejected.

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
| Reject markers not being processed | User deleted the marker instead of checking/striking it | If deleted, it defaults to approved. Train the human to use strikethrough instead. |

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

  Step 1: Execute `runCommand({"command": "docs-tab-list abc123"})`
  Output received: `{"tabs": [{"tabId": "t.0", "title": "Q3 Strategy"}]}`

  Step 2: Execute `runCommand({"command": "docs-tab-clone --doc abc123 --source-tab t.0"})`
  Output received: `{"suggestionTabId": "t.new1", "suggestionTabTitle": "✏️ Edits — Q3 Strategy"}`

  Step 3: Write suggestions to `suggestions.json`
  ```json
  [
    {
      "find": "We will probably finish by Q4",
      "replace": "We project completion by end of Q4",
      "reason": "Remove hedging"
    }
  ]
  ```

  Step 4: Execute `runCommand({"command": "docs-tab-suggest --doc abc123 --source-tab t.0 --suggestion-tab t.new1 --file suggestions.json"})`
  Output received: `{"status": "suggested", "applied": [{"changeId": 1, "find": "...", "replace": "..."}], "not_found": []}`

  Step 5: Execute `runCommand({"command": "docs-comments-add --doc abc123 --content \"📋 I've prepared suggested edits in the '✏️ Edits — Q3 Strategy' tab. Changes are applied inline and highlighted yellow. To reject a change, apply Strikethrough to the marker. Reply here when done.\""})`
  Output received: Success (mission enters needs_input)

  (Human reviews: accepts changes 1 and 3, applies strikethrough to change 2 to reject it, replies "done")

  Step 6: Execute `runCommand({"command": "docs-tab-finalize --doc abc123 --source-tab t.0 --suggestion-tab t.new1"})`
  Output received: `{"applied": [{"changeId": 1}, {"changeId": 3}], "rejected": [{"changeId": 2}], "tabDeleted": true}`

  Outcome: Changes 1 and 3 applied to original tab. Change 2 skipped. Suggestion tab removed. One comment resolved.

### Example: Create a document and write content
```
Task: "Create a new document called 'Project Plan' and add the project overview."

Step 1: docs-create --title "Project Plan" --body "Project Overview:" --folder 12345_folder_id
Output received: { "id": "doc_abc123_id", "title": "Project Plan", "url": "https://docs.google.com/document/d/doc_abc123_id/edit" }

Step 2: docs-write --doc doc_abc123_id --text "\n\nPhase 1: Build the prototype." --append
Output received: Success

Outcome: Document created and text appended.
```

### Example: Find and replace text in a document
```
Task: "Update the document 'Pricing Model' to replace 'USD' with 'EUR'."

Step 1: docs-find-replace --doc doc_pricing_id --find "USD" --replace "EUR"
Output received: { "replacements": 4, "success": true }

Outcome: 4 instances of "USD" replaced with "EUR".
```

### Example: Recovering from Access Denied
```
Task: "Read the contents of the document with ID '1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk'."

Step 1: docs-cat 1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk
Output received: { "status": "access_denied", "docId": "1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk", "message": "Doc access denied. Share with assistant-agent-millie@example.com" }

Step 2: GChat message to user: "Hey there! I tried to read the document you shared, but it looks like I don't have access. Could you please share it with assistant-agent-millie@example.com with Commenter or Editor access?"

Outcome: Agent correctly flags the permissions issue to the user and provides their email address for sharing.
```
