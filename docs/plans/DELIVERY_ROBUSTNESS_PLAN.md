# Delivery Robustness — false-complete guard + re-delegation cap + source handoff

## The incident

The project-bootstrap canary worked first-try (archie stood up `1health-website`, bound it to
the origin chat space, resolved a real 4-member team, auto-continued into delivery, delegated the
design review to Dot). But the **delivery** then failed in a pre-existing multi-agent path the
bootstrap merely drove into:

```
02:57  CP2: delegation to designer (Dot) dispatched, checkpoint waiting
03:30  [delegation] Attached git-branch input pointer (mission/w-…) — branch EMPTY (source on Drive)
03:33  … delegations complete (4 results)   → re-queue
03:39  … 5 delegation(s) complete           → re-delegate
03:46  … C-type checkpoint delegation (with failures) → re-delegate
…      6, 7, 8, 9 delegation(s) complete    (re-delegated ~6× over 35 min)
04:06  Envelope complete (Synthesized response)   ← CP2/3/4 still pending, EMPTY deliverable
```

Two defects, both in shared brain logic (not bootstrap):

1. **False-complete.** The mission synthesized `complete` with 3 of 4 checkpoints pending and no
   deliverable (no staging URL). `synthesize.mjs`'s existing `hasUnresolvedFail` guard only inspects
   `priorResults` — it never consults the pinned `_cp_spine`, so an unfinished delivery can claim success.
2. **Unbounded re-delegation.** `agent-brain.mjs checkWaitingEnvelopes` clears `_cp_progress` and
   re-queues cortex on every failed C-type delegation with no attempt cap, so a delegate that
   structurally cannot succeed loops.

Enabling condition (3): the delegate's git-branch input clone was **empty** — the delegator's CP1
downloaded the HTML into its workspace but it was never committed to the mission branch (the source
lives on Drive). The input-pointer text said *"if absent, report what is missing"* — steering the
delegate toward "report failure" instead of "fetch from Drive," even though the Drive id was in the
delegate's project context (`source_html: {kind:drive, ref:1OJ9F6M9…}`).

## The three fixes (all deterministic, C-4 / B-1; flag-gated; canary-first)

| Fix | Layer | File | What |
|---|---|---|---|
| **A — false-complete guard** | brain | `actions/synthesize.mjs` + pure `checkpoint-spine.mjs#finalizeBlockedBySpine` | A mission with a pinned spine may not synthesize `complete` while its **deliverable (last) checkpoint** is unmet. Fail-closed: steer to `needs_input`; on the last iteration terminate as `needs_input` directly so no false-green escapes. |
| **B — re-delegation cap** | brain | `agent-brain.mjs checkWaitingEnvelopes` (both re-queue sites) + pure `delegation.mjs#{redelegationKey,bumpRedelegation,composeRedelegationEscalation}` | A checkpoint whose delegation returns with failures is re-delegated at most `redelegation_max` (2) times; past that the mission escalates to the operator via `needs_input` naming the stuck checkpoint + the delegate's reason, instead of looping. Counter keys on the checkpoint **outcome** (stable across re-plans). |
| **C — source handoff** | brain | `checkpoint-executor.mjs` input pointer | An empty input branch is **not** a blocker and **not** a reason to loop — the delegate is told to fetch the input from its durable source (the Drive id / repo in project context + the instruction) and only report missing if it exists in no durable source. |

### Flags (contracts `dispatch`, default OFF → canary via env, flip after proof)
- `finalize_requires_spine_complete` (A) — env `AGENT_FINALIZE_SPINE_GUARD=on`
- `redelegation_cap_enabled` (B) + `redelegation_max` (2) — env `AGENT_REDELEG_CAP=on`
- Fix C is unconditional (a strictly-better instruction; no flag).

## Together
The mission now either **delivers** (the delegate fetches the Drive source and succeeds) or **fails
loudly** (escalates to the operator via `needs_input`). It can no longer loop, and it can no longer
report a delivery `complete` that never produced its deliverable.

## Verification
- Pure-core unit tests: `finalizeBlockedBySpine` (guard cases) + `bumpRedelegation`/`redelegationKey`/
  `composeRedelegationEscalation` (cap + key stability + escalation text). Suite **1029/1029**.
- `validate-contracts --repo` clean.
- Canary on archie (env flags on): re-run the 1health bootstrap+delivery — prove no re-delegation loop,
  no false-complete, and either a real staging URL or an honest `needs_input`.
