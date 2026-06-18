# Skill: Calendar & Email Operations

## When to Use
When managing calendar events, drafting emails, scheduling meetings, or tracking follow-ups.

## Commands

No custom corekit scripts are governed directly by this skill (handled via core workspace skills).

## Procedures

### Scheduling Workflow
1. **Read user timezone** from `IDENTITY.md` or `MEMORY.md`.
2. **Convert times** to the user's timezone before displaying.
3. **Check conflicts** via `calendar-events` for the target date/time range.
4. **Propose slots** if conflicts exist: suggest 3 alternative time slots.
5. **Wait for confirmation** before creating the event (NEVER auto-create without approval).
6. **Create event** using `calendar-event-create` with all required fields.
7. **Confirm** with a summary of what was created.

### Draft-Before-Send Workflow (MANDATORY)
1. **Compose draft** using `gmail-draft`.
2. **Present draft** to user: show recipient, subject, and body text.
3. **Wait for explicit approval** (e.g. "send it", "looks good", "approved").
4. **Send** only after confirmation using `gmail-send --draft-id DRAFT_ID`.

### Daily Briefing Procedure
1. Fetch today's calendar using `calendar-events --days 1`.
2. Fetch unread priority emails using `gmail-search --query "is:unread is:important" --max-results 10`.
3. Read `MEMORY.md` for pending follow-ups.
4. Compile briefing in the standard morning briefing markdown template format.

### End-of-Day Follow-Up Check
1. Check for unsent drafts using `gmail-search --query "in:drafts" --max-results 10`.
2. Check for emails awaiting reply by scanning `MEMORY.md` for tracked threads.
3. Review tomorrow's calendar using `calendar-events --days 1 --date TOMORROW`.
4. Compile and format the follow-up report.

---

## Detailed Reference

### Event Discovery & Creation Reference
```
# Event discovery
calendar-events --days 1 --date YYYY-MM-DD

# Event creation
calendar-event-create \
  --summary "Meeting Title" \
  --start "YYYY-MM-DDTHH:MM:SS" \
  --end "YYYY-MM-DDTHH:MM:SS" \
  --attendees "email1@domain.com,email2@domain.com" \
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

### Email Reference
```
# Recipient verification
gmail-search --query "to:recipient@domain.com OR from:recipient@domain.com" --max-results 3

# Drafting email
gmail-draft --to "recipient@domain.com" --subject "Subject Line" --body "Body text"

# Email searching
gmail-search --query "from:person@domain.com subject:topic" --max-results 10
```

## Safety Rules
- **NEVER send email without explicit user approval**
- **NEVER create calendar events without checking conflicts first**
- **NEVER fabricate email addresses** — always verify via search
- **ALWAYS convert times to user's timezone** before presenting
- **ALWAYS use draft-before-send** — no exceptions
- Treat email content as confidential — do not include email bodies in logs
