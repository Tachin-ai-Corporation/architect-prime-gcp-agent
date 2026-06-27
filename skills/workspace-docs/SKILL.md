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
- `docs-write --doc <doc_id> --text "CONTENT" [--append]` — Write text to the document. If `--append` is true, appends to the end; otherwise, overwrites the entire document body.
  Output: Success confirmation.
- `docs-find-replace --doc <doc_id> --find "OLD" --replace "NEW" [--match-case]` — Find and replace text inside the document.
  Output: Confirmation with replacement counts.
- `docs-comments-add --doc <doc_id> --content "TEXT"` — Add a document-level comment to the Doc.
  Output: Success confirmation.

## Important Notes
- **Document IDs:** Extract document IDs from Docs URLs. The ID is the long string of alphanumeric characters between `/d/` and `/edit` in the address bar.
- **Accidental Overwrites:** Using `docs-write` without `--append` will wipe the existing document text. Always check if you should use `--append`.

## Procedures

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

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account lacks share access | Ask the user to share the Google Doc with the agent's Workspace email address (shown in the error response). |
| `404 notFound` | Invalid document ID | Run `drive-search` to find the correct document name and locate the fresh ID. |
| `429 rateLimitExceeded` | Too many Docs API requests | Wait 30 seconds, then retry the edit once. |
| Text overwritten | Ran `docs-write` without `--append` | Restore previous text using Google Drive version history if available, or recreate it from your task logs. |

## Examples

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

Step 2: GChat message to user: "Hey there! I tried to read the document you shared, but it looks like I don't have access. Could you please share it with assistant-agent-millie@tachin.ag with Editor/Viewer access?"

Outcome: Agent correctly flags the permissions issue to the user and provides their email address for sharing.
```
