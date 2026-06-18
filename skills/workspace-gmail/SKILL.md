# Skill: Gmail

## When to Use
When a task involves sending, reading, searching, or drafting emails in Gmail.

## Commands

### Read
- `gmail-search "<query>" [--max 10]` — Search email threads using standard Gmail search operators.
  Output: JSON array of matching thread/message items containing `id`, `threadId`, `subject`, `from`, `date`, and `snippet`.
- `gmail-get <message_id>` — Get details of a specific email message, including headers and full body content.
  Output: Complete email message payload.

### Write
- `gmail-send --to <addr> --subject <subj> --body <text>` — Send a new email.
  Output: Sent message details including the created message `id` and `threadId`.
- `gmail-draft-create --to <addr> --subject <subj> --body <text>` — Create a draft email.
  Output: Created draft details including `id` and message `id`.
- `gmail-draft-send <draft_id>` — Send an existing draft.
  Output: Sent message details.

## Query Syntax (gmail-search)
- `from:user@domain.com` — Emails sent by a specific sender.
- `to:user@domain.com` — Emails sent to a specific recipient.
- `subject:text` — Search subject line text.
- `newer_than:7d` / `older_than:1m` / `after:2026/04/01` — Date filtering.
- `is:unread` / `is:starred` — Read/unread or star state.
- `label:inbox` / `in:sent` — Folder location checks.
- `has:attachment` — Filter emails containing attachments.

## Procedures

### Search and read recent emails
1. Run `gmail-search "subject:'<keyword>' from:'<sender>'"` to retrieve matching messages.
2. Under no results, widen the query to just search keywords: `gmail-search "<keyword>"`
3. Select the most recent relevant message ID from the search results.
4. Run `gmail-get <MESSAGE_ID>` to read the full body content.
5. Verify: Check that the subject, sender, and body content match the search criteria.

### Send a new email
1. Run `gmail-send --to <email> --subject '<subject>' --body '<body>'`.
2. Verify: Ensure the command returns a success response with a valid message ID.

### Create and send a draft
1. Run `gmail-draft-create --to <email> --subject '<subject>' --body '<body>'`.
2. Record the draft ID returned from the response.
3. If review is required, pause and request confirmation. Otherwise, proceed to send.
4. Run `gmail-draft-send <DRAFT_ID>` to dispatch the draft email.
5. Verify: Confirm the output displays the sent message ID.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `400 invalidArgument` | Malformed recipient email address or bad search syntax | Verify recipient email syntax. For queries, ensure operators and quotes are balanced. |
| `404 notFound` | Wrong message ID or draft ID | Re-run `gmail-search` to obtain the correct, active ID. |
| `403 forbidden` | Domain policy or credential restrictions | Report the credential or domain policy issue to the operator. |
| Empty search results | Search query too specific | Remove query terms like `is:unread` or `newer_than` to broaden results. |

## Examples

### Example: Find and read status update
```
Task: "Find the latest project status email from alice@company.com and read it."

Step 1: gmail-search "from:alice@company.com project status" --max 1
→ Result: [{ "id": "msg123abc", "subject": "Project Status Update", "from": "alice@company.com", "snippet": "Here is the weekly update..." }]

Step 2: gmail-get msg123abc
→ Result: { "id": "msg123abc", "subject": "Project Status Update", "body": "Hi team, Here is the weekly update. The launch is scheduled for tomorrow..." }

Outcome: Email found and read successfully.
```

### Example: Create a draft email
```
Task: "Draft a follow-up email to bob@company.com regarding the review."

Step 1: gmail-draft-create --to bob@company.com --subject "Review Follow-up" --body "Hi Bob, I wanted to follow up on the status of our Q3 review. Let me know if you need anything."
→ Result: { "id": "draft789xyz", "message": { "id": "msg987dfg", "to": "bob@company.com" } }

Outcome: Draft draft789xyz created successfully.
```
