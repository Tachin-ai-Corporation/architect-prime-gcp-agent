# Assistant Specialty — Motor Operational Procedures

## Timezone-Aware Scheduling

When creating or updating calendar events:

1. **Determine timezone** from IDENTITY.md (e.g. timezone field) or MEMORY.md
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

## Email — Read-Only (C-27)

The mouth is the sole outbound egress, so the assistant **never sends email**. Gmail is inbound-only.

```bash
# Find mail, then read the body
gmail-search --query "from:person@example.com newer_than:7d" --max-results 5
gmail-get <MESSAGE_ID>
```

- The send/draft tools (`gmail-send`, `gmail-draft-create`, `gmail-draft-send`) are **removed** — do not call them.
- If a task asks you to "email someone", you cannot deliver it. Surface the composed message text back to cortex; outbound delivery is the mouth's job (today it reaches humans via Chat/dashboard, not Gmail). Report the limitation plainly rather than claiming a send.
- Composing-and-sending email returns as an assistant capability only when the mouth gains an email egress channel.

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

## Workspace Convention

### Git Workspace (Primary — automatic)
The Brain daemon automatically manages your git workspace for project missions:
- **Clone + branch**: On mission start, the daemon clones the project repo — its `main` branch plus your `mission/{missionId}` branch — into `shared/{missionId}/`. You do NOT need to re-clone it.
- **Inputs are NOT auto-present**: Do not assume that files produced by an upstream teammate, or files named in your delegated instruction, are already in that clone. Before you depend on a named input file, verify it exists in your workspace; if it does not, obtain it as your instruction directs (e.g. the shared Project-Context workspace, or the git ref named in the instruction), then proceed.
- **Commit + sync**: After each checkpoint, your work is committed and synced to the git ether
- **Merge**: On mission completion, your branch is merged to `main`
- Write all work products to the `shared/{missionId}/` directory — they are automatically tracked
- Use `work-status` to check uncommitted changes, `work-diff` to review, `work-log` to see history

### Drive Workspace (Stakeholder-Facing)
- **Publish artifacts**: Use `work-publish` for sharing work products with stakeholders via Drive
- **Project work**: `work-publish <file> --project <project-id>` → uploads to `{project}/{MM-DD}/`
- **Personal work**: `work-publish <file>` → uploads to `{prime}/{agent}/{MM-DD}/`
- **Read/browse**: Use `drive-ls`, `drive-download`, `drive-search` as normal
- Drive publishing also happens automatically on mission completion

## Project Context Discovery

When you discover a fact about a project during execution that would help future missions, persist it immediately:

| Discovery Type | Command |
|---|---|
| Permission requirement | `project-manage add-context '<project_id>' '<key>' '<what you learned>'` |
| Working command/path | `project-manage add-context '<project_id>' '<key>' '<verified command or path>'` |
| Resource ID (Drive folder, URL) | `project-manage add-context '<project_id>' '<key>' '{"kind":"drive_folder","ref":"<id>","summary":"<description>"}'` |
| Failure mode | `project-manage add-context '<project_id>' '<key>' 'AVOID: <what failed and why>'` |

Examples of useful discoveries:
- `sync_folder_requires_editor` → "Editor access required for all agents uploading to sync folder"
- `deploy_command_verified` → "firebase deploy --project your-website-project --only hosting"
- `staging_url` → "your-website-project--staging-abc123.web.app"
- `css_build_step_required` → "Must run npm run build before deploying; raw source files won't work"

**Rule:** If you learn something that would save the next agent time on this project, write it to project context. Don't rely on mission output alone — context is the project's institutional memory.
