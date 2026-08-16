# Skill: Gmail (read-only)

## When to Use
When a task involves **reading or searching** email in Gmail.

Agents do **not** send email — the mouth is the sole outbound egress (C-27). If a task asks you to send or reply to an email, you cannot deliver it: report that outbound email is not an agent capability and surface the composed text back to cortex.

## Commands

### Read
- `gmail-search "<query>" [--max 10]` — Search email threads using standard Gmail search operators.
  Output: JSON array of matching thread/message items containing `id`, `threadId`, `subject`, `from`, `date`, and `snippet`.
- `gmail-get <message_id>` — Get details of a specific email message, including headers and full body content.
  Output: Complete email message payload.

## Query Syntax (gmail-search)
- `from:user@example.com` — Emails sent by a specific sender.
- `to:user@example.com` — Emails sent to a specific recipient.
- `subject:text` — Search subject line text.
- `newer_than:7d` / `older_than:1m` / `after:2026/04/01` — Date filtering.
- `is:unread` / `is:starred` — Read/unread or star state.
- `label:inbox` / `in:sent` — Folder location checks.
- `has:attachment` — Filter emails containing attachments.

## Procedures

### Search and read recent emails
1. Run `gmail-search "subject:'<keyword>' from:'<sender>'"` to retrieve matching messages.
2. If no results, widen the query to just keywords: `gmail-search "<keyword>"`
3. Select the most recent relevant message ID from the search results.
4. Run `gmail-get <MESSAGE_ID>` to read the full body content.
5. Verify: Check that the subject, sender, and body content match the search criteria.

## Not Available (C-27)
Sending, drafting, and replying to email are **not** agent capabilities. `gmail-send`, `gmail-draft-create`, and `gmail-draft-send` have been removed, and the agent DWD token is not authorized for Gmail send scopes. The mouth is the only outbound channel; it reaches humans via Google Chat and the dashboard, not Gmail. Outbound email returns only if/when the mouth gains a dedicated email egress channel.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `400 invalidArgument` | Bad search syntax | Ensure operators and quotes are balanced. |
| `404 notFound` | Wrong message ID | Re-run `gmail-search` to obtain the correct, active ID. |
| `403 forbidden` | Domain policy or credential restrictions | Report the credential or domain policy issue to the operator. |
| Empty search results | Query too specific | Remove terms like `is:unread` or `newer_than` to broaden results. |
