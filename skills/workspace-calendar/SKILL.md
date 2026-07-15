# Skill: Google Calendar

## When to Use
When managing Google Calendar events — listing events, searching by query, creating new meetings, updating event details, or deleting events.

## Commands

### Read
- `calendar-events --from <ISO> --to <ISO>` — List calendar events in a date range.
  Output: JSON array of calendar event objects.
- `calendar-search --query <query> [--from <ISO>] [--to <ISO>]` — Search for calendar events matching a query.
  Output: JSON array of matching calendar event objects.

### Write
- `calendar-create --summary <summary> --from <ISO> --to <ISO> [--description <desc>] [--location <loc>]` — Create a new calendar event.
  Output: Success confirmation with the new event's details and ID.
- `calendar-update --event <ID> [--summary <summary>] [--from <ISO>] [--to <ISO>]` — Update details of an existing calendar event.
  Output: Success confirmation.
- `calendar-delete --event <ID>` — Delete a calendar event.
  Output: Success confirmation.

## Important Notes
- **Attendees:** Not supported. Events are attendee-less by design — adding attendees would send invitation emails, and agents do not send outbound messages (C-27; the mouth is the sole egress). Create the event, then report its link so a human can invite attendees if needed.
- **Timestamps:** All timestamps must be in strict ISO 8601 format (e.g., `2026-04-25T10:00:00Z`).
- **Calendar ID:** Default calendar is `primary`. Use `--calendar <id>` for other calendars.

## Procedures

### List events for a specific day
1. Calculate the start time (e.g., `2026-06-18T00:00:00Z`) and end time (e.g., `2026-06-18T23:59:59Z`) for the target day.
2. Run `calendar-events --from "2026-06-18T00:00:00Z" --to "2026-06-18T23:59:59Z"`.
3. Verify: Check that the output returns a list of events scheduled for that day.

### Schedule a new meeting
1. Confirm the meeting title, start time, and end time in ISO 8601 format.
2. Run `calendar-create --summary "Project Alignment" --from "2026-06-19T10:00:00Z" --to "2026-06-19T10:30:00Z"`.
3. Verify: Confirm the output displays a success confirmation containing the new event ID.

### Reschedule an existing meeting
1. Run `calendar-search --query "Project Alignment"` to locate the event and retrieve its ID.
2. Run `calendar-update --event "abc123xyz" --from "2026-06-19T11:00:00Z" --to "2026-06-19T11:30:00Z"`.
3. Verify: Confirm the output displays a success status for the update.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `400 invalidArgument` | Malformed ISO 8601 timestamps, or start time is after end time | Reformat timestamps to strict `YYYY-MM-DDTHH:MM:SSZ` and check that the start time is earlier than the end time. |
| `404 notFound` | Event ID does not exist | Run `calendar-search` with keywords from the event title to locate the correct event and retrieve its active ID. |
| `403 forbidden` | Calendar not shared or service account lacks permissions | Ask the user to share the target calendar with the agent's Google Workspace email address or check permission levels. |
