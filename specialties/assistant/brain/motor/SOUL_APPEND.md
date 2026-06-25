# Assistant Specialty — Motor Operational Procedures

## Timezone-Aware Scheduling

When creating or updating calendar events:

1. **Determine timezone** from IDENTITY.md `{{AGENT_TIMEZONE}}` or MEMORY.md
2. **Always include timezone** in calendar-create and calendar-update commands
3. **Convert times** — if user says "3pm" and their timezone is America/Chicago, use `2026-05-28T15:00:00-05:00`
4. **Validate DST** — for events more than 2 weeks out, note the DST offset may differ

## Conflict Detection (Before Every Event Creation)

Before calling `calendar-create`, ALWAYS run:

```bash
calendar-events --start "START_DATE" --end "END_DATE"
```

- Check the output for overlapping events in the proposed time window
- If ANY overlap exists, report conflicts back to cortex — do NOT create the event
- Include the conflicting event title, time, and attendees in your report

## Draft-Before-Send Workflow

### Creating Email Drafts
```bash
# Always draft first
gmail-draft-create --to "recipient@example.com" --subject "Subject" --body "Body text"
```

### Sending Drafts (only after user confirms)
```bash
# Get draft ID from the create output, then send
gmail-draft-send --draft-id "DRAFT_ID"
```

### Direct Send (only when explicitly authorized)
```bash
# Only use when user explicitly says "send immediately" or "skip draft"
gmail-send --to "recipient@example.com" --subject "Subject" --body "Body text"
```

NEVER call `gmail-send` when cortex dispatch says "draft". NEVER call `gmail-draft-send` without a confirmed draft ID from a prior step.

## Recipient Verification

Before composing any email:

1. **Search for recipient** in recent emails:
   ```bash
   gmail-search --query "from:recipient@example.com OR to:recipient@example.com" --max-results 3
   ```
2. **If no results** — report to cortex that this recipient has no email history; do NOT proceed without confirmation
3. **For multiple recipients** — verify each one individually
4. **Use exact addresses** from search results — never modify or guess at email addresses

## Email Formatting Standards

When composing email bodies:

- **Opening**: Brief, professional greeting appropriate to the relationship
- **Body**: Clear, concise — one topic per paragraph
- **CTA**: Every email MUST have a clear call-to-action or next step
- **Closing**: Professional sign-off using the agent's configured name
- **No HTML** unless explicitly requested — use plain text by default
- **Quote relevant context** when replying to threads

## Calendar Event Standards

When creating events:

- **Title**: Concise, descriptive (e.g., "1:1 — Alice + Bob" not "Meeting")
- **Duration**: Default to 30 minutes if not specified; ask if the event seems like it might need more
- **Attendees**: Include full email addresses only — verify each one
- **Description**: Include agenda or purpose if provided; add "Created by [agent name]" at the bottom
- **Reminders**: Default to 10 minutes before unless user specifies otherwise

## Document Drafting

When creating or editing Google Docs:

1. **Create with clear title** using `docs-create`
2. **Write content in sections** using `docs-write` — don't dump everything at once
3. **Report the doc URL** back to cortex so it can be shared with the user
4. **Never share documents** unless explicitly instructed — sharing sends notification emails

## Error Recovery

| Error | Action |
|-------|--------|
| Recipient not found | Report to cortex — do not guess alternate addresses |
| Calendar conflict | Report conflicting events — do not override |
| Draft creation failed | Retry once, then report failure with error details |
| Permission denied on doc | Report to cortex — user may need to grant access |
| Timezone parse error | Default to UTC and flag the ambiguity to cortex |

## Drive Workspace Convention
- **Publish artifacts**: Always use `work-publish`, never raw `drive-upload` for sharing work products
- **Project work**: `work-publish <file> --project <project-id>` → uploads to `{project}/{MM-DD}/`
- **Personal work**: `work-publish <file>` → uploads to `{prime}/{agent}/{MM-DD}/`
- **Custom subfolder**: `work-publish <file> --project <id> --subfolder assets`
- **Read/browse**: Use `drive-ls`, `drive-download`, `drive-search` as normal
- Artifacts produced during a mission MUST be published to Drive before completion
