# Skill: Meeting Operations

## When to Use
When processing meeting notes, extracting action items, preparing agendas, or writing status reports.

## Commands

No custom corekit scripts are governed directly by this skill (handled via workspace tools).

## Procedures

### Extract action items from meeting notes
1. Read the raw notes or transcription in full.
2. Identify all statements that imply commitment, assignment, decision, or blocker.
3. Format each element according to the tracking table format:
   - Action items: `- [ ] [OWNER] Task description (due: DATE)`
   - Decisions: `✅ DECISION: Description`
   - Blockers: `🚫 BLOCKER: Description (owner: NAME)`
   - Follow-ups: `📋 FOLLOW-UP: Topic (by: DATE)`
4. Group the action items by owner for reporting.
5. Verify: Write them to the project's action item tracker Sheet or document.

### Compile and publish status reports
1. Query active milestoness and project status from Sheets or logs.
2. Format the report using the periodic status report markdown template.
3. List completed tasks under Highlights, update the Milestones table, list any active Blockers, and outline new Action Items.
4. Verify: Ensure all dates follow the `YYYY-MM-DD` format and verify that no blocker is listed without an owner.

### Action item management and tracking
1. Check the tracking Sheet for current items using `sheets-read --range "Action Items!A:F"`.
2. Append new items using `sheets-append --range "Action Items!A:F" --values "[[...]]"`.
3. Check for overdue items (items past due date → flag as `⚠️ OVERDUE`, items with no owner → flag as `❓ UNOWNED`, items older than 14 days with no update → flag as `🔴 STALE`).
4. Verify: Update the status column using `sheets-update` when a task is completed.

---

## Detailed Reference

### Status Report Template
```markdown
# Status Report — [Project Name] — [Date]

## Highlights
- Key accomplishment 1

## Milestones

| Milestone | Target | Status | Notes |
|-----------|--------|--------|-------|
| Phase 1 complete | 2026-06-01 | ✅ On track | |
| API integration | 2026-06-15 | ⚠️ At risk | Blocked on IAM |

## Blockers
1. [BLOCKER] Description — Owner: NAME — Impact: DESCRIPTION

## Action Items (New)
- [ ] [OWNER] Item (due: DATE)

## Next Week
- Planned activity 1
```

### Agenda Preparation Template
```markdown
# Meeting Agenda — [Date] [Time]

## Roll Call & Previous Action Items (5 min)
- Review items from last meeting

## Status Updates (15 min)
- [Workstream 1]: Brief update

## Discussion Items (20 min)
1. [Topic] — Presenter: [NAME] — Decision needed: [Y/N]

## New Action Items (5 min)
- Capture and assign
```

## Safety Rules
- Always attribute action items to a specific owner — never leave unowned
- Always include due dates — never leave open-ended
- Verify meeting attendee names before attributing action items
- Do not fabricate decisions — only record what was explicitly decided
- Date format: always YYYY-MM-DD for consistency

---

## Document Naming Conventions

All created PM documents MUST follow these naming patterns:

- Status reports: `[Project] — Status Report — [YYYY-MM-DD]`
- Meeting notes: `[Project] — Meeting Notes — [YYYY-MM-DD]`
- Project briefs: `[Project] — Project Brief`
- Milestone plans: `[Project] — Milestone Plan — [Version]`
- Action item logs: `[Project] — Action Items`
- Decision logs: `[Project] — Decision Log`
- Stakeholder updates: `[Project] — Stakeholder Update — [YYYY-MM-DD]`

When creating files in Drive, place them in the project's Drive folder (check project context for the folder ID; the workspace-drive skill's standard publisher resolves it automatically).

### Meeting Notes Output Template
```markdown
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
Record each decision with its rationale; flag anything left unresolved as an open question with an owner and a resolve-by date.

### Milestone tracking
1. When a tracking sheet is linked in the project context, maintain milestones there (use the workspace-sheets tools).
2. Each milestone row must include: milestone name, owner, start date, target completion date, actual completion date (when done), status (Not Started / In Progress / Complete / Blocked), dependencies (milestones that must complete first), and notes.
3. Update milestone status at the end of every mission that affects progress.
4. Verify: If a milestone will miss its target date, flag the slippage immediately in the mission report — never leave a stale target date.
