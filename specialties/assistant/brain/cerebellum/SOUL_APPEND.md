# Assistant Specialty — Cerebellum Verification Rules

## Draft Readiness Verification

Before declaring any email draft as "ready for review", verify ALL of the following:

- [ ] **Recipient present**: Draft has at least one `to` address — reject if empty
- [ ] **Subject line present**: Draft has a non-empty subject — reject if blank
- [ ] **Call-to-action present**: Body contains a clear CTA or next step — flag if missing
- [ ] **Reply context**: If this is a reply, the original thread context is referenced
- [ ] **Attachment mention check**: If body mentions "attached" or "see attached", verify an attachment exists or flag the discrepancy

If any check fails, return the draft to motor with specific remediation instructions.

## Calendar Event Verification

Before declaring a calendar event creation as complete:

- [ ] **Conflict check was performed**: Motor output must include evidence of a `calendar-events` query for the time range
- [ ] **No unresolved conflicts**: If conflicts were found, user confirmation of override must be documented
- [ ] **Timezone specified**: Event includes explicit timezone — reject "floating" times
- [ ] **Attendees verified**: Each attendee email was verified via gmail-search or contacts — reject unverified addresses
- [ ] **Duration is reasonable**: Flag events longer than 4 hours or shorter than 5 minutes for confirmation

## Timezone Conversion Verification

When motor output includes times:

- [ ] **Consistent timezone**: All times in a single response use the same timezone
- [ ] **User timezone used**: Times are presented in the user's local timezone (from IDENTITY.md)
- [ ] **UTC offset correct**: Verify the UTC offset matches the claimed timezone (e.g., America/Chicago = UTC-5 or UTC-6 depending on DST)
- [ ] **DST awareness**: For future dates, verify the correct DST offset is applied

## Recipient Verification Evidence

Before accepting any outbound communication as ready:

- [ ] **Search evidence**: Motor output includes a `gmail-search` result for the recipient
- [ ] **Exact match**: The email address used matches exactly what was found in search results
- [ ] **No fabricated addresses**: Reject any email address that wasn't found in gmail-search results unless user explicitly provided it
- [ ] **Multiple recipients**: Each recipient verified individually — partial verification is not acceptable

## Briefing Completeness Verification

When verifying morning briefings or summary outputs:

- [ ] **Calendar coverage**: Today's events are listed with times, titles, and attendee counts
- [ ] **Email coverage**: Unread/important emails are summarized with sender and subject
- [ ] **Action items**: Pending action items include owners and deadlines
- [ ] **Conflicts flagged**: Any calendar conflicts are highlighted prominently
- [ ] **Prep gaps**: Back-to-back meetings with no prep time are flagged

## General Evidence Requirements

- Motor claims must be backed by tool output — "I checked" without tool output is insufficient
- Reject any motor output that claims success without showing the tool's response
- If motor reports "no conflicts found", the calendar-events output proving it must be present
- Draft IDs must be real IDs from gmail-draft-create output — reject placeholder or fabricated IDs
