# Idempotency & Replay-Safety Hardening Plan

> **Version:** 1.0  
> **Status:** Active  
> **Ownership:** Human maintainers via CODEOWNERS  
> **Canon alignment:** Strengthens B-22 (crash-safety/idempotency) without weakening B-1 (determinism), B-23 (observability), or B-19 (testability)

## Objective

Make every active envelope resumable at the granularity of a single dispatch step, and make every side effect exactly-once under replay. The daemon can be killed at any point and restarted without:
1. Duplicate dispatches (double-sending a delegation, double-acking)
2. Lost progress (reprocessing from iteration 0 when work was already done)
3. Orphaned children (checkpoint/task envelopes created but never linked to parent)
4. Missed deliveries (output envelopes created but delivery_status lost)

## Architecture

### Step Key
Deterministic hash of `[envId, iteration, action, target]`. SHA-256 truncated to 16 hex chars. Every dispatch step gets a unique, deterministic key that is stable across replays.

### Step Ledger
A `step_ledger` field on the envelope document itself (~800 bytes for 50 steps). Records each step's status, agent, timestamp, duration, and output hash. Checked before every dispatch — if the step is already recorded, the dispatch is skipped.

### Durable Claim
A `claimed_by` field on the envelope document, set before processing begins. Prevents concurrent processing of the same envelope across restarts. Claims expire after 10 minutes (configurable via contracts). Local `processing` boolean remains as belt-and-suspenders.

### Checkpoint Resume
A `_cp_progress` field on the envelope stores the current checkpoint index, task index, and accumulated results. On re-entry after a crash, `processEnvelope` detects `_cp_progress` and resumes from the last completed step instead of re-running the analyze/decide pipeline.

### Idempotent Side Effects
- `createCT()`: uses a `ct_key` in source_meta to detect existing C envelopes
- Delegation output: checks for existing output with same delegation_ref
- `writeMemory()`: checks `memory_written` flag before writing
- `writeHistory()`: accepts optional `logicalKey` for dedup

## Checkpoints

### CP1 — Documentation & Audit
Plan doc, replay safety guide, non-deterministic site catalog.

### CP2 — Step Ledger + Step Key
Core idempotency mechanism. `deriveStepKey()`, `isStepComplete()`, `recordStep()` integrated into the checkpoint_plan task loop.

### CP3 — Durable Claim
Firestore-backed processing lock. `claimEnvelope()`, `releaseClaim()`, claim-aware startup recovery.

### CP4 — Replay-Safe Side Effects
Idempotent `createCT()`, delegation, memory write, history write.

### CP5 — Resumable Checkpoint Plans
Persist `_cp_progress` as steps complete. Resume from last completed step on re-entry.

### CP6 — Contracts Extension + Validation
Feature flags in contracts.json, validation rules in validate-contracts.

## Feature Flags

All new paths are behind contract booleans (default `true`):
- `dispatch.step_ledger_enabled`
- `dispatch.checkpoint_resume_enabled`
- `dispatch.claim_stale_ms` (default 600000)
