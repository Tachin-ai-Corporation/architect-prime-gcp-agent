# Resource Ledger in Memory: stop re-deriving what we already know

**Status:** Shipped `v2026.07.26.6.0` – `v2026.07.26.8.0`, deployed to the canary and verified there. Behavioral proof (a live mission resolving a folder from memory) pending an operator-driven run.

## Context

A mission re-run spent its entire budget re-discovering a folder it had already found two
iterations earlier, then blocked without ever reaching the documents it was unblocked to read.
The trace, visible only because of the `runCommand` breadcrumbs added in the mission-robustness
work — 22 tool calls, 20 of them `drive-search`:

```
drive-search "name contains 'signed artifacts' ... folder"  ✓ 31b   ← empty
   ... the SAME query, six times, always empty
drive-search "name contains 'master templates' ... folder"  ✓ 396b  ← FOUND
   ... the SAME successful query, four times
```

`31b` is `{"files":[],"count":0}`. **The folder is not named "signed artifacts"** — Drive calls it
*"Executed Advisory Agreements"*. Iterations 1–3 had learned that mapping; this run learned it
again from zero, and the flail consumed the 300s dispatch budget. **The timeout was a loop, not a
hang.**

Three layers lost the knowledge:

1. **Working state dies on resume.** `initWorkspace` re-clones `main` over the mission tree,
   wiping the blackboard and step notes; the tree is removed entirely at mission end.
2. **No banked evidence reaches a resumed run.** `savedResults` is empty after a `needs_input`
   resume, so the `## Previously Established` block added earlier had nothing to feed either.
3. **Nothing durably remembered identifiers.** `recall_layers coreIds=0` every run.

**Design constraint from review:** the ledger belongs *in memory*. Storage may be per-mission, but
**memory must be the thing that finds, sees, and informs the brain.** That fits the existing
architecture exactly — [`recallMemory()`](../../corekit/daemon/agent-brain.mjs) gathers raw
candidate layers daemon-side and hands them to temporal-memory, which is *"the SOLE consumer of raw
memory and the SOLE producer of the packet the other organs see."* The ledger is **Layer E**.

## What shipped

**Capture — deterministic, no LLM (`v2026.07.26.6.0`)**
[`corekit/lib/resource-ledger.mjs`](../../corekit/lib/resource-ledger.mjs) (pure, B-19):
`extractResources()` reads the structured JSON the Drive/Docs skills already emit — including JSON
nested and escaped inside `runCommand_response`, which is how results actually arrive.
`mergeResources()` is keyed by `kind:normalizedName`, idempotent, order-independent, updates in
place on a changed id while recording `previous_id`, and reports what the cap dropped.
The executor captures at task finalisation into **`envelope.context.resources`** — the envelope, not
the tree, because the tree does not survive a resume.

**Surfacing — memory is the interface (`v2026.07.26.6.0`)**
Recall Layer E merges this mission's ledger with Core Memory's `resources` category, cue-ranked. It
is **unshifted, not pushed**: the candidate block is trimmed from the tail, and these lines must
never be what gets cut for budget. It enters as a **candidate for temporal-memory**, never injected
raw — so temporal remains the sole producer of the packet. `recall_layers` gained `resourceHits=`.
The memory-recall skill now requires identifiers to ride **verbatim, always**, binned `verified`
(B-29) — the one deliberate exception to "recall makes context smaller", because a half-remembered
id is worse than none.

**Durability — through consolidation, not daemon writes (`v2026.07.26.8.0`)**
`resources` is a documented Core Memory category. Promotion is **temporal-memory's** job in
consolidation step 5b, *not* a daemon auto-write: v2026.06.21.1.0 deliberately removed daemon
writes to core memory as noise, and temporal-memory is the memory authority. Entries are written as
`<kind>: "<name>" = <id>`, superseded on change, retired when a target stops resolving.
**Aliases get their own entries** — "signed artifacts" *and* "Executed Advisory Agreements" both
point at the same id, because the alias is the knowledge that cost a mission its whole budget.

**The two loops that actually killed the mission (`v2026.07.26.7.0`)**
- The loop guard counted identical *arguments* but never looked at the result, while its message
  claimed "the result hasn't changed". It now fingerprints the result per signature: a byte-identical
  repeat is a proven no-op, nudged at 2 and terminated at 3, while a repeat whose result *changed*
  (legitimate polling) is untouched. The varying-args semantic nudge gained a terminal bound — it
  fired once at 8 calls and was ignored for another 12.
  The guard remains per-dispatch, so a retry starts fresh; that blindness is why six identical calls
  split across a timeout and its retry slipped through. The real remedy for that case is the ledger.
- Cerebellum returned 0 chars **twice** on an identical 9,746-token prompt, so the B-28 fail-closed
  blocked a mission whose work was fine. Empty verdicts now log `finishReason`, prompt size and
  error; and since a second empty reply means the *prompt* is the problem, one reduced attempt
  (criteria + clipped evidence, no attack/probe scaffolding) runs before conceding.
- The post-unblock guard is **documented, not loosened.** It ended a progressing mission, but only
  because the spurious verification failure fed it. Weakening a guard that stops 5–7 iteration spin
  loops would trade a rare false block for a common runaway.

## Verification

**Repo:** 21 new unit tests over the real fixtures (extraction, escaped nesting, cap, idempotence,
ordering, render). Suites 800/801 — the one failure is a pre-existing delegation-marker fixture in
`test/`, tracked separately and untouched. `validate-contracts --repo`: 82 checks pass. The organ
soft-lock check reports `ERROR` in a Windows shell because its `python3` heredoc hits the Store
stub; run directly it is OK across 56 files, and no organ file was touched.

**Canary (verified on the VM against the real data):**
- Extraction pulled the folder id and the converted docId from the actual mission shapes; an empty
  result yielded nothing; merge proved idempotent.
- The rendered block is exactly what temporal-memory will receive:
  `- folder: "master templates" = 1MASTERTEMPLATES00000000000000009`
- The deployed loop guard **terminates at call 3** on the six-identical-searches pattern (all six ran
  before), while changing results still reach the looser thresholds.
- All five daemons active, zero errors after the upgrade.

**Remaining (needs a live mission):** `envelope.context.resources` populating, `resourceHits>0` in
`recall_layers`, and the pass/fail signal for the whole plan — **a mission that names a known folder
and never calls `drive-search` for it.** Then fleet-wide, then one consolidated
`.agents/rules/project-context.md` + memory update covering this and the mission-robustness work.
