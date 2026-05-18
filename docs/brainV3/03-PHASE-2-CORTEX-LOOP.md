# Phase 2: Cortex loop — single-step dispatch

> **Goal:** Cortex can dispatch to a single agent (Motor or temporal-research), receive the result, and synthesize a final response. Prove the full decide → dispatch → synthesize cycle.

---

## Prerequisites

- Phase 1 complete: intake → classify → short_circuit pipeline working on Stan
- Gateway individual agent routes validated (Phase 1 research task)

---

## Deliverables

### 1. Cortex SOUL.md v2 expanded

Add `dispatch` and `synthesize` actions to Cortex's decision vocabulary. Cortex now:
- Reads the agent registry to know what each agent can do
- Returns `dispatch` when the task requires an agent (Motor for execution, temporal-research for search)
- Returns `synthesize` after receiving a dispatch result, to produce the human-facing summary
- Still returns `short_circuit` for simple questions that don't need agent dispatch

### 2. Brain Cortex loop implementation

Expand `process_envelope` from Phase 1's single-call to the full iterative loop:

```
set prior_results = []
set iteration = 0, MAX_ITERATIONS = 12

while iteration < MAX_ITERATIONS:
  iteration++
  decision = call_cortex(envelope, memory={}, registry, prior_results, iteration)
  
  switch decision.action:
    case "dispatch":
      child = create_child_envelope(decision)
      result = call_agent(decision.agent, child)
      update_child_envelope(child, result)
      prior_results.push({ agent, result })
      continue  // loop back to Cortex
    
    case "synthesize":
      envelope.output = decision.synthesis
      envelope.status = "complete"
      break
    
    case "short_circuit":
      envelope.output = decision.response
      envelope.status = "complete"
      break
```

### 3. Gateway HTTP dispatch function

`call_agent(agent_id, envelope)` — the core HTTP dispatch:

- Assemble the agent's input from the envelope (instruction, context, accept_criteria)
- POST to `http://127.0.0.1:{port}/v1/chat/completions` with `model: "openclaw/{agent_id}"`
- Use named session `session:envelope-{envelope.id}` for Cortex calls
- Use isolated sessions for other agents (Phase 2 default)
- Parse response, extract the agent's output (strip OpenClaw framing)
- Return structured result

### 4. Response parser hardening

The parser must handle:
- JSON wrapped in markdown code fences (```json ... ```)
- JSON preceded by conversational text ("Sure, here's the result: {...}")
- JSON followed by OpenClaw `Action:` blocks
- Multiple JSON blocks (take the first one matching the schema)
- Malformed JSON (retry once with explicit instruction)

### 5. Gateway liveness polling

Instead of hard timeouts, Brain polls `/status` on the gateway:
- Before dispatch: confirm gateway is responsive
- During long dispatches: poll every 30s to confirm the agent is still processing
- If gateway becomes unresponsive: mark envelope as `failed` with gateway error
- Expose liveness state for Mouth to send interim status updates

### 6. Cortex queue awareness

When Brain is processing an envelope and new intake arrives, Brain does not interrupt. However, Cortex should be able to send status updates. Implement:
- Brain checks for pending intake during the Cortex loop
- If pending intake exists, Brain informs Cortex in the next consultation: `"pending_intake_count": 2`
- Cortex can return a `status_update` action (new in Phase 2) to have Mouth send an interim message: "Working on X, I'll get to your new message next."
- Brain sends the status update to Mouth (writes a transient output to the envelope), then continues the loop

---

## End-to-end test

1. Human sends "What's the current GCP pricing for e2-medium instances?" via GChat
2. Ears → intake → Brain classify → new_task
3. Brain → Cortex decide → `{ action: "dispatch", agent: "temporal-research", task: "Search for GCP e2-medium pricing" }`
4. Brain dispatches to temporal-research via HTTP → receives search results
5. Brain → Cortex decide (with prior_results containing research) → `{ action: "synthesize", synthesis: "GCP e2-medium costs..." }`
6. Brain marks complete → Mouth delivers

**Also test:** During step 4, send another message. Verify it queues as intake and doesn't interrupt processing.

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Full Cortex loop, dispatch, synthesize, queue awareness |
| `brain/prime/cortex/SOUL.md` | MODIFY | Add dispatch + synthesize + status_update actions |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet parity |
