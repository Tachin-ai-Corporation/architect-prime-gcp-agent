# Complete Context-Sharing Between Brain Organs

> **Version:** 0.1
> **Status:** Proposed — not started. Grounded in the Millie shared-docs mission `w-1784747134448-110acc7f` (2026-07-22): the correct answer was delivered, but at **17 LLM calls / ~7m45s / 5 motor iterations / 2 loop-guard kills**, because Cortex reasoned about the motor's 5,046-char result through a 2,000-char peephole (`DELTA_RESULT_CHARS`) and re-dispatched the motor instead of synthesizing — five times. It said so verbatim: *"the tool output is being truncated in the logs shown to me… I only see the first document."*
> **Ownership:** Human maintainers via CODEOWNERS.
> **Canon alignment:** Extends **C-28** (the `{kind, ref, summary}` resource-packet shape — already the contract for ProjectContext values and context promotion) to *inter-organ result hand-offs*; leans on **C-24** (git is the artifact substrate — the store already exists) and **B-18** (the daemon becomes the deterministic librarian). Preserves **B-4** (economy: bounded summaries stay in-prompt; full content is out-of-prompt until requested) and **B-28** (verification re-derives from full evidence, not a peephole). No new primitive (**C-14**); every knob in `contracts.json` (**C-7**); every mechanism telemetered (**C-20**) and reversible under a flag.

## Objective

Convert inter-organ hand-offs from *lossy truncated messages* to *addressable resource packets*: a bounded summary rides in the prompt, and the full artifact is readable by reference. An organ must never re-dispatch work to see a result it could read. Summary-by-default preserves context economy; hydrate-on-demand restores completeness. The brain stops being a pipeline that passes shrinking messages and becomes a blackboard whose organs share complete, addressable artifacts.

The invariant that keeps this from regressing into "dump everything into every prompt" (a B-4 violation) is load-bearing and stated in every phase: **summary-by-default, full content only on explicit request.**

## Verified foundations (code + live mission, 2026-07-22)

| Fact | Value | Consequence |
|---|---|---|
| Cortex decide sees a truncated task result | `DELTA_RESULT_CHARS = 2000`, `smartTruncate` in `buildDecideDeltaBlock` ([agent-brain.mjs:1494](../../corekit/daemon/agent-brain.mjs)) | A multi-item result (motor returned 5,046 chars) is clipped mid-list → Cortex can't see all rows → re-dispatches instead of synthesizing |
| Sibling/delegation preview cap | `RESULT_PREVIEW_CHARS = 700` ([agent-brain.mjs:100](../../corekit/daemon/agent-brain.mjs)) | Cross-envelope results lose detail |
| Session-stored turn cap | `TURN_CONTENT_CAP = 8000` (`utility.context_budgets.agent_step`) ([context.mjs:34](../../corekit/brain/context.mjs)) | Stored tool results clipped as a backstop |
| The full result already persists to git | `writeMissionRecord` → `commitAndSync` per mission (**C-24**), observed committing `41d01494` mid-mission | The full-fidelity store **exists**; organs just aren't handed a *ref* to read it |
| Resource-packet shape is already canon | `{kind, ref, summary}` for ProjectContext values + context promotion (**C-28**, [MODULE_CHARTER](../MODULE_CHARTER.md)) | The contract to reuse is already defined and validated — extend it, don't invent |
| Cortex decide is single-shot JSON | `Calling … claude-opus-4-6 (step 0/1)` — no tool loop | Hydration must be daemon-mediated (a decision field the daemon fulfills), not a cortex tool-call loop — keeps Cortex a pure decider (**C-5**) |
| Motor loops on tool results | gemini-2.5-flash re-issued the identical `drive-search` 4× → `[LOOP DETECTED]` terminate ([loop.mjs](../../corekit/brain/loop.mjs) guard), twice | The loop guard terminates in FAILURE rather than forcing synthesis from what the motor already has |

## Defect register (the pathology this plan fixes)

1. **Results cross organ boundaries as truncated strings, not packets.** The motor's complete output is clipped to 2,000 chars before Cortex sees it; there is no ref to the full artifact, even though it is already committed to the mission git tree.
2. **Truncation is blind, not structured.** `smartTruncate(result, 2000)` clips by character count. A 12-row list becomes "the first ~4 rows"; Cortex cannot tell whether it has all the data, so it assumes it does not.
3. **Cortex's only recourse to "I can't see it all" is to re-dispatch.** With no way to *request the rest*, the decide loop re-runs the motor — 5 iterations, ~3.5 min — to re-observe a result that was complete on the first call.
4. **Cerebellum verifies from the same peephole.** It PASSED, FAILED, PASSED, FAILED, PASSED on essentially the same evidence — verdict instability that is really evidence starvation, contradicting **B-28** (verification is re-derivation from the actual artifact).
5. **The motor loses continuity across re-dispatch.** Each daemon re-dispatch starts the motor's agentic loop fresh; it does not carry a reference to what it already retrieved, so it starts blind and (being a weak synthesis model) loops again.
6. **The loop guard ends in FAILURE, not synthesis.** On repeat-identical calls it terminates with "report FAILURE," discarding a result the motor already holds in its local history.

## Architecture principles

- **The daemon owns the store and the packets** (C-4/C-5/B-1/B-18): writing full results to the git tree, computing summaries, minting refs, and fulfilling hydration requests are deterministic daemon operations — never model-decided.
- **One shape for every cross-boundary value** (C-28): inter-organ results, checkpoint results, and promoted context all use `{kind, ref, summary, bytes, shape}`. The packet is the only thing that crosses an organ boundary.
- **Summary-by-default, full-on-demand** (B-4): the summary is always in-prompt and bounded; the full artifact is fetched only when an organ explicitly requests it or (for the verifier) when re-derivation requires it.
- **Verification re-derives from the artifact** (B-28): Cerebellum receives the full result (by auto-hydrated ref), never a preview.
- **Summaries preserve epistemics** (B-29): a summary is a faithful, shape-aware précis (count + head for a list; fingerprint + diff for an edit), never a lossy character clip that can imply "there is no more."
- **Everything reverts under a flag** (C-7/C-20): each mechanism is contracts-gated and telemetered; disabled, the brain behaves exactly as today.

## Phases

### Phase 0 — Measure (no behavior change)
Add telemetry that quantifies the pain and gives a hard before/after baseline: a `context_starve` line when an organ's input carried a character-clipped (non-packet) result, and a `redispatch_after_partial` line when Cortex re-dispatches a step whose prior result was truncated. Emit result `bytes` vs the cap that clipped it. Count both fleet-wide for a week.
**Files:** `corekit/daemon/agent-brain.mjs`, `corekit/daemon/checkpoint-executor.mjs`, `corekit/brain/loop.mjs`.
**Expected:** a per-mission count of avoidable re-dispatches and starved verifications — the acceptance metric for Phases 1–4.

### Phase 1 — Result store + resource-packet contract (highest leverage; no SOUL change)
New pure `corekit/lib/result-packet.mjs`: given a raw organ result, produce `{kind, summary, ref, bytes, shape}` with **shape-aware summaries** — a *list* → `"N items: <top-K names/ids>"`; a *record/text* → head + line/section shape; a *doc edit* → fingerprint + diff-stat; a *search* → count + top-K. Unit-tested; manifest entry same commit (**C-9**). The daemon persists each organ step's full output as an addressable artifact under the mission git tree (`results/<checkpoint>/<step>.json|md`; extends `writeMissionRecord`, **C-24**) and replaces the inline `smartTruncate` in `buildDecideDeltaBlock` with the packet. Cerebellum verification receives the **full** result (auto-hydrated by the daemon before dispatch) — verification is re-derivation (B-28), not preview-reading.
**Files:** new `corekit/lib/result-packet.mjs`, `corekit/daemon/agent-brain.mjs`, `corekit/daemon/checkpoint-executor.mjs`, `infra/contracts.json`.
**Expected:** the Millie class collapses on this phase alone — a `"2 items: PanelMD…, LegalDoc… [ref]"` summary lets Cortex synthesize on the first decide with zero hydration; Cerebellum stops flip-flopping. Zero new LLM calls; likely a large net reduction.

### Phase 2 — Hydrate-on-demand (daemon-mediated; organ-locked)
The Cortex decide schema gains an optional `request_context: [ref, …]` field: when a summary is insufficient to decide, Cortex names the refs it needs; the daemon fetches them from the store, injects them into the next decide delta (bounded by `hydrate_max_chars`, session-cached so a ref is fetched once), and re-invokes decide. This preserves Cortex as a pure-JSON decider (**C-5**) — no tool-calling in the decide path. Cortex + Cerebellum SOUL edits (**organ-locked** → re-pin `brain/ORGAN_LOCK.json`, `organ-change: intended`): *"Your inputs carry result packets — a summary and a ref. Decide from the summary when it suffices; when it does not, request the ref — never re-dispatch work to observe a result you can read."*
**Files:** `corekit/daemon/agent-brain.mjs` (schema + hydration fulfillment), `corekit/lib/result-packet.mjs`, `brain/fleet/_brain/cortex/SOUL.md`, `brain/prime/cortex/SOUL.md`, `brain/fleet/_brain/cerebellum/SOUL.md`, `brain/prime/cerebellum/SOUL.md`, `brain/ORGAN_LOCK.json`, `infra/contracts.json`.
**Expected:** the rare genuinely-large result is read once, deliberately — never re-dispatched. Re-dispatch-after-partial → ~0.

### Phase 3 — Motor continuity + loop-guard → synthesis
On daemon re-dispatch, the motor receives a ref to its own prior output so it resumes rather than restarting blind. The loop guard ([loop.mjs](../../corekit/brain/loop.mjs)), on a repeat-identical tool call, injects *"You already have this result: <summary/ref>. Produce your final answer now."* instead of terminating in FAILURE. Optionally route synthesis-heavy motor tasks to a stronger model (contracts config, not an organ change).
**Files:** `corekit/brain/loop.mjs`, `corekit/daemon/checkpoint-executor.mjs`, `infra/contracts.json`.
**Expected:** the observed re-run loop cannot form; a motor that has the data is pushed to answer, not to repeat.

### Phase 4 — Shared mission blackboard (the unifying structure)
A single append-only `MISSION.md` (or structured `_blackboard`) in the mission working tree — goal, decisions, result packets, open questions — maintained deterministically by the daemon (**C-5**) and read by every organ at dispatch. Organs stop depending on lossy call-to-call threading; they all read the same complete picture, packet-referenced. This is the fullest expression of shared context and the natural home for the Phase 1 packets.
**Files:** `corekit/daemon/agent-brain.mjs`, `corekit/daemon/checkpoint-executor.mjs`, new `corekit/lib/blackboard.mjs`, organ SOULs (read-the-blackboard prose; **organ-locked**), `brain/ORGAN_LOCK.json`, `infra/contracts.json`.
**Expected:** cross-organ coherence without re-dispatch or re-derivation; a mission's full reasoning trail is one addressable artifact.

### Phase 5 — Verify + roll
Canary Millie: re-run the shared-docs mission plus a docs surgical-edit and a multi-step research mission; compare `calls`, wall-clock, `redispatch_after_partial`, and `context_starve` to the Phase 0 baseline. Fleet-wide after a clean pass, per the standard deploy discipline. Adversarial review of the dispatch-path changes before fleet.

## Contracts surface (all validated at bootstrap, C-19)

```
organ_context:  result_store_enabled, packet_summary_chars, list_summary_top_k,
                hydrate_enabled, hydrate_max_chars, verifier_full_evidence,
                loop_guard_synthesize, blackboard_enabled, blackboard_max_chars
```

## Rollout & measurement

Each phase: implement → unit tests (pure cores — `result-packet.mjs`, `blackboard.mjs` — B-19) → version-prefixed commit(s) → deploy to canary Millie via `upgrade-corekit` → verify on-VM (telemetry lines, a real re-run) → fleet-wide → `STABLE` when verified. The acceptance metric for every phase is the Phase 0 ledger: **LLM calls and wall-clock per completed mission, and the count of re-dispatches / starved verifications** — a measurement checkpoint after Phase 1 re-prices Phases 2–4 with real numbers, so we build exactly as much overhaul as the evidence warrants. Every mechanism reverts to today's behavior under its `organ_context` flag.

## Relationship to the Session Context plan

This plan composes with [SESSION_CONTEXT_PLAN](SESSION_CONTEXT_PLAN.md) (implemented): Cortex already runs an incremental-delta session, so Phase 1 changes *what rides the delta* (a packet, not a 2,000-char clip) and Phase 2 adds *a bounded, cached hydration turn* to that same session. Caching is unaffected — packets are small and stable; hydrated refs are appended as ordinary delta turns and cached like any other.
