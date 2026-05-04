# Skill: Google Docs

## What this skill does
Create, read, write, and annotate Google Docs. Read document content,
create new documents, replace or append text, find-and-replace, and
manage comments for review workflows.

## When to use
- User asks to create a document, memo, or report
- Task requires reading or editing an existing Google Doc
- Need to do find-and-replace across a document
- Review workflow: listing or adding comments on a doc

## Tools (dispatched to motor for writes, temporal-memory for reads)

### Read
- `docs-cat <doc_id>` — read a document's full text
- `docs-comments-list --doc <doc_id> [--include-resolved]` — list comments

### Write
- `docs-create --title "Name" [--body "Initial text"] [--folder FOLDER_ID]` — create a new doc
- `docs-write --doc <doc_id> --text "Content" [--append]` — replace or append body text
- `docs-find-replace --doc <doc_id> --find "old" --replace "new" [--match-case]` — find and replace
- `docs-comments-add --doc <doc_id> --content "Review note"` — add a comment

## Important Notes
- Extract document IDs from Google Docs URLs: the ID is the long string after `/d/`.
- Comments created via API appear as document-level comments (Google API limitation).
- `docs-write` without `--append` clears existing content first.

## Auth
All tools authenticate via DWD using the agent's Workspace email.
No API keys or OAuth tokens needed.
