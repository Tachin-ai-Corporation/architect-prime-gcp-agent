# Skill: Calendar Operations

## When to Use
When managing calendar events, scheduling meetings, or tracking upcoming calendar appointments.

## Commands

No custom corekit scripts are governed directly by this skill (handled via core workspace skills).

## Procedures

### Scheduling Workflow
1. **Read user timezone** from `IDENTITY.md` or `MEMORY.md`.
2. **Convert times** to the user's timezone before displaying.
3. **Check conflicts** via `calendar-events` for the target date/time range.
4. **Propose slots** if conflicts exist: suggest 3 alternative time slots.
5. **Wait for confirmation** before creating the event (NEVER auto-create without approval).
6. **Create event** using `calendar-create` with all required fields (attendee-less).
7. **Confirm** with a summary of what was created.

### Daily Briefing Procedure
1. Fetch today's calendar using `calendar-events --days 1`.
2. Read `MEMORY.md` for scheduled follow-ups or meeting prep notes.
3. Compile briefing in the standard morning briefing markdown template format.

### End-of-Day Calendar Check
1. Review tomorrow's calendar using `calendar-events --days 1 --date TOMORROW`.
2. Compile and format the calendar preview report.

---

## Detailed Reference

### Event Discovery & Creation Reference
```
# Event discovery
calendar-events --days 1 --date YYYY-MM-DD

# Event creation (attendee-less — C-27: agents don't send invitations; the mouth
# is the sole outbound egress. Create the event, then report its link so a human
# can add attendees if needed.)
calendar-create \
  --summary "Meeting Title" \
  --start "YYYY-MM-DDTHH:MM:SS" \
  --end "YYYY-MM-DDTHH:MM:SS" \
  --description "Agenda:\n1. Topic A\n2. Topic B" \
  --location "Google Meet" \
  --timezone "America/Chicago"
```

### Timezone Reference
| Abbreviation | IANA Zone | UTC Offset |
|-------------|-----------|------------|
| CT / CST / CDT | America/Chicago | -6/-5 |
| ET / EST / EDT | America/New_York | -5/-4 |
| PT / PST / PDT | America/Los_Angeles | -8/-7 |
| UTC | UTC | +0 |

## Safety Rules
- **NEVER create calendar events without checking conflicts first**
- **ALWAYS convert times to user's timezone** before presenting

