# Phase 3: Memory integration + envelope discovery

> **Goal:** Hardwired memory recall and write on every envelope. Active envelope scan for follow-up detection. Cortex classify correctly identifies follow-ups via `attach`.

---

## Prerequisites

- Phase 2 complete: Cortex loop with dispatch → synthesize working on Stan

---

## Deliverables

### 1. Temporal-memory HTTP integration

Validate temporal-memory is callable via individual gateway HTTP route:
- Recall: `POST openclaw/temporal-memory` with "recall context relevant to: {instruction}"
- Write: `POST openclaw/temporal-memory` with "store: {structured summary}"
- Use isolated sessions (fresh each call — memory state lives in workspace files and Firestore, not sessions)

### 2. Hardwired memory recall (pre-loop)

Before ANY Cortex consultation (classify or decide), Brain calls temporal-memory:

```
memory_context = call_agent("temporal-memory", {
  instruction: "Recall all relevant context for: " + (intake.text || envelope.instruction),
  session: "isolated"  // fresh each time
})
```

The recalled context is attached to:
- The classify consultation packet (as `memory` field)
- The decide consultation packet (as `memory` field)

This runs on every intake and every envelope, without exception.

### 3. Hardwired memory write (post-loop)

When an envelope reaches `status=complete`, Brain calls temporal-memory:

```
call_agent("temporal-memory", {
  instruction: "Store the following completed work:\n" +
    "Request: " + envelope.instruction + "\n" +
    "Type: " + envelope.type + "\n" +
    "Steps taken: " + summarize_children(envelope) + "\n" +
    "Result: " + envelope.output + "\n" +
    "Envelope ID: " + envelope.id,
  mode: "write",
  session: "isolated"
})
```

Write on Mission completion only (not every Task). Tasks contribute to the Mission summary.

### 4. Active envelope scan

Before classify, Brain queries Firestore for in-progress work:

```
active_envelopes = query:
  owner == this_agent
  AND status IN [active, waiting, needs_input, pending]
  AND updated_at > (now - 24h)
  ORDER BY updated_at DESC
  LIMIT 10
```

Brain passes these to Cortex in the classify packet as `active_envelopes` (summarized: id, type, instruction, status, updated_at).

### 5. Cortex classify `attach` support

Cortex can now return:
```json
{
  "action": "classify",
  "classification": "attach",
  "attach_to": "w-abc123",
  "as_type": "T",
  "instruction": "User is asking for status on the budget upload",
  "reasoning": "Active Mission w-abc123 matches — user is following up"
}
```

Brain's response to `attach`:
- Load the referenced envelope
- If the existing envelope is `complete`: create a new Task under it for the follow-up
- If the existing envelope is `active` or `waiting`: create a child Task that reports status
- If the existing envelope is `needs_input`: treat the intake as the human's response, resume the blocked envelope

### 6. Memory-enriched Cortex decisions

Cortex now receives memory context on every consultation. Update the decide packet:

```json
{
  "mode": "decide",
  "envelope": { "..." },
  "memory": {
    "recalled": "Finance folder ID is 1xABC..., last upload was on May 15, user prefers Q subfolder structure"
  },
  "agent_registry": { "..." },
  "prior_results": [],
  "iteration": 1
}
```

Cortex uses memory to make better decisions: skip a drive-ls if the folder ID is already known, use the right subfolder naming convention, reference prior interactions.

---

## End-to-end tests

**Test 1 — Memory recall enriches decisions:**
1. Ask Stan "Upload budget.xlsx to the Finance folder"
2. Stan processes (creates Mission, dispatches Motor, etc.)
3. Later: ask Stan "Upload Q3 report to the same place"
4. Verify: memory recall returns the Finance folder context from the first interaction
5. Verify: Cortex uses the recalled folder ID without needing to re-search

**Test 2 — Follow-up detection:**
1. Ask Stan to upload a file (creates Mission, starts processing)
2. While processing (or after), ask "how's that upload going?"
3. Verify: Cortex classify returns `attach` to the existing Mission
4. Verify: Brain does NOT create a duplicate Mission
5. Verify: response references the existing work's status

**Test 3 — needs_input resumption:**
1. Ask Stan something ambiguous (Cortex returns needs_input)
2. Mouth delivers the clarifying question
3. Human responds with clarification
4. Verify: Cortex classify returns `attach` to the needs_input envelope
5. Verify: Brain resumes the blocked envelope with the clarification

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Memory hardwire, envelope scan, attach handling |
| `brain/prime/cortex/SOUL.md` | MODIFY | Memory-aware decisions, attach classification |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet parity |
