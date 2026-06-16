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

1. Brain encounters delegation (process step `type: 'delegation'` OR Cortex `action: 'delegate'`)
2. Resolves target agent from project team members or fleet docs by specialty
3. Composes marker via `composeDelegationMarker()`
4. Creates output envelope with `delivery_target: <targetEmail>` and `delivery_status: 'pending'`
5. Mouth picks up the envelope and delivers to the **shared project space** via DWD
6. Sets task envelope `status: 'waiting'`
7. `checkWaitingEnvelopes()` polls children for completion

### Receiver Side (Delegated Agent)

1. Ears detects `[DELEGATION ref:...]` in incoming GChat message
2. Flags `source_meta.delegation_ref` on the intake document
3. Brain sees delegation_ref → **skips LLM classify** entirely
4. Creates Mission (M envelope) deterministically
5. Registers own mission ID as child on parent envelope (cross-agent Firestore write)
6. Processes normally through Cortex loop

### Completion

1. Delegated mission reaches `status: 'complete'` or `'failed'`
2. Brain creates `[DELEGATION-RESULT]` output envelope with `delivery_status: 'pending'`
3. Mouth delivers the result to the **shared project space** via DWD
4. Delegator's `checkWaitingEnvelopes()` detects child completion via Firestore
5. Injects `[DELEGATION RESULTS]` as `context_forward` on the waiting envelope
6. Resumes processing with full delegation results in context

## Project Team Members

Delegation targets are resolved from the project's `team` array:

```json
{
  "team": [
    {"email": "swe-agent-bobby@tachin.ag", "role": "engineer", "name": "Bobby", "type": "agent"},
    {"email": "chill@tachin.ai", "role": "owner", "name": "Chill", "type": "human"}
  ]
}
```

Managed via `project-manage team-add/team-remove`. Cortex sees team members in project context and uses them to select delegation targets.

Fallback: If no suitable team member is found, brain falls back to fleet-wide specialty lookup.

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
