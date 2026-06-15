# Skill: Meeting Operations

## What this skill does
Meeting management procedures — notes extraction, action item tracking, agenda preparation, status report templates

## When to use
When processing meeting notes, extracting action items, preparing agendas, or writing status reports

Use these procedures when processing meeting notes, managing action items, or writing status reports.

## Meeting Notes Processing

When you receive meeting notes (raw text, email, or transcription), extract:

| Element | Format | Example |
|---------|--------|---------|
| **Action items** | `- [ ] [OWNER] Task description (due: DATE)` | `- [ ] [Alice] Deploy staging env (due: 2026-06-01)` |
| **Decisions** | `✅ DECISION: Description` | `✅ DECISION: Use Cloud Run for new API service` |
| **Blockers** | `🚫 BLOCKER: Description (owner: NAME)` | `🚫 BLOCKER: Missing GCS write permissions (owner: Ops)` |
| **Follow-ups** | `📋 FOLLOW-UP: Topic (by: DATE)` | `📋 FOLLOW-UP: Review cost estimates (by: Friday)` |

### Extraction Procedure
1. Read the raw notes in full
2. Identify all statements that imply commitment, assignment, or decision
3. Format each as structured action items using the template above
4. Group by owner for reporting
5. Write to the project's action item tracker (Sheets) if available

## Status Report Template

Use this template for all weekly/periodic status reports:

```markdown
# Status Report — [Project Name] — [Date]

## Highlights
- Key accomplishment 1
- Key accomplishment 2

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
- Planned activity 2
```

## Action Item Management

### Creating action items
```
Format: - [ ] [OWNER] Description (due: YYYY-MM-DD) — Source: [meeting/request/review]
```

### Tracking commands
When using Google Sheets for tracking:
- Read existing items: `sheets-read --range "Action Items!A:F"`
- Append new items: `sheets-append --range "Action Items!A:F" --values "[...]"`
- Update status: `sheets-update --range "Action Items!E{ROW}" --values "[\"Done\"]"`

### Overdue detection
- Items past due date → flag as `⚠️ OVERDUE`
- Items with no owner → flag as `❓ UNOWNED`
- Items older than 14 days with no update → flag as `🔴 STALE`

## Agenda Preparation

### Pre-meeting checklist
1. Review previous meeting's action items
2. Check for unresolved blockers
3. Identify items needing decisions
4. Prepare status summary for each workstream
5. List new topics from recent communications

### Agenda format
```markdown
# Meeting Agenda — [Date] [Time]

## Roll Call & Previous Action Items (5 min)
- Review items from last meeting

## Status Updates (15 min)
- [Workstream 1]: Brief update
- [Workstream 2]: Brief update

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
