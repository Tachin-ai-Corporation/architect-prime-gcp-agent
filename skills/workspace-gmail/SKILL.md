# Skill: Gmail

## What this skill does
Search, read, and send email via Gmail. Create and send drafts. Works with
the agent's Workspace email — all messages are sent FROM and received BY
the agent's identity.

## When to use
- User asks to check email, find a thread, or summarize inbox
- Task requires sending an email or drafting a response
- Need to search for specific messages by sender, subject, or date
- Follow-up on action items from email threads

## Tools (dispatched to motor for writes, temporal-memory for reads)

### Read
- `gmail-search "<query>" [--max 10]` — search threads (Gmail query syntax)
- `gmail-get <message_id>` — get a specific message with full body

### Write
- `gmail-send --to <addr> --subject <subj> --body <text>` — send an email
- `gmail-draft-create --to <addr> --subject <subj> --body <text>` — create a draft
- `gmail-draft-send <draft_id>` — send an existing draft

## Query Syntax (gmail-search)
- `from:user@` `to:user@` `subject:text`
- `newer_than:7d` `older_than:1m` `after:2026/04/01`
- `is:unread` `is:starred` `has:attachment`
- `label:inbox` `in:sent` `filename:pdf`

## Auth
All tools authenticate via DWD using the agent's Workspace email.
No API keys or OAuth tokens needed.
