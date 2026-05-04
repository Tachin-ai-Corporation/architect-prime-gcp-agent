# Skill: Google Calendar

## What this skill does
Manage Google Calendar — list events, search by text, create meetings,
update event details, and delete events. Works with the agent's primary
calendar by default.

## When to use
- User asks about upcoming meetings or schedule
- Task requires creating or modifying calendar events
- Need to find events by keyword or date range
- Scheduling meetings or blocking time

## Tools (dispatched to motor for writes, temporal-memory for reads)

### Read
- `calendar-events --from <ISO> --to <ISO>` — list events in a date range
- `calendar-search --query "standup" [--from ISO] [--to ISO]` — search events

### Write
- `calendar-create --summary "Meeting" --from <ISO> --to <ISO> [--description "..."] [--location "..."]` — create an event
- `calendar-update --event <ID> [--summary "..."] [--from ISO] [--to ISO]` — update an event
- `calendar-delete --event <ID>` — delete an event

## Important Notes
- Adding attendees sends invitation emails — confirm with user before creating events with attendees.
- All timestamps must be ISO 8601 format (e.g., `2026-04-25T10:00:00Z`).
- Default calendar is `primary`. Use `--calendar <id>` for other calendars.

## Auth
All tools authenticate via DWD using the agent's Workspace email.
No API keys or OAuth tokens needed.
