# Replay Safety Guide

> **Audience:** Anyone modifying `platform/runtime/agent-brain.mjs` or a `platform/` package  
> **Purpose:** Rules for writing code that behaves correctly when replayed after a crash

## Core Principle

Every dispatch step in the brain spine must be **idempotent under replay**. If the daemon crashes after step N completes but before the envelope state is updated, restarting the daemon must not re-execute step N.

## Step Key Formula

The step key is a deterministic hash that uniquely identifies a dispatch step:

```
stepKey = SHA256(envId | iteration | action | target).substring(0, 16)
```

Where:
- `envId`: the envelope being processed
- `iteration`: the current decide-loop iteration
- `action`: the Cortex-decided action (e.g., 'checkpoint_plan')
- `target`: the dispatch target (agent name, checkpoint index, task index)

## Rules for New Side-Effect Code

1. **Check before write.** Before creating any Firestore document (envelope, history, telemetry), check if a document with the same logical key already exists.

2. **Use deterministic IDs where possible.** If an ID can be derived from context (envelope ID + step index), derive it instead of generating a new random ID.

3. **Record in the step ledger.** After any dispatch completes, call `recordStep()` with the step key and result before continuing to the next step.

4. **Never rely on in-memory state for recovery.** All state that matters for resume must be persisted to Firestore. Transient fields (prefixed with `_`) on the envelope object must be written back.

5. **Atomic state transitions.** When a step completes, update both the step ledger and the envelope status in the same Firestore write.

## Auditing a New Dispatch Path

When adding a new action to the Cortex decide loop:

1. Identify all Firestore writes the action performs
2. For each write, verify it has a dedup check (step ledger, ctKey, or explicit query)
3. Verify the action records its result in the step ledger
4. Test: kill the daemon after the action completes but before the loop continues. Restart. Verify no duplicates.

## Non-Deterministic Sites Catalog

The following functions produce non-deterministic output and require special handling on replay:

| Function | Usage | Replay Impact |
|----------|-------|---------------|
| `generateId()` | Envelope IDs, approval IDs | Creates different IDs on replay — use step-key-derived IDs for replay-sensitive envelopes |
| `now()` | Timestamps on envelopes | Different timestamp on replay — acceptable for `updated_at`, problematic for `created_at` |
| `Date.now()` | Duration timing, file cache | Safe — used for telemetry/timing only |
| `randomBytes()` | ID suffix in `generateId()` | Non-deterministic — handled by step-key derivation |

## What Is NOT Replay-Sensitive

- Logging (`log()`) — side-effect free
- File cache reads (`cachedReadFile()`) — idempotent
- Gateway liveness checks — read-only
- Memory recall (`recallMemory()`) — read-only query
- Cortex/Prefrontal calls — judgment calls are idempotent (same input → replay is fine, different output is expected)
