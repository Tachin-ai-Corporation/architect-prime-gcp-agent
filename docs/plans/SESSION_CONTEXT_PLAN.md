# Session Context & Prompt Caching Plan

> **Version:** 1.0
> **Status:** Active — approved GO on all phases (2026-07-11)
> **Ownership:** Human maintainers via CODEOWNERS
> **Canon alignment:** Improves B-4 (context economy) and B-8 (fewer tokens per envelope) without weakening B-1 (determinism), B-22 (crash-safety), B-23 (observability), B-28 (verification independence). No new primitive (C-14); every knob in contracts.json (C-7); every mechanism ships with telemetry (C-20) and a kill switch.

## Objective

Convert the brain's context handling from *rebuild everything, every call, unmeasured* to *measured, cached, bounded, and thread-true* — while every LLM interaction remains a daemon-assembled, schema-validated exchange and Firestore envelope state remains the sole source of truth. Anything session-shaped is a **rebuildable cache**: daemon restarts, suspensions (waiting / needs_input / awaiting_approval), and cross-provider fallback degrade to today's stateless re-assembly.

## Verified foundations (live, on-tenant, 2026-07-11)

| Fact | Value | Consequence |
|---|---|---|
| Gemini explicit context caching, 1h TTL | Enforced to the minute; 99.8% of prompt served from cache; reads −75%; storage $0.01/Mtok-hr | Explicit `cachedContent` is a first-class mechanism for Gemini-path stable prefixes |
| Gemini caching floor | 2,048 tokens | Sub-floor prefixes silently uncached |
| Anthropic `cache_control ttl:'1h'` on `claude-opus-4-6` @ us-east5 | Billed under `cache_creation.ephemeral_1h_input_tokens`; warm reads confirmed | 1h TTL is the cortex caching backbone |
| Opus 4.6 caching floor | **4,096 tokens** — silently bypassed below | Stable block must exceed the floor; telemetry must record block sizes so sub-floor misses are explainable |
| Session affinity | `X-Vertex-Ai-Session-Id` header required on load-balanced endpoints | Gateway sends a stable affinity id per agent route |
| Decide-loop cadence | A single motor task can run to the 300s gateway timeout; checkpoint plans run minutes-to-hours inside one decide iteration | 5m TTLs routinely expire mid-mission → 1h TTL is load-bearing, not an optimization |

## Defect register (verified in code; fixed by this plan)

1. **Token telemetry is all zeros.** `loop.mjs` returns hardcoded zero usage on both provider paths (~453/624); daemon readers expect `cachedContentTokenCount` with no fallback; `vertex-text.mjs` discards `usageMetadata` entirely.
2. **The context-overflow prune is a no-op.** `keepFirst = floor(0.1N)` + `keepLast = floor(0.9N)` ≥ N−1 — at most one block pruned per pass (agent-brain.mjs ~3541).
3. **The persisted context budget exceeds Firestore's 1MiB doc limit.** `dispatch.context_token_budget` (400K tokens × 4 chars) allows `_accumulated_context` to grow past what `work/{id}` can store; only `output` is truncation-guarded.
4. **The doubled dispatch transcript.** `context_summary` and `prior_results_context` are both built from `[...allResults, ...cpResults]` at 8,000 chars/step (checkpoint-executor.mjs ~771-785) and injected as two sections per task — quadratic growth, ×2.
5. **The priorResults 25-entry compactor is unreachable** on the normal action-handled path (`continue` precedes it).
6. **`Mode: ${mode}` is the last line of the system prompt** — re-keys the cache prefix across classify/decide/respond even though mode already rides the user payload.
7. **`gateway.forward_gen_params` is a dead contracts key** no code reads.
8. **Dashboard needs_input replies are invisible** to every conversation assembler; **GChat thread context is lossy** beyond the 25×5 poll page; **mouth voicing grounds on a snapshot** frozen at envelope creation.
9. **`corekit/brain/context.mjs` is a complete, orphaned session store** (zero callers; `/status` reports an eternally empty session list).

## Architecture principles

- **Daemon owns every lifecycle event** (C-4/C-5/B-1): cache breakpoints, compaction triggers, session open/close are code-triggered by envelope state or token thresholds — never model-decided.
- **Envelope hierarchy = session hierarchy** (C-15): task = turn; checkpoint = compaction gate; mission = session scope; memory = consolidation gate (B-5). "Roll at N%" = mission-context compaction with a digest.
- **Verification isolation is structural** (B-28): cerebellum/probes never share sessions, thread keys, or mission-content cache prefixes; the `envelope._probe` strip is extended, never bypassed.
- **Digests preserve epistemics** (B-25/B-29): accept_criteria and mission instruction are daemon-copied verbatim; every digest claim carries verified/inferred/assumed.
- **Stateless utility path stays stateless** (C-6): all compaction/summary prose is generated through `vertex-text.mjs`.

## Phases

### Phase 0 — Real token telemetry (v2026.07.11.3.x)
Capture Anthropic `response.usage` (incl. `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation` TTL breakdown) and Gemini `usageMetadata`, summed across intra-turn steps, plus `last_step_input_tokens` (the compaction trigger signal). Gateway returns one dual-keyed usage shape (OpenAI names + daemon-expected aliases + `cacheCreationTokenCount`). Daemon `_tokenUsage` accumulators gain cache-write tracking; classify gets an intake-scoped telemetry line (it runs pre-envelope and is invisible to `mission_total`). `vertex-text.mjs` logs `utility_usage` counts. Fallback double-spend logged with provider tags.
**Files:** corekit/brain/loop.mjs, corekit/brain/index.mjs, corekit/lib/vertex-text.mjs, corekit/daemon/agent-brain.mjs, corekit/daemon/actions/checkpoint_plan.mjs.

### Phase 0b — Latent-bug hygiene (v2026.07.11.4.x)
Fix the prune (keep first 10% + last 50%, drop the true middle); lower `dispatch.context_token_budget` to a Firestore-safe value with a validate-contracts guard (`budget × 4 chars < 900K`); extend the firestore.mjs write truncation guard to `_accumulated_context`; hoist the priorResults budget check to the top of the decide loop; remove `gateway.forward_gen_params`; add `vertex.context_windows` (model → window tokens).
**Files:** corekit/daemon/agent-brain.mjs, corekit/lib/firestore.mjs, infra/contracts.json, corekit/system/validate-contracts.

### Phase 1 — Deterministic dedup (v2026.07.11.5.x)
New pure `corekit/lib/compaction.mjs` (checkpoint digest renderer, budget math; unit-tested; manifest entry same commit). Checkpoint completion writes a deterministic digest (per-step verdict + 300-char excerpt + envelope-id pointers + accept_criteria verbatim, capped by `compaction.checkpoint_digest_chars`) to a **new `_cp_digest` field** — never `context_forward`, which is the live B-27 resume/human-injection surface. Task dispatches receive digests-of-completed-checkpoints + verbatim current-checkpoint results sent **once** (dispatch `context_summary` dropped; the persisted 300-char `tEnv.context_summary` written at checkpoint-executor ~726 is retained — writeMemory and deliverable composition read it). Remove the `Mode:` line from buildSystemPrompt (JSON-only constraint stays; mode verified present in user payloads). Drop the raw `agent_registry` from the decide payload (capabilities summary already in system prompt) after grepping SOUL prose for references.
**Expected:** −50–60% dispatch input tokens on multi-checkpoint missions; zero new LLM calls.

### Phase 2 — Prompt caching (v2026.07.11.6.x)
New pure `corekit/lib/prompt-blocks.mjs`: assembles ordered blocks — [boot-stable][mission-static][append-only][volatile] — with the `[BRAIN-ORCHESTRATED]` header folded into boot-stable and the Requester line into mission-static; breakpoint-cap arithmetic (≤4 total, longer TTL strictly earlier) as pure, unit-tested functions. buildSystemPrompt emits two system messages: [SOUL, IDENTITY, capabilities, project registry, process registry] and [MEMORY.md] — memory last so its writes stop re-keying the stable prefix. Gateway (`index.mjs`) accepts OpenAI content-parts arrays additively (string content byte-identical path) and preserves multiple system messages as separate blocks. `loop.mjs` places `cache_control` per computed layout — BP1 system stable (ttl from `vertex.anthropic_cache_ttl_stable`, default `1h`), BP2 boot-stable payload (1h), BP3 mission-static (`vertex.anthropic_cache_ttl_mission`, default `1h` per verified support); **no append-only breakpoint** (structurally cannot hit); logs block token sizes (Opus 4,096-token floor observability); sends `X-Vertex-Ai-Session-Id` (stable per agent route per gateway process) when `vertex.anthropic_session_affinity` is true. Google path concatenates parts (Gemini implicit caching rewards the same ordering). Gemini explicit `cachedContent` (1h TTL, gateway-side lifecycle keyed by content hash) ships behind `vertex.gemini_explicit_cache` **default false** — flipped when Phase 0 telemetry shows implicit hit rates under target on motor's stable prefix.
**Expected:** −30–40% cortex billed input warm; −75% cached Gemini reads; TTFT −20–40% on hits. Master switch: `vertex.anthropic_prompt_caching`.

### Phase 3 — Bounded rolling context (v2026.07.11.7.x+)
Prereq: field-masked PATCH (`updateMask`) support in `corekit/lib/firestore.mjs` (whole-doc PATCH races with child-completion writers). Then the roll: at the top of each decide iteration (mission-bound only), `shouldCompact(last_step_input_tokens + est. delta, window × compaction.trigger_pct, …)`; the transaction (replay-guarded by history logicalKey `compact-{id}-{seq}`, seq = `_compaction.seq + 1` monotonic): optional redacted raw-window commit to git via explicit commitAndSync (behind `compaction.session_log_to_git`, **default false**; splice aborts if the commit fails), two-step digest (vertex-text `transform` → hard shape validation; B-29 bins; verbatim criteria/instruction prepended deterministically), field-masked PATCH of `{_accumulated_context, _compaction}`, `[CONTEXT COMPACTED — seq k]` marker + priorResults `[SYSTEM]` roll notice. Digest blocks are pinned against the fallback prune; fallback is the *fixed* deterministic prune, loud. Mission-lifetime iteration numbering (offset persisted) so markers are unique across daemon lives. Compact-on-suspend when entering waiting/needs_input/awaiting_approval above 50% of budget. Memory rung: `session-summary` gains a Digest section reading `_compaction` digests (skills/memory-consolidate/SKILL.md updated same commit, B-17); `durable_learnings` line (≤300 chars, FIFO by `compaction.learnings_max_entries`) appended to responsibility `context.prior_learnings` for responsibility-born missions (07-RESPONSIBILITY.md, project-ops SKILL.md, authoring guide updated same commit — the field gains a line-format convention). B-28 unit test: probe payloads never contain `[CONTEXT COMPACTED`.
**Expected:** long-mission decide input bounded at ~trigger_pct × working budget; digest-sized resumes; pre-binned memory promotion candidates.

### Phase 4 — Thread ledger (v2026.07.11.8.x+)
Commit 4.0 lands the **B-32 amendment** (docs/BRAIN_CANON.md) and SOUL prose update first — wording distinguishes deterministic daemons (brain/mouth may assemble and read the ledger) from cognitive organs (never fetch). Then `corekit/lib/thread-ledger.mjs`: `threadKeyFor` (case-preserving, collision-free encoding of GChat resource names), idempotent `appendTurn` keyed on channel message identity (ears carries `message.name` + `rawText` on intake docs; dashboard uses message doc ids; intake id only as last resort), per-turn 8K-char cap, C-8 scrub over every persisted copy including denormalized thread-doc fields; `readThread`; watermark-preconditioned `compactThread` (at-most-once advancement). Brain appends the admin turn at the true intake-claim site (before delegation/approval early returns); needs_input replies resolve thread_key via the `responding_to` envelope and are also written to `primes/{id}/messages`; envelopes stamp `thread_key` (added to the `_probe` exclusion list). Mouth appends the delivered voiced text (stable status-turn ids) with one bounded retry, and voices from the ledger keyed off the **resolved** delivery address (`conversation.voicing_ledger_enabled`). Dashboard classify keeps `assembleConversation` primary; the ledger is primary for GChat. Archival gains a thread-turn sweep (`conversation.turn_retention_days`). Counters derived at read time (no racy read-modify-write across three daemons).
**Expected:** ~100% observed-turn retention on GChat threads; needs_input replies visible; voicing staleness → ~0; token-neutral.

### Phase 5 — Gateway sessions (v2026.07.11.9.x+, paced by telemetry)
Commit 5.1 ships **dark**: `context.mjs` rewritten as a token-accounted, activity-TTL'd, LRU-capped session store (systemHash excludes MEMORY.md; per-turn tool_result content capped at `utility.context_budgets.agent_step`); `index.mjs` accepts an optional `session {id, op: open|continue|reset, seq}` body field with a specified fast-miss shape `{session:{present:false}}` (daemon treats a missing session echo as hard protocol failure — fail closed), `DELETE /v1/sessions/{id}`, enriched `/status`; `session.excluded_agents` ships `["cerebellum"]` enforced gateway-side; `loop.mjs` returns `localHistory` instead of discarding it. Commit 5.2: `corekit/lib/session-protocol.mjs` (key derivation with generation counters, static/delta payload split, compaction integration with Phase 3 digests) + the cortex per-mission decide session: open at mark-active, per-iteration delta turns, **coerced JSON** appended as assistant turns (never raw garbage), reset on hard repair failure, teardown in completeEnvelope and every suspend handler, consecutive-miss circuit breaker, per-turn delta digests persisted to envelope telemetry (B-23 replayability). Memory recalled once per session lifetime. Commit 5.3 (conditional): motor per-plan sessions only if measured inter-task cadence beats what Gemini implicit+explicit caching already delivers — never uncapped transcripts.
**Expected:** delta-only daemon→gateway traffic; prompt processing scales with the turn, not the mission; model reasons over its own verbatim prior decisions.

## Contracts surface (all validated at bootstrap, C-19)

```
vertex:      anthropic_cache_ttl_stable, anthropic_cache_ttl_mission, anthropic_cache_message_breakpoints,
             anthropic_session_affinity, gemini_explicit_cache, gemini_explicit_cache_ttl_seconds, context_windows
compaction:  enabled, trigger_pct, working_budget_tokens, min_compactable_tokens, keep_recent_iterations,
             max_compactions_per_mission, digest_max_chars, checkpoint_digest_chars, session_log_to_git, learnings_max_entries
conversation: thread_ledger_enabled, summary_max_chars, compact_after_turns, compact_trigger_chars,
             turn_retention_days, voicing_ledger_enabled
session:     enabled, idle_ttl_minutes, max_sessions, compact_at_tokens, max_turns, motor_token_ceiling, excluded_agents
```

## Rollout & measurement

Each phase: implement → unit tests (pure cores, B-19) → version-prefixed commit(s) → deploy via dashboard upgrade → verify on-VM (telemetry lines, /status) → `STABLE` tag when verified. The B-8 ledger (tokens and LLM calls per completed envelope, cache read/write splits, attended vs billed) is the acceptance metric for every phase; a measurement checkpoint after Phase 2 re-prices Phases 3–5 with real numbers. Every mechanism reverts to today's behavior under its contracts flag.
