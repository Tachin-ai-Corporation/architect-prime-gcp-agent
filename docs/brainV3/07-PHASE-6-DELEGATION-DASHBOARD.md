# Phase 6: Inter-agent delegation + dashboard

> **Goal:** Envelope-based delegation between agents via Firestore. R/C/M/T dashboard tree view with real-time updates. Human-in-the-loop for needs_input envelopes.

---

## Prerequisites

- Phase 5 complete: full planning iteration working on Stan

---

## Deliverables

### 1. Cortex `delegate` action

Cortex can now return:
```json
{
  "action": "delegate",
  "delegate_to": "stan@tachin.ai",
  "delegation_task": "Run the infrastructure audit on staging",
  "accept_criteria": "Audit report written to shared Drive folder",
  "reasoning": "Stan is DevOps, this is infrastructure work"
}
```

Brain's response:
1. Create a Mission envelope in Firestore with `owner=stan@tachin.ai`
2. Set current envelope to `status=waiting`
3. Send courtesy notification to Stan via Google Chat (informational only)
4. Exit the Cortex loop for this envelope

### 2. Waiting envelope resumption

Brain's main loop checks for waiting envelopes whose delegated children have completed:

```
waiting_envelopes = query:
  owner == this_agent
  AND status == waiting

for each w in waiting_envelopes:
  delegation_children = query:
    parent_id == w.id
    AND type == M
    AND status IN [complete, failed]
  
  if delegation_children exist:
    resume Cortex loop for w with delegation result in prior_results
```

When resumed, Cortex sees the delegation result and decides: synthesize, dispatch more work, or delegate again.

### 3. Fleet agent Brain awareness

Fleet agents' Brain instances poll for envelopes owned by them:
- Stan's Brain polls for `owner == "stan@tachin.ai"` (or matching agent ID)
- When Stan picks up a delegated Mission, he processes it through his own Cortex loop
- Stan's Cortex has Stan's agent registry (DevOps tools), Stan's memory, Stan's SOUL
- When done, Stan marks the envelope complete — the originating agent's Brain detects this

### 4. Dashboard R/C/M/T tree view

New dashboard component reading from `primes/{primeId}/work/` with Firestore real-time listeners:

**Tree structure:**
- Top level: Missions (and Responsibilities when Phase 7 adds them)
- Expandable: Mission → Checkpoints → Tasks
- Each node shows: status badge (color-coded), owner, instruction (truncated), timestamp
- Click any node → detail view

**Filters:**
- By status (active, complete, failed, waiting, needs_input)
- By owner (Prime, Stan, other fleet agents)
- By type (R, M, C, T)
- By date range

**Real-time updates:** Status badges animate on change. New envelopes appear without refresh.

### 5. Envelope detail view

Click any envelope in the tree to see:
- Full instruction and accept_criteria
- Context summary (or link to context subcollection)
- Output (if complete)
- Error (if failed)
- History timeline: every status transition with timestamp, agent, and detail
- Children (linked, clickable)
- Parent (linked, clickable)

### 6. Human-in-the-loop

For `needs_input` envelopes:
- Dashboard shows a prominent input prompt with the `what_is_needed` text
- Human types response directly in dashboard
- Dashboard creates an intake record with `source: "dashboard"` referencing the needs_input envelope
- Brain's classify (via Cortex) detects the reference and attaches to the blocked envelope
- Brain resumes the blocked envelope with the human's input

For Google Chat delivery: Mouth sends the `needs_input` question to the human. When the human replies, Ears picks it up as normal intake. Cortex classify detects the active needs_input envelope and returns `attach`.

---

## End-to-end tests

**Test 1 — Delegation:**
1. Prime sends Stan a mission via delegation (or human asks Prime to delegate)
2. Verify: Mission envelope appears in Firestore with owner=stan
3. Verify: Stan's Brain picks it up and processes it
4. Verify: When Stan completes, Prime's Brain resumes
5. Verify: Dashboard shows the delegation relationship (Prime's Mission → Stan's Mission)

**Test 2 — Human-in-the-loop:**
1. Ask Stan something ambiguous
2. Verify: needs_input envelope created, Mouth delivers question
3. Human responds (via dashboard or GChat)
4. Verify: Brain resumes the blocked envelope
5. Verify: Dashboard shows the full flow (blocked → resumed → completed)

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Delegate action, waiting resumption, fleet polling |
| `brain/prime/cortex/SOUL.md` | MODIFY | Delegate action support |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet parity |
| `app/src/app/page.tsx` | MODIFY | R/C/M/T tree view component |
| `app/src/components/work-tree/` | CREATE | Tree view, detail view, human input components |
| `app/src/app/api/primes/[id]/work/` | CREATE | API routes for work envelope queries |
