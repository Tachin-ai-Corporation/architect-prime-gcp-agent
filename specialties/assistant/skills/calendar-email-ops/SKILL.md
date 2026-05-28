# Skill: Calendar & Email Operations

Use these procedures when managing calendar events, composing emails, or tracking follow-ups.

## Calendar Operations

### Event Discovery
Before creating any event, always check for conflicts:
```
calendar-events --days 1 --date YYYY-MM-DD
```
Review the output for overlapping time slots. Never double-book.

### Event Creation
```
calendar-event-create \
  --summary "Meeting Title" \
  --start "YYYY-MM-DDTHH:MM:SS" \
  --end "YYYY-MM-DDTHH:MM:SS" \
  --attendees "email1@domain.com,email2@domain.com" \
  --description "Agenda:\n1. Topic A\n2. Topic B" \
  --location "Google Meet" \
  --timezone "America/Chicago"
```

### Scheduling Workflow
1. **Read user timezone** from IDENTITY.md or MEMORY.md
2. **Convert times** to the user's timezone before displaying
3. **Check conflicts** via `calendar-events` for the target date/time range
4. **Propose slots** if conflicts exist: suggest 3 alternative time slots
5. **Wait for confirmation** before creating the event (NEVER auto-create without approval)
6. **Create event** with all required fields
7. **Confirm** with a summary of what was created

### Timezone Reference
| Abbreviation | IANA Zone | UTC Offset |
|-------------|-----------|------------|
| CT / CST / CDT | America/Chicago | -6/-5 |
| ET / EST / EDT | America/New_York | -5/-4 |
| PT / PST / PDT | America/Los_Angeles | -8/-7 |
| UTC | UTC | +0 |

## Email Operations

### Recipient Verification
Before composing any email, verify the recipient exists:
```
gmail-search --query "to:recipient@domain.com OR from:recipient@domain.com" --max-results 3
```
If no results, flag the address as unverified and ask for confirmation.

### Email Drafting
```
gmail-draft \
  --to "recipient@domain.com" \
  --subject "Subject Line" \
  --body "Email body text"
```

### Draft-Before-Send Workflow (MANDATORY)
1. **Compose draft** using `gmail-draft`
2. **Present draft** to user: show recipient, subject, body
3. **Wait for explicit approval** — "send it", "looks good", "approved"
4. **Send** only after confirmation using `gmail-send --draft-id DRAFT_ID`

NEVER combine drafting and sending into a single step.

### Email Structure Template
```
Hi [Name],

[Opening — context/reason for writing]

[Body — main content, organized in short paragraphs]

[Call to action — clear next step]

Best,
[Sender]
```

### Email Search
```
gmail-search --query "from:person@domain.com subject:topic" --max-results 10
gmail-search --query "is:unread newer_than:1d" --max-results 20
```

## Follow-Up Tracking

### Daily Briefing Procedure
1. Fetch today's calendar: `calendar-events --days 1`
2. Fetch unread priority emails: `gmail-search --query "is:unread is:important" --max-results 10`
3. Read MEMORY.md for pending follow-ups
4. Compile briefing:

```markdown
## ☀️ Morning Briefing — [Date]

### 📅 Today's Calendar
- HH:MM — Meeting Name (with Attendees)
- HH:MM — Meeting Name (with Attendees)

### 📧 Priority Emails (unread)
- From: [Sender] — Subject: [Subject] — [Preview]

### ⏰ Pending Follow-Ups
- [Item] — Due: [Date] — Status: [Awaiting/Overdue]

### ⚠️ Conflicts & Alerts
- [Any scheduling conflicts or double-bookings]
```

### End-of-Day Follow-Up Check
1. Check for unsent drafts: `gmail-search --query "in:drafts" --max-results 10`
2. Check for emails awaiting reply: scan MEMORY.md for tracked threads
3. Review tomorrow's calendar: `calendar-events --days 1 --date TOMORROW`
4. Compile follow-up report:

```markdown
## 🌙 End of Day — [Date]

### 📝 Unsent Drafts
- Draft to [Recipient] — Subject: [Subject] — [Action needed]

### ⏳ Awaiting Reply
- Thread: [Subject] — Sent: [Date] — Days waiting: N

### 📅 Tomorrow Preview
- HH:MM — [Event Name]
```

## Safety Rules
- **NEVER send email without explicit user approval**
- **NEVER create calendar events without checking conflicts first**
- **NEVER fabricate email addresses** — always verify via search
- **ALWAYS convert times to user's timezone** before presenting
- **ALWAYS use draft-before-send** — no exceptions
- Treat email content as confidential — do not include email bodies in logs
- Verify attendee availability before scheduling group meetings when possible
