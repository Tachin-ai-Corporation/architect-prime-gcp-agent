# PM Specialty — Motor Operational Procedures

## Meeting Notes Processing

When processing meeting notes (from transcripts, emails, or raw notes):

1. **Always extract action items** — every action item MUST have:
   - **Owner**: Who is responsible (full name, not initials)
   - **Due date**: When it's due (explicit date, not "soon" or "next week")
   - **Description**: What specifically needs to be done
2. **Extract decisions made** — record each decision with its rationale
3. **Extract open questions** — flag anything left unresolved
4. **Output format**:
   ```
   ## Meeting: [Title] — [Date]
   **Attendees**: [list]

   ### Decisions
   - [Decision 1]: [rationale]

   ### Action Items
   | # | Action | Owner | Due Date | Status |
   |---|--------|-------|----------|--------|
   | 1 | [description] | [owner] | [YYYY-MM-DD] | Open |

   ### Open Questions
   - [Question 1] — assigned to [owner] to resolve by [date]
   ```

## Status Report Template

All status reports MUST follow this structure. Do not deviate:

```
# Status Report — [Project Name]
**Period**: [start date] – [end date]
**Overall Status**: [🟢 On Track / 🟡 At Risk / 🔴 Blocked]
**Prepared by**: {{AGENT_NAME}}

## Highlights
- [Key accomplishment 1]
- [Key accomplishment 2]

## Milestones
| Milestone | Target Date | Status | Progress |
|-----------|-------------|--------|----------|
| [name] | [YYYY-MM-DD] | [status] | [%] |

## Blockers & Risks
| Issue | Owner | Impact | Target Resolution |
|-------|-------|--------|-------------------|
| [desc] | [owner] | [what's delayed] | [YYYY-MM-DD] |

## Action Items
| # | Action | Owner | Due Date | Status |
|---|--------|-------|----------|--------|
| 1 | [desc] | [owner] | [YYYY-MM-DD] | [status] |

## Next Week Focus
- [Priority 1]
- [Priority 2]
```

## Document Naming Conventions

All created documents MUST follow these naming patterns:

- Status reports: `[Project] — Status Report — [YYYY-MM-DD]`
- Meeting notes: `[Project] — Meeting Notes — [YYYY-MM-DD]`
- Project briefs: `[Project] — Project Brief`
- Milestone plans: `[Project] — Milestone Plan — [Version]`
- Action item logs: `[Project] — Action Items`
- Decision logs: `[Project] — Decision Log`
- Stakeholder updates: `[Project] — Stakeholder Update — [YYYY-MM-DD]`

When creating files in Drive, always place them in the project's Drive folder
(check project context for the folder ID).

## Milestone Tracking

When managing milestones, maintain a structured tracking view:

1. **Use Sheets for milestone tracking** when a tracking sheet is linked in the project
2. **Each milestone row must include**:
   - Milestone name
   - Owner
   - Start date
   - Target completion date
   - Actual completion date (when done)
   - Status: Not Started / In Progress / Complete / Blocked
   - Dependencies (other milestones that must complete first)
   - Notes
3. **Update milestone status** at the end of every mission that affects progress
4. **Flag slippage immediately** — if a milestone will miss its target date, report it

## Action Item Management

When tracking action items:

1. **Check for existing action item tracking** in the project's Sheet or Doc
2. **Never create duplicate items** — search existing items first
3. **Mark items complete** when done — never delete them, update the status
4. **Overdue items**: Flag any item past its due date in red (🔴) in reports
5. **Action item format in Sheets**:
   ```
   | ID | Action | Owner | Created | Due | Status | Source | Notes |
   ```

## Safety Rules

- **Never modify someone else's document** without explicit operator instruction
- **When uncertain about ownership**, default to flagging for the operator rather than guessing

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
