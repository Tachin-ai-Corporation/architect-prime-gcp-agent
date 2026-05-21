# Brain v3 — Implementation Tracker

> Reference: [docs/brainV3/](file:///c:/Users/stoph/Antigravity/architect-prime/docs/brainV3/)
> Handoff: [HANDOFF.md](file:///c:/Users/stoph/Antigravity/architect-prime/docs/brainV3/HANDOFF.md)

---

## Phase 1 — Foundation ✅ COMPLETE
> Ears → Firestore intake → Brain classify → envelope → Cortex short_circuit → Mouth

- `[x]` Research: Validate OpenClaw gateway HTTP dispatch to individual agent routes on Stan
- `[x]` Research: Validate named sessions via HTTP — ❌ sessions don't persist; Brain passes all context explicitly
- `[x]` Firestore schema: `intake/` collection + indexes
- `[x]` Firestore schema: `work/` collection + `history/` subcollection + indexes
- `[x]` Agent registry: `build-agent-registry` script + `agent-registry.json` for Stan
- `[x]` Brain service: `agent-brain.mjs` skeleton (intake listener → classify → short_circuit)
- `[x]` Brain service: `agent-brain.service` systemd unit + `start-agent-brain` launcher
- `[x]` Cortex SOUL.md v3: rewrite for `classify` + `short_circuit` (JSON-only responses)
- `[x]` Ears rewire: Firestore intake write (replaces gateway POST)
- `[x]` Mouth rewire: Firestore envelope listener (alongside JSONL tailing)
- `[x]` Manifest: add brain files to `base.txt`
- `[x]` Deploy to Stan + end-to-end test ✅

---

## Phase 2 — Cortex Loop ✅ COMPLETE
> Single-step dispatch → synthesize cycle. Fresh sessions only.

- `[x]` Cortex SOUL.md: add `dispatch` + `synthesize` + `status_update` actions
- `[x]` Cortex SOUL.md: queue-aware status updates
- `[x]` Brain: full iterative Cortex loop (dispatch → feed back → decide again)
- `[x]` Brain: gateway HTTP dispatch function (`callAgent`) with fresh sessions
- `[x]` Brain: response parser hardening
- `[x]` Brain: gateway liveness polling
- `[x]` Brain: queue awareness
- `[x]` Brain: `status_update` action handler
- `[x]` Brain: `[BRAIN-ORCHESTRATED]` marker on all Cortex/agent calls
- `[x]` Mouth: Brain v3 envelope polling, LLM classify, delivered_at tracking
- `[x]` Brain: automated stale envelope cleanup at startup
- `[x]` Cortex workspace isolation (workspace-cortex)
- `[x]` Intake retry resilience (classify failures revert to pending)
- `[x]` Deploy + test: dispatch to temporal-research, synthesize result ✅

---

## Phase 3 — Memory + Discovery ✅ COMPLETE
> Hardwired memory recall/write, active envelope scan, follow-up detection

- `[x]` `recallMemory()` — dispatches to temporal-memory before classify
- `[x]` `writeMemory()` — stores completed work after synthesize
- `[x]` `scanActiveEnvelopes()` — queries Firestore for in-progress work
- `[x]` Memory recall wired into `processIntake()` (once, reused for classify + decide)
- `[x]` Memory context wired into `processEnvelope()` decide calls
- `[x]` Active envelope scan wired into classify payload
- `[x]` `attach` classification handler (status check, needs_input resume, follow-up)
- `[x]` `needs_input` action handler in Cortex loop
- `[x]` Firestore composite index: `work(owner, status, created_at)` — creating
- `[x]` Deploy + test: memory recall enriches decisions ✅ (Cortex short-circuited from memory)

### Phase 3 — End-to-End Verified Flow
```
User: "What are the deployed URLs for the tachin-website project?"
 04:54:32 ▸ Ears → intake i-1779166471297-278duk
 04:54:32 ▸ Memory recall: dispatched to temporal-memory
 04:55:16 ▸ Memory returned: 466 chars (43s, cold start)
 04:55:16 ▸ Active envelope scan (failed gracefully — index creating)
 04:55:24 ▸ Cortex classify → new_task (with memory context)
 04:55:31 ▸ Cortex decide → short_circuit (answered FROM MEMORY — no dispatch needed!)
 04:55:33 ▸ Mouth picks up envelope (2s latency)
 04:55:36 ▸ Delivered to GChat via LLM classify ✅
```

---

## Phase 4 — Multi-Step Planning ✅ COMPLETE
> Cortex returns multi-step plans, Brain executes sequentially, Cerebellum verifies

- `[x]` Cortex SOUL.md: `plan` action with ordered steps array
- `[x]` Cerebellum SOUL.md: full rewrite for envelope-aware JSON verdicts (ALL_PASS/FAIL)
- `[x]` Brain: `plan` action handler with sequential child envelope execution
- `[x]` Brain: context accumulation across plan steps
- `[x]` Brain: retry-on-failure (1 retry with error context, then Cortex consult)
- `[x]` Brain: auto-synthesize (plan results fed back to Cortex loop)
- `[x]` Deploy + test: 3-step mission (motor → research → cerebellum) ✅

### Phase 4 — End-to-End Verified Flow
```
18:54:03 ▸ Intake: "document deployment, upload to Drive, research design system"
18:54:47 ▸ Cortex classify → new_mission (type=M)
18:55:00 ▸ Cortex decide → plan (3 steps)
18:55:00 ▸ Step 1/3: motor → Draft + upload MD doc to Drive → ✅ (37s)
18:55:37 ▸ Step 2/3: temporal-research → Research styling → ✅ (31s, 1801 chars)
18:56:08 ▸ Step 3/3: cerebellum → Verify upload + design → ✅ (24s)
18:56:32 ▸ Plan complete 3/3. Cortex → synthesize (Drive link + design system)
18:56:47 ▸ Memory write OK. Mouth delivered to GChat ✅
```

---

## Phase 5 — Planning Iteration + Checkpoint Nesting ✅ COMPLETE
> Iterative dispatch-before-plan, Prefrontal delegation, M→C→T nesting, semantic failure detection

- `[x]` Cortex SOUL.md: `checkpoint_plan` action, dispatch-before-plan, prefrontal delegation rules
- `[x]` Prefrontal SOUL.md: full rewrite v2 markdown → v3 JSON (task + checkpoint plans)
- `[x]` Brain: `checkpoint_plan` action handler — M → C → T nesting
- `[x]` Brain: workspace management (init + cleanup per envelope)
- `[x]` Brain: semantic failure detection (Cerebellum FAIL verdicts + Motor tool failures)
- `[x]` Deploy + test: 3-checkpoint, 6-task mission ✅

### Phase 5 — End-to-End Verified Flow
```
23:17:02 ▸ Intake: complex tachin.ai/1health request
23:17:30 ▸ Cortex classify → new_mission (type=M)
23:17:39 ▸ Cortex decide → dispatch prefrontal (iterative planning!)
23:18:12 ▸ Prefrontal → 2,798 chars structured checkpoint plan
23:18:22 ▸ Cortex decide → checkpoint_plan (3 checkpoints)
23:18:22 ▸ CP1 (Research + Drive docs): 3 tasks → ✅ (63s)
23:19:25 ▸ CP2 (Landing page): 1 task → ✅ (31s)
23:19:57 ▸ CP3 (Deploy + verify): 2 tasks → ✅ (133s)
23:22:10 ▸ Checkpoint plan complete: 3 CP, 6 tasks
23:22:27 ▸ Cortex → synthesize. Memory write OK ✅
```

### Post-Verification Fix: Semantic Failure Detection
- Cerebellum FAIL verdicts were not triggering retry → fixed in callAgent()
- Motor tool failures (DWD token, exit code) were reported as success → fixed with regex detection

---

## Phase 6.5 — Decision Quality ✅ COMPLETE
> Dual memory recall, failure directives, synthesize_with_failure action, Cortex SOUL failure rules

- `[x]` Brain: `recallMemory()` accepts optional `context` param (instruction, context_summary)
- `[x]` Brain: Dual memory recall in `processIntake()` — ambient before classify + enriched after classify
- `[x]` Brain: Failure directive injection after failed dispatches and plan steps
- `[x]` Brain: `synthesize_with_failure` action handler (explicit failure acknowledgment with `failure_summary`)
- `[x]` Brain: Synthesize gate — blocks plain `synthesize` when unresolved failures in prior_results
- `[x]` Cortex SOUL: `synthesize_with_failure` action documentation with example JSON
- `[x]` Cortex SOUL: 4 failure handling rules (12-15): no success after fail, resourceful not repetitive, Cerebellum FAIL = mandatory investigation, check workspace for prior work
- `[x]` Mouth: `orderBy created_at DESC` query — newest envelopes first
- `[x]` Mouth: Poll heartbeat diagnostic logging (every ~5 min)
- `[x]` Mouth: `skippedDelivered` counter for monitoring envelope accumulation
- `[x]` Firestore: Composite index `(owner ASC, status ASC, created_at DESC)` created
- `[x]` Deploy + verified: Stan delivers envelopes correctly, Brain starts clean ✅

### Phase 6.5 — Root Cause Analysis
```
Issue 1: Stan's GChat delivery failure
  Root cause: Mouth query limit=20 returned old delivered envelopes,
    pushing new undelivered envelope past the limit.
  Fix: orderBy created_at DESC + heartbeat logging

Issue 2: Stan claiming success after Cerebellum FAIL
  Root cause: No enforcement in Brain or SOUL preventing Cortex from
    synthesizing a hopeful response when tasks had failed.
  Fix: Failure directives + synthesize gate + synthesize_with_failure

Issue 3: Stan had no memory of work done 1 hour earlier
  Root cause: recallMemory() only used raw chat text ("fix the website")
    which had poor keyword overlap with stored memories about Firebase.
  Fix: Dual recall — second recall enriched with classify instruction
    + context_summary for much better semantic overlap.
```

---

## Phase 7A — Responsibilities + Context Assembly ✅ COMPLETE
> Cron-driven autonomous Responsibilities, R/M/C/T mental model, rich context assembly, per-agent gen params

- `[x]` Brain: Responsibility scheduler (cron parser, next-fire calculation, 60s interval check)
- `[x]` Brain: R→M envelope creation (type=R parent → type=M child → normal Cortex loop)
- `[x]` Brain: Min spacing enforcement (skip if another R fires within N minutes)
- `[x]` Brain: Quick ack — immediate "Got it" delivery when intake is claimed
- `[x]` Config: `corekit/config/responsibilities.json` — base template
- `[x]` Config: `specialties/devops/responsibilities-devops.json`
- `[x]` Brain: Config loader + merger (base + specialty)
- `[x]` Brain: File watcher for responsibility config hot-reload
- `[x]` Cortex SOUL: R/M/C/T mental model rewrite (Option C architecture)
- `[x]` Prefrontal SOUL: Responsibility process authoring guidance
- `[x]` `responsibility-manage` Motor tool: CRUD for `responsibilities-job.json`
- `[x]` Dashboard: R-level in Work tree (name, schedule, last/next fire, enabled)
- `[x]` Rich context assembly: SOUL.md + IDENTITY.md + MEMORY.md + full registry in system prompt
- `[x]` File read cache (60s TTL) for workspace file loading
- `[x]` Envelope context accumulation: rolling 400K token budget with pruning
- `[x]` Per-agent generation parameters from agent-registry.json (max_tokens, temperature, top_p)
- `[x]` Enhanced sub-agent context: Prior Work + Relevant Memory in callAgent()
- `[x]` Gateway parameter validation: confirmed max_tokens, temperature, top_p, top_k passthrough
- `[x]` Deploy + test: Responsibility scheduler fires, context assembly enriches decisions ✅

### Phase 7A — Per-Agent Generation Parameters
```
| Agent            | max_tokens | temperature | top_p |
|------------------|-----------|-------------|-------|
| Cortex           | 32768     | 0.4         | 0.95  |
| Motor            | 65536     | 0.3         | 0.90  |
| Prefrontal       | 32768     | 0.6         | 0.95  |
| Cerebellum       | 8192      | 0.1         | 0.85  |
| Temporal-Research | 16384    | 0.5         | 0.95  |
| Temporal-Memory  | 8192      | 0.3         | 0.90  |
```

## Phase 7B — Fleet Rollout & Orchestration Rollout ✅ COMPLETE
> Brain v3 on Prime + all fleet agents, bootstrap update

- `[x]` Prime: Brain v3 deployment (brain service + systemd)
- `[x]` Prime: agent-registry.json (fleet management tools)
- `[x]` Prime: responsibilities-prime.json (fleet health, upgrade checks)
- `[x]` Prime: Cortex SOUL v3 rewrite
- `[x]` Fleet bootstrap: manifests/base.txt + role-fleet.txt update
- `[x]` Fleet bootstrap: install.sh + fleet-bootstrap.sh update
- `[x]` Cross-agent delegation validation (Prime → Stan → Prime resumes)
- `[x]` Deploy + test: Prime end-to-end through Brain v3 ✅

## Phase 7C — Cleanup + Hardening
> Deprecated code removal, feature flags, contracts, envelope archival

- `[x]` Delete: brain-exec, brain-exec-worker, check-plan-compliance, build-system-prompt
- `[x]` Delete: BRAIN_CARD.md routing hints
- `[x]` Remove: BRAIN_V3_* feature flags (v3 is the only path)
- `[x]` Contracts.json: add brain section + validate-contracts update
- `[x]` Brain: Auto-archive delivered envelopes older than 7 days (status → archived)
- `[x]` Deploy + test: full hire-deploy-message-process-deliver flow ✅

