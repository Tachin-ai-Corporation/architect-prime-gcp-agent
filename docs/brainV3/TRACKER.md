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

## Phase 5 — Planning Iteration
> Advisory rounds, iterative dispatch-before-plan, Prefrontal delegation

- `[ ]` Cortex SOUL.md: iterative dispatch-before-plan pattern
- `[ ]` Prefrontal SOUL.md v3: envelope model, structured JSON plans, checkpoint decomposition
- `[ ]` Brain: Mission → Checkpoint → Task nesting (M → C → T hierarchy)
- `[ ]` Deploy + test: research → memory → prefrontal → plan → execute flow

---

## Phase 6 — Delegation + Dashboard
> Inter-agent envelope delegation, R/C/M/T dashboard, human-in-the-loop

- `[ ]` Cortex SOUL.md: `delegate` action
- `[ ]` Brain: delegate action handler (create envelope, set waiting, notify)
- `[ ]` Brain: waiting envelope resumption
- `[ ]` Brain: fleet agent awareness
- `[ ]` Dashboard: R/C/M/T tree view component
- `[ ]` Dashboard: envelope detail view
- `[ ]` Dashboard: human-in-the-loop input for `needs_input` envelopes
- `[ ]` Deploy + test: Prime → Stan delegation, human-in-the-loop

---

## Phase 7 — Responsibilities + Rollout
> Cron scheduler, self-management, fleet-wide deployment, deprecated code removal

- `[ ]` Brain: Responsibility scheduler (cron parser, timer, R→M envelope creation)
- `[ ]` Responsibilities config: base, Prime, per-job JSON files
- `[ ]` Motor: responsibility-create / responsibility-remove / responsibility-list tools
- `[ ]` Dashboard: Responsibility view
- `[ ]` Prime deployment: Brain v3 on Prime
- `[ ]` Fleet bootstrap update: manifests, install.sh, fleet-bootstrap.sh
- `[ ]` contracts.json: add brain section
- `[ ]` Deprecated code removal
- `[ ]` Feature flag removal (BRAIN_V3_* → v3 is the only path)
- `[ ]` Fleet-wide rollout + final validation
