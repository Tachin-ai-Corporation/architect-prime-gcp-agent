# Phase 4: Multi-step planning

> **Goal:** Cortex can return multi-step plans (`action: plan`). Brain creates child envelopes and executes them sequentially. Cerebellum verifies steps with accept_criteria.

---

## Prerequisites

- Phase 3 complete: memory + classify attach working on Stan

---

## Deliverables

### 1. Cortex `plan` action

Cortex can now return a plan with multiple ordered steps:

```json
{
  "action": "plan",
  "steps": [
    { "agent": "motor", "intent": "execute", "task": "...", "accept_criteria": "..." },
    { "agent": "motor", "intent": "execute", "task": "...", "accept_criteria": "..." },
    { "agent": "cerebellum", "intent": "verify", "task": "...", "accept_criteria": "..." }
  ],
  "reasoning": "..."
}
```

Brain receives this and creates child Task envelopes in Firestore for each step.

### 2. Sequential child execution

Brain processes plan children in order:

```
for each step in plan.steps:
  child = create_child_envelope({
    type: "T",
    parent_id: envelope.id,
    owner: step.agent,
    intent: step.intent,
    instruction: step.task,
    accept_criteria: step.accept_criteria,
    context: accumulated_context_from_prior_steps
  })
  result = call_agent(step.agent, child)
  update child.output = result
  update child.status = complete|failed
  
  if child.status == failed:
    retry once with error context
    if still failed:
      mark parent envelope failed
      break
  
  accumulated_context += result
```

**Context accumulation:** Each subsequent step receives all prior step results as context. Brain builds this automatically — the agent receiving step 3 sees results from steps 1 and 2.

### 3. Cerebellum as envelope-aware verifier

Cerebellum receives the accept_criteria directly from the envelope:

```
Input to Cerebellum:
{
  "task": "Verify the previous step's output",
  "accept_criteria": "drive-upload returned a file URL and status 200",
  "prior_step_output": "<Motor's actual output>",
  "all_prior_results": [...]
}
```

Cerebellum returns a structured verdict:
```json
{
  "verdict": "ALL_PASS",
  "checks": [
    { "criteria": "drive-upload returned file URL", "pass": true, "evidence": "URL: https://..." },
    { "criteria": "status 200", "pass": true, "evidence": "HTTP 200 OK" }
  ]
}
```

Or on failure:
```json
{
  "verdict": "FAIL",
  "checks": [
    { "criteria": "file exists at path", "pass": false, "evidence": "404 Not Found" }
  ]
}
```

Brain reads the verdict. On FAIL, Brain feeds the failure back to Cortex (next loop iteration), who can decide to retry with adjusted instructions or escalate.

### 4. Plan-then-synthesize flow

After all plan steps complete, Brain loops back to Cortex with the full prior_results. Cortex returns `synthesize` to produce the final human-facing output. This is automatic — Brain always consults Cortex after the last child completes.

### 5. Retry on failure

When a step fails:
1. Brain retries the same step once, adding the error to the context: "Previous attempt failed: {error}. Try again with adjusted approach."
2. If retry also fails, Brain consults Cortex with the failure context
3. Cortex can: adjust the plan (return a new dispatch), skip the step (return synthesize with partial results), or escalate (return needs_input)

---

## End-to-end test

"Upload budget.xlsx to Finance/Q2-2026, create the subfolder if it doesn't exist"

Expected Cortex plan:
1. Motor: `drive-ls` on Finance folder → accept: "returns folder listing"
2. Motor: `drive-mkdir Q2-2026` if not found → accept: "subfolder exists"
3. Motor: `drive-upload budget.xlsx` to subfolder → accept: "returns file URL"
4. Cerebellum: verify file accessible → accept: "file readable at URL"

Verify: all 4 child envelopes created in Firestore, executed sequentially, context accumulated, Cerebellum passes, Cortex synthesizes with Drive link.

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Plan action, sequential execution, retry logic |
| `brain/prime/cortex/SOUL.md` | MODIFY | Plan action support |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet parity |
| `brain/prime/cerebellum/SOUL.md` | MODIFY | Envelope-aware structured verification |
| `brain/fleet/_brain/cerebellum/SOUL.md` | MODIFY | Fleet parity |
