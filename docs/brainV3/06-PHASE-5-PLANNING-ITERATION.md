# Phase 5: Planning iteration (advisory rounds)

> **Goal:** Cortex can iterate before committing to a plan — dispatching research or advisory tasks, gathering results, then producing a plan informed by those results. Prefrontal available as a deep planning specialist.

---

## Prerequisites

- Phase 4 complete: multi-step plans executing on Stan

---

## Deliverables

### 1. Iterative pre-plan dispatching

Cortex can now return `dispatch` actions before returning a `plan`. Brain's loop already supports this (dispatch → feed back → consult Cortex again), but now Cortex is explicitly taught to use it for planning iteration:

**Pattern:** Cortex decides it needs more information before planning:
- Iteration 1: Cortex returns `dispatch` to temporal-research ("What are current best practices for Node.js CI/CD?")
- Brain dispatches, gets result, feeds back to Cortex
- Iteration 2: Cortex returns `dispatch` to temporal-memory ("Recall our project's existing CI setup")
- Brain dispatches, gets result, feeds back to Cortex
- Iteration 3: Cortex now has enough context → returns `plan` with informed steps

No new Brain logic needed — this is the existing Cortex loop used iteratively. The change is in Cortex's SOUL: teach it that `dispatch` before `plan` is the correct pattern when information is missing.

### 2. Prefrontal as deep planning delegate

For complex tasks that need structured decomposition beyond what Cortex does in a single decision, Cortex can dispatch to Prefrontal:

```json
{
  "action": "dispatch",
  "agent": "prefrontal",
  "intent": "plan",
  "task": "Decompose this into a checkpoint-level plan: Set up CI/CD for our Node.js API with GitHub Actions, including test, build, and deploy stages",
  "context_for_agent": "Research findings: {prior_results from temporal-research}"
}
```

Prefrontal returns a structured plan that Brain feeds back to Cortex. Cortex then either adopts the plan directly (returns `plan` with Prefrontal's steps) or adjusts it.

### 3. Prefrontal SOUL.md v2

Rewrite for the envelope model:
- Receives structured input (not raw user message — Cortex has already interpreted)
- Returns structured JSON plan (same format as Cortex's `plan` action steps)
- Has read access to agent registry (passed in context) to know what Motor can do
- Can return Checkpoint-level decomposition for large missions (not just Task-level)

```json
{
  "plan_type": "checkpoint",
  "checkpoints": [
    {
      "instruction": "CI pipeline config created and validated",
      "accept_criteria": "GitHub Actions workflow YAML passes validation",
      "tasks": [
        { "agent": "temporal-research", "task": "...", "accept_criteria": "..." },
        { "agent": "motor", "task": "...", "accept_criteria": "..." },
        { "agent": "cerebellum", "task": "...", "accept_criteria": "..." }
      ]
    },
    {
      "instruction": "Deploy pipeline runs successfully",
      "accept_criteria": "Test commit triggers pipeline, all stages green",
      "tasks": [...]
    }
  ]
}
```

Brain reads this and creates Checkpoint + Task envelopes in Firestore. The R/C/M/T hierarchy now has real depth.

### 4. Mission → Checkpoint → Task nesting

When Prefrontal returns checkpoint-level plans, Brain creates:
- Child Checkpoint envelopes under the Mission
- Child Task envelopes under each Checkpoint
- Executes Tasks within each Checkpoint sequentially
- Marks Checkpoint complete when all its Tasks are done
- Marks Mission complete when all Checkpoints are done

---

## End-to-end test

"Set up a CI/CD pipeline for our Node.js API using GitHub Actions"

Expected flow:
1. Cortex → dispatch temporal-research ("Node.js CI/CD best practices GitHub Actions")
2. Research returns → Cortex → dispatch temporal-memory ("Recall our existing project setup")
3. Memory returns → Cortex → dispatch prefrontal (with all context, "decompose into checkpoints")
4. Prefrontal returns checkpoint plan → Cortex → adopts plan
5. Brain creates Checkpoint envelopes → executes Tasks within each → Cerebellum verifies → Cortex synthesizes

Verify: full M → C → T hierarchy visible in Firestore. Each level has correct parent_id linkage.

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Checkpoint nesting, M→C→T hierarchy creation |
| `brain/prime/cortex/SOUL.md` | MODIFY | Iterative dispatch-before-plan pattern |
| `brain/fleet/_brain/cortex/SOUL.md` | MODIFY | Fleet parity |
| `brain/prime/prefrontal/SOUL.md` | MODIFY | Rewrite for envelope model, structured JSON plans |
| `brain/fleet/_brain/prefrontal/SOUL.md` | MODIFY | Fleet parity |
