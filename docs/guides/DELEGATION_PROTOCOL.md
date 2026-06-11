# Delegation Protocol

Cross-agent delegation over Google Chat. The protocol path is **fully deterministic** — markers are parsed with regex, never by an LLM.

## Wire Format

### Delegation Request

```
@target-agent [DELEGATION ref:<parentEnvelopeId> from:<senderEmail> proj:<projectId>]
Human-readable delegation instructions.
Scope: <glob pattern> · Run process p-implement-verify.
Report back with PR URL + test-agent mission IDs.
```

### Delegation Result

```
@delegator-agent [DELEGATION-RESULT ref:<parentEnvelopeId> status:<complete|failed> mission:<missionId>]
Human-readable result summary.
```

## Mechanics

### Sender Side (Delegating Agent)

1. Brain encounters `stepType === 'delegation'` in checkpoint plan
2. Resolves target agent by specialty from fleet docs
3. Composes marker via `composeDelegationMarker()`
4. Sends via `chat-send` (DWD — appears as the agent in GChat)
5. Sets task envelope `status: 'waiting'`
6. `checkWaitingEnvelopes()` polls children for completion

### Receiver Side (Delegated Agent)

1. Ears detects `[DELEGATION ref:...]` in incoming GChat message
2. Flags `source_meta.delegation_ref` on the intake document
3. Brain sees delegation_ref → **skips LLM classify** entirely
4. Creates Mission (M envelope) deterministically
5. Registers own mission ID as child on parent envelope (cross-agent Firestore write)
6. Processes normally through Cortex loop

### Completion

1. Delegated mission reaches `status: 'complete'` or `'failed'`
2. Brain sends `[DELEGATION-RESULT]` reply via `chat-send`
3. Delegator's `checkWaitingEnvelopes()` detects child completion via Firestore
4. Injects `[DELEGATION RESULTS]` as `context_forward` on the waiting envelope
5. Resumes processing with full delegation results in context

## Guard Rails

### Exactly-Once Delegation

- **Receiver dedup:** Before creating a mission, queries `work` for any non-terminal mission with `source_meta.delegation_ref == ref`. If found, replies with status pointer instead of spawning duplicate.
- **Sender idempotency:** Checks parent envelope's `children` before sending. Non-terminal delegation for this ref → no re-send. Re-send only permitted when prior child terminated `failed`.

### Singleton Responsibilities

Responsibilities with `"singleton": true` in their schema will only fire if no non-terminal mission exists with the same `responsibility_id`. This ensures at most one improvement cycle is alive at any moment.

### Loop Guard

An agent never accepts a delegation whose ref chain includes one of its own envelopes. Walk `source_meta.delegated_from` upward (max depth 3).

### Ref Validation

Receiver verifies the parent envelope exists and `delegated_to` matches its own specialty before accepting. Otherwise treats as normal chat (LLM classify path).

## Resume Mechanism

**Firestore `children` is the sole resume mechanism.** The GChat `[DELEGATION-RESULT]` reply exists for:
- Human readability (humans watch the GChat space)
- Summary content source for `[DELEGATION RESULTS]` context

Agents never depend on parsing the GChat reply to resume. The Firestore polling path (`checkWaitingEnvelopes()`) is deterministic and reliable.

## Library

`corekit/lib/delegation.mjs` — Pure functions, zero dependencies:
- `composeDelegationMarker()` / `parseDelegationMarker()`
- `composeDelegationResultMarker()` / `parseDelegationResultMarker()`
- `isDelegationMarker()` / `isDelegationResultMarker()`

All functions are unit-tested in `test/delegation.test.mjs`.
