# Temporal-Memory as the Brain's Memory Authority

> **Version:** 0.1
> **Status:** Proposed — implementing now. Grounded in last night's blocked consolidation (mission `w-1784793653477-f684c07c`, 2026-07-23 08:00 UTC): `p-memory-consolidate` pruned MEMORY.md (2,049→604 chars) but **Core Memory reconciliation and Deep Truths review never ran** — cortex's re-planning routed them to `temporal-memory`, which is **toolless**, so it stalled (*"cannot retrieve Core Memory data"*) and the mission **blocked** after ~4 min of verification churn.
> **Ownership:** Human maintainers via CODEOWNERS.
> **Canon alignment:** Amends the organ table + **B-3/B-5/B-16/B-17** to make temporal-memory the **memory authority** — recall + consolidation are **one job in two modes** (hot retrieve / cold record), not a second job (B-3 intact). It **owns and executes** the memory skills, mutating **only its memory layers** (Motor remains the only mutator of *external* state). **B-5** gains the weighting principle (signal density = memory weighted by value). Preserves **C-5** (daemon moves hot-path data), **B-1** (determinism), **B-28** (verification isolation), **C-28** (layer purity). Every knob in `contracts.json` (**C-7**); telemetered (**C-20**); revertible.

## Objective

Make temporal-memory the single locus of memory for the whole brain. It **owns and executes** both memory skills — recording (consolidation) and retrieval (recall strategy) — and curates the memory system's **signal density by value** so every other organ receives the high-value "good stuff," pruned and ranked. All memory improvements (weighting, a learnings index, an eventual graph) route *through* temporal-memory.

The load-bearing nuance that keeps this canon-coherent: **the recall hot path stays daemon-prefetched** (C-5 — fast, deterministic, parallel), with temporal-memory owning the *strategy* and reasoning over the pre-loaded data; **consolidation is the cold path where temporal-memory executes tools** (nightly, latency-insensitive). This resolves the misroute without slowing recall.

## Verified foundations (canon + code + the live failure)

| Fact | Where | Consequence |
|---|---|---|
| Canon frames temporal-memory as read-only recall | organ table `docs/BRAIN_CANON.md:92` ("Judgment, read-only \| Recall what the agent already knows \| … Touches external APIs"); diagram `:81-83` | Canon and its SOUL forbid the tools consolidation needs — the root contradiction |
| SOUL says it consolidates **and** forbids tools | `brain/fleet/_brain/temporal-memory/SOUL.md:44-46` ("follow the memory-consolidate skill") vs `:51` ("I do not call external APIs or Workspace tools — that is Motor's job") | Consolidation gets misrouted to a toolless organ → stall |
| The consolidation tools exist and run only with tool access | `corekit/memory/{core-memory-read,core-memory-write,core-memory-retire,update-deep-truths,session-summary}` | Only an organ with tool access (motor today; temporal-memory after this) can run them |
| The process already assigns motor, but mission re-planning doesn't | `corekit/config/processes/p-memory-consolidate.json` (steps → `agent: motor`) | The "who runs it" story is split across process/SOUL/skill — legible only after this plan |
| Weighting seeds exist but are dormant | `core_memory` schema: `confidence` (stored, unused), `recallCount`/`lastRecalledAt` (**written once, never updated** — dead), `tags[]` (flat); recall ranks by raw keyword `match_count` (`core-memory-read`) | The "value" signal the user wants is 80% scaffolded and 0% wired |
| The only real ranking is ephemeral and work-only | `corekit/lib/work-recall.mjs:26-43` (`scoreRelevance` = termOverlap × recency-half-life(30d) × status × type) | Core Memory has no value-ranked retrieval today |

## Defect register (what this plan fixes)

1. **Canon contradiction.** Temporal-memory is canonically "read-only recall / no external APIs," yet its SOUL assigns it consolidation (a write). The organ that is *supposed* to own memory cannot perform half its job.
2. **Consolidation misroutes and blocks.** Because temporal-memory is toolless, Core Memory / Deep Truths work either goes to motor (which isn't the memory expert) or stalls on temporal-memory. Last night it stalled → blocked.
3. **A side-effecting process with no verifiable artifact.** Consolidation mutates but emits no structured report, so cerebellum FAILs "no report" and cortex churns to reconstruct it.
4. **Self-pollution.** `writeMemory` appends the consolidation mission's own entry back into the just-pruned MEMORY.md.
5. **Dead value signal.** `confidence`/`recallCount`/`lastRecalledAt` are written but never used or updated; retrieval can't surface "the good stuff first."

## Architecture principle

- **One memory authority** (B-3): temporal-memory's single job is the agent's memory. Recall and consolidation are two *modes* of that one job — never a second job.
- **Hot/cold split** (C-5/B-1): recall (hot) is daemon-prefetched and temporal-memory reasons; consolidation (cold) is executed by temporal-memory with its memory tools. Determinism and latency of the hot path are preserved.
- **Memory-scoped mutation** (C-28 stream separation): temporal-memory mutates **only** the memory layers (Working/Core/Deep Truths) via its memory skills; Motor stays the only mutator of external/world state; Research owns the web.
- **Value discipline** (B-5): memory earns its place by value — record high-value learnings, retire the rest, and surface the best first. Temporal-memory owns this discipline for the whole brain.
- **Right layer, one purpose** (C-28): canon states the principle; SOUL states identity; skills carry procedure + strategy + tool syntax; brain code carries the deterministic mechanics. No layer holds another's content.

## Phases

### Phase 1 — Canon (`docs/BRAIN_CANON.md`)
Reclassify **Temporal-Memory** in the organ table + ASCII diagram: one job → *"Curate the agent's memory: recall high-value knowledge on demand; record and reconcile it in consolidation"*; nature → *Judgment + memory-scoped effects*; never → *reach beyond memory (web = Research; arbitrary/Workspace mutation = Motor); invent facts*. Clarify Motor is the only mutator of **external** state (temporal-memory mutates only memory). Amend **B-5** with the weighting principle (signal density = memory weighted by value; temporal-memory owns the discipline). Amend **B-16/B-17**: each organ owns and executes the skills of its one job ("across the board"); update the B-17 Temporal-Memory row to "owns and executes the memory skills (record + retrieve)."
**Expected:** canon sanctions temporal-memory holding memory tools; the weighting principle has a canonical home.

### Phase 2 — Brain code: unblock consolidation (`corekit/`)
Grant temporal-memory tool access on the **consolidation dispatch path** (not the recall hot path). Reassign `corekit/config/processes/p-memory-consolidate.json` steps to `temporal-memory` and add a final **structured-report artifact** step (items triaged / retired / promoted / deep-truths / final MEMORY.md chars) that cerebellum verifies. Add the `writeMemory` self-pollution guard (exclude the consolidation mission from the MEMORY.md append). 
**Files:** `corekit/daemon/agent-brain.mjs` (tool-access gating per organ + `writeMemory` guard), `corekit/config/processes/p-memory-consolidate.json`, possibly `corekit/brain/router.mjs`/registry.
**Expected:** last night's failure class is closed — consolidation runs on temporal-memory, mutates, and emits a verifiable report.

### Phase 3 — Skills (`skills/memory-*`) — the strategies
- **`memory-consolidate` (recording):** executor = temporal-memory; **value/promotion criteria** (a learning that recurred, led to success, or is load-bearing → higher weight); reconcile phases; the report contract. Tool syntax lives here.
- **`memory-recall` (retrieval):** the ranking/pruning doctrine — surface the good stuff first (weight × confidence × usage × recency), escalation strategy, building a pruned high-value packet.
**Expected:** temporal-memory is "well-versed in both recording and retrieval strategies," codified where procedure belongs (B-16).

### Phase 4 — SOUL (`brain/{fleet/_brain,prime}/temporal-memory/SOUL.md`; organ-locked)
Reframe identity: the memory authority that recalls high-value knowledge and records/reconciles memory for the good of every organ. Fix the boundary: it **uses its memory tools** (core-memory-*, update-deep-truths, session-summary); it does **not** touch web (Research) or arbitrary Workspace/state (Motor). State the value discipline as principle (no tool syntax — that's skills). Keep anti-foreclosure + B-29 bin. Re-pin `ORGAN_LOCK.json`, `organ-change: intended`.
**Expected:** SOUL and canon agree; no procedure leaks into SOUL.

### Phase 5 — Weighting mechanics (Stage A) (`corekit/`)
Activate the dormant value signal: increment `recallCount`/`lastRecalledAt` when a fact is actually surfaced; add an `importance`/`weight` field (set at promotion by consolidation); rank `core-memory-read` by **weight × confidence × usage × recency** instead of raw keyword count; daemon Layer-B recall consumes the ranked order. Contracts: a `memory` block (weighting on/off, usage-signal on/off, default importance, ranking weights). Telemetry: `[TELEMETRY] mem_rank`.
**Expected:** recall returns high-value Core Memory first — the "pruned good stuff."

### Phase 6 — Roadmap through temporal-memory (later, evidence-paced)
- **Stage B — curated learnings index:** promote high-value work `durable_learnings` into a weighted `learnings` category with topic tags; a recall layer "top learnings for `<topic>`" returns a pruned, ranked set (not the raw work ledger).
- **Stage C — graph:** typed edges between memory items (`relates_to`, `caused_by`, `derived_from_work:<id>`, `contradicts`), traversal at recall, optionally embeddings (Firestore vector search vs. a local index — a real infra decision). Strategy in temporal-memory's skills; mechanics in brain code.

### Phase 7 — Verify + roll
Canary Millie: re-run consolidation → **completes** (not blocked), report emitted, MEMORY.md pruned and stable, Core Memory reconciled; a recall surfaces top-weighted learnings first. Fleet-wide after a clean pass; adversarial review of the dispatch/tool-access change before fleet.

## Contracts surface (validated at bootstrap, C-19)
```
memory:  weighting_enabled, usage_signal_enabled, default_importance,
         rank_weight_importance, rank_weight_confidence, rank_weight_usage, rank_weight_recency,
         consolidation_executor  (= "temporal-memory")
```

## Rollout & measurement
Each phase: implement → pure-core unit tests where applicable (B-19) → version-prefixed commit(s) → canary Millie → verify → fleet-wide → note. Acceptance: last night's consolidation class **completes not blocks**; `mem_rank`/`recall_layers` telemetry shows value-ranked Core Memory; MEMORY.md stays lean and un-self-polluted. Everything reverts under its `memory`/organ flags.

## Relationship to other plans
Composes with [ORGAN_CONTEXT_SHARING_PLAN](ORGAN_CONTEXT_SHARING_PLAN.md) (memory items become weighted packets — summary + ref + importance) and [SESSION_CONTEXT_PLAN](SESSION_CONTEXT_PLAN.md) (consolidation already consumes `_compaction.durable_learnings`; Stage B indexes them).
