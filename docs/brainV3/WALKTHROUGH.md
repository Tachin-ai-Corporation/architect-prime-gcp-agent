# Brain v3 — Implementation Walkthrough

> Living document tracking what was built, tested, and learned across all phases.
> Last updated: 2026-05-19 (Phase 4 complete)

---

## Phase 1 — Foundation (2026-05-18)

### What Was Built

Complete rip-and-replace of the agent orchestration pipeline from v2 (conversational LLM-loop) to v3 (deterministic, envelope-based Firestore pipeline).

### Pipeline Architecture (v3)

```
User → GChat → Ears (polls GChat API)
                 ↓
              Firestore intake write (primes/{primeId}/intake/{id})
                 ↓
              Brain (polls intake collection every 3s)
                 ↓ classify
              Cortex → JSON: { intent, route, confidence, reasoning }
                 ↓ decide
              Cortex → JSON: { action: "short_circuit", response: "..." }
                 ↓
              Firestore work envelope (primes/{primeId}/work/{id}, status=complete)
                 ↓
              Mouth (polls completed envelopes → classifies → delivers to GChat)
```

### Files Created
| File | Purpose |
|------|---------|
| `corekit/daemon/agent-brain.mjs` | Brain v3 orchestration service |
| `corekit/daemon/start-agent-brain` | Systemd launcher with PRIME_ID/AGENT_ID discovery |
| `corekit/daemon/agent-brain.service` | Systemd unit file (auto-restart) |
| `corekit/config/agent-registry.json` | Agent capability registry (6 agents) |

### Files Modified
| File | Change |
|------|--------|
| `corekit/daemon/agent-ears.mjs` | Replaced gateway POST with Firestore intake write |
| `corekit/daemon/agent-mouth.mjs` | Added Firestore envelope polling alongside JSONL tailing |
| `corekit/daemon/start-agent-ears` | Added PRIME_ID/AGENT_ID discovery fallbacks |
| `corekit/daemon/start-agent-mouth` | Added PRIME_ID/AGENT_ID discovery fallbacks |
| `brain/fleet/_base/SOUL.md` | Full v3 rewrite: structured JSON mode (classify + decide) |
| `infra/manifests/base.txt` | Added Brain v3 files to fleet manifest |
| `corekit/system/upgrade-corekit` | Added agent-brain.service lifecycle management |

### Deployment Fixes Log

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| 1 | Firestore query 400 | Missing composite index on `intake(status, created_at)` | `gcloud firestore indexes composite create` |
| 2 | PRIME_ID empty | `chat-config.json` has no `primeId` for fleet agents | Docker env fallback |
| 3 | AGENT_ID = "agent" | `chat-config.json` has no `agentId` for fleet agents | Hostname derivation: `fleet-stan` → `stan` |
| 4 | Gateway token not found | Token file not in Docker container | Read from `openclaw.json` + env var fallback |
| 5 | Brain query wrong scope | `runQuery` URL was database root | Changed to `{parent}:runQuery` |
| 6 | Brain log not writable | Node user can't write `/var/log/` in Docker | Moved to `/tmp/agent-brain.log` |

### Commits
- `v2026.05.18.17.1` — Brain v3 ears + mouth rewire
- `v2026.05.18.17.2` — Fix start-agent-brain PRIME_ID/AGENT_ID discovery
- `v2026.05.18.17.3` — Fix brain gateway token discovery
- `v2026.05.18.17.4` — Fix PRIME_ID/AGENT_ID in all three daemon launchers
- `v2026.05.18.17.5` — Fix brain firestoreQuery URL for scoped queries
- `v2026.05.18.17.6` — Add debug logging for cortex response format
- `v2026.05.18.17.7` — Move brain log to /tmp/

---

## Phase 2 — Cortex Loop (2026-05-18 – 2026-05-19)

### What Was Built

Full iterative Cortex decision loop with sub-agent dispatch, synthesis, queue awareness, and complete Mouth delivery integration.

### Pipeline Architecture (Phase 2 — full dispatch cycle)

```
User → Ears → Firestore intake
                ↓
Brain polls → claims intake
                ↓ classify
Cortex → { classification: "new_task", intent: "research" }
                ↓
Brain creates work envelope (type=T, status=pending)
                ↓ decide (iteration 1)
Cortex → { action: "dispatch", agent: "temporal-research", task: "..." }
                ↓
Brain dispatches child envelope → gateway HTTP → temporal-research agent responds
                ↓
Brain feeds result back to Cortex context
                ↓ decide (iteration 2)
Cortex → { action: "synthesize", synthesis: "The pricing is..." }
                ↓
Brain marks envelope complete, writes output to Firestore
                ↓
Mouth polls completed envelopes (Firestore runQuery: owner + status=complete)
                ↓ LLM classify
Mouth → voice/format through Gemini Flash → deliver to GChat
```

### Files Modified
| File | Change |
|------|--------|
| `corekit/daemon/agent-brain.mjs` | Full Cortex loop: dispatch, synthesize, status_update, callAgent, queue awareness, delegate→dispatch normalization, intake retry resilience |
| `corekit/daemon/agent-mouth.mjs` | Fixed Brain v3 runQuery URL, added owner/delivered_at filters, parent_id skip, question context passthrough |
| `brain/fleet/_brain/cortex/SOUL.md` | v3 SOUL with dispatch + synthesize + status_update actions |
| `corekit/config/openclaw-fleet-bootstrap.json5.tmpl` | Cortex mapped to `~/.openclaw/workspace-cortex` |
| `corekit/gateway/render-config` | Prefers fleet template, substitutes AGENT_DISPLAY_NAME + AGENT_ID |
| `corekit/system/upgrade-corekit` | Added `cortex` to brain sub-agent workspace overlay loop |
| `infra/bootstrap/fleet-bootstrap.sh` | Added `cortex` to sub-agent overlay loop |
| `infra/manifests/role-fleet.txt` | Added cortex SOUL.md to fleet manifest |

### Deployment Fixes Log

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| 1 | Cortex used DevOps SOUL | Config pointed cortex at shared `workspace` instead of `workspace-cortex` | Dedicated workspace, updated template + bootstrap + upgrade |
| 2 | `delegate` action unknown | Cortex SOUL sometimes produces `delegate` instead of `dispatch` | Action normalizer in Brain: `delegate` → `dispatch` |
| 3 | render-config used wrong template | Hardcoded to `openclaw-bootstrap.json5.tmpl`, ignored fleet template | Prefers `openclaw-fleet-bootstrap.json5.tmpl` when available |
| 4 | Stuck intakes after classify failure | Gateway HTTP 500 → intake stays `claimed` forever | Reverts to `pending` on classify error for auto-retry |
| 5 | Fleet template missing `{` | My edit removed the cortex object opening brace | Fixed brace, used commit-SHA curl to bypass CDN cache |
| 6 | Mouth never delivered v3 envelopes | `runQuery` URL was `documents:runQuery` (root), not `documents/primes/{id}:runQuery` | Fixed URL to include parent path |
| 7 | Mouth composite index required | Query with status IN + type IN + owner + orderBy needs complex index | Simplified to owner + status EQUAL (no orderBy) |

### End-to-End Verified Flow

**Test:** User sends "How much does a GCP e2-medium instance cost?" to Stan via Google Chat (2026-05-19 04:16 UTC)

```
04:16:18 ▸ Ears → intake i-1779164177081-57tv8y from gchat
04:17:17 ▸ Cortex classify → new_task (intent=research) [59s — cold start]
04:17:17 ▸ Brain creates envelope w-1779164237470-0835d6d4 (type=T)
04:17:23 ▸ Cortex decide → action=dispatch → temporal-research [6s]
04:17:23 ▸ Brain dispatches child w-1779164243467-040679f4 via openclaw/temporal-research
04:18:01 ▸ temporal-research responds (479 chars, 37.5s)
04:18:01 ▸ Brain feeds result back to Cortex, calls decide again
04:18:14 ▸ Cortex decide (iteration 2) → action=synthesize [13s]
04:18:15 ▸ Envelope w-1779164237470-0835d6d4 complete ✅
04:32:33 ▸ Mouth polls envelope, classifies via LLM → action=deliver
04:32:33 ▸ Delivered to GChat (256 chars after voice formatting) ✅
```

**Result:** "The current pricing for a GCP e2-medium instance (1 vCPU, 4GB RAM) typically ranges from $0.033 to $0.055 per hour, which translates to about $24.46 to $39.13 per month."

### Architecture Decisions

1. **Cortex workspace isolation** — Cortex gets its own `workspace-cortex` with a dedicated v3 SOUL. Without this, Cortex inherits the main DevOps workspace SOUL and produces non-standard actions. This required updating the fleet bootstrap template, upgrade-corekit, fleet-bootstrap.sh, and role-fleet.txt.

2. **Action normalization** — Rather than strictly requiring Cortex to use exact action names, Brain normalizes `delegate` → `dispatch`. This is more resilient against model variation and SOUL wording differences.

3. **Intake retry resilience** — When classify fails (e.g., gateway not ready after restart), intake reverts to `pending` instead of staying `claimed`. This provides automatic retry without manual Firestore intervention.

4. **Simplified Firestore queries** — Mouth's envelope poll uses only `owner` + `status` equality filters (no IN, no orderBy). This avoids requiring composite indexes which can take time to deploy and are error-prone.

5. **Mouth handles all delivery** — Brain writes completed envelopes to Firestore. Mouth picks them up, runs through the full LLM classify pipeline (voice formatting, internal suppression, escalation detection), and delivers to GChat. Brain never bypasses Mouth.

### Commits
- `v2026.05.18.23.1` — Phase 2: Cortex loop dispatch/synthesize + queue awareness + dual delivery fix
- `v2026.05.18.23.2` — Cortex workspace isolation + manifest/bootstrap/upgrade + delegate→dispatch normalization
- `v2026.05.18.23.3` — render-config prefers fleet template, substitutes agent display name
- `v2026.05.18.23.4` — Revert intake to pending on classify failure (retry resilience)
- `v2026.05.18.23.5` — Fix missing opening brace in fleet template cortex block
- `v2026.05.18.23.6` — Fix Mouth Brain v3 integration (runQuery URL, owner/delivered filters, question context)
- `v2026.05.18.23.7` — Simplify Mouth envelope query (avoid composite index requirement)

---

## Phase 3 — Memory + Discovery (2026-05-19)

### What Was Built

Hardwired memory recall and write via temporal-memory agent dispatch. Active envelope scan for follow-up detection. Attach classification handler with needs_input resumption.

### Pipeline Architecture (Phase 3 — memory-enriched)

```
User → Ears → Firestore intake
                ↓
Brain polls → claims intake
                ↓ memory recall
Brain dispatches temporal-memory → returns recalled context (e.g. 466 chars)
                ↓ active envelope scan
Brain queries Firestore for in-progress work → passes to Cortex
                ↓ classify (with memory + active envelopes)
Cortex → { classification: "new_task" | "attach", ... }
                ↓
    ┌─ attach → status check / needs_input resume / follow-up
    └─ new_task → create envelope → processEnvelope(envelope, memory)
                    ↓ decide (with memory context)
                    Cortex → dispatch / synthesize / short_circuit / needs_input
                    ↓ on synthesize:
                    Brain calls writeMemory() → temporal-memory stores work summary
```

### Functions Added
| Function | Purpose |
|----------|---------|
| `recallMemory(query)` | Dispatches to temporal-memory agent, returns `{ recalled: "..." }` |
| `writeMemory(envelope)` | Stores completed work (instruction + output + envelope ID) to temporal-memory |
| `scanActiveEnvelopes()` | Queries Firestore `work(owner, status=active)`, returns top-level summaries |
| `handleAttach(intake, decision, memory)` | Routes attach classification: needs_input resume, status check, follow-up |
| `processIntakeAsNewTask(intake, decision, memory)` | Creates new task envelope when attach falls through |

### End-to-End Verified Flow

**Test:** User sends "What are the deployed URLs for the tachin-website project?" to Stan (2026-05-19 04:54 UTC)

```
04:54:32 ▸ Ears → intake i-1779166471297-278duk from gchat
04:54:32 ▸ Memory recall: dispatched to temporal-memory
04:55:16 ▸ Memory returned: 466 chars of Firebase hosting context (43s, cold start)
04:55:16 ▸ Active envelope scan: failed gracefully (index creating)
04:55:24 ▸ Cortex classify (with memory) → new_task
04:55:31 ▸ Cortex decide (with memory) → short_circuit ← ANSWERED FROM MEMORY!
04:55:31 ▸ Envelope w-1779166524821-dd0181e6 complete
04:55:33 ▸ Mouth picks up envelope (2s latency)
04:55:36 ▸ Delivered to GChat via LLM classify (185 chars) ✅
```

**Result:** Cortex used recalled Firebase hosting context to answer directly — no temporal-research dispatch needed. Memory eliminated an agent call.

### Architecture Decisions

1. **One recall per intake** — Memory is recalled once at intake time and reused for both classify and decide. This halves the latency overhead vs recalling separately for each.

2. **Memory write on synthesize only** — Short-circuit responses don't get written to memory. Only synthesize completions (real work with agent dispatches) are worth storing.

3. **Graceful degradation** — All memory/scan functions wrap in try/catch and return empty defaults on failure. Missing indexes, agent errors, or timeouts don't break the pipeline.

4. **Attach handler is a router** — The `handleAttach` function examines the target envelope's status and routes to the appropriate action (resume, status check, or new task). Fallback to `processIntakeAsNewTask` when anything is unexpected.

5. **context_forward for needs_input** — When a human responds to a needs_input envelope, their text is stored in `context_forward` and injected into `priorResults` as a `{ agent: 'human' }` entry.

### Commits
- `v2026.05.19.00.1` — Phase 3: memory recall/write, active envelope scan, attach handler, needs_input support

---

## Phase 4 — Multi-Step Planning (2026-05-19)

### What Was Built

Cortex can now return multi-step plans (`action: plan`). Brain executes steps sequentially, accumulates context, retries failures, and sends Cerebellum for verification. After all steps, Cortex synthesizes the final response.

### Pipeline Architecture (Phase 4 — plan action)

```
Cortex decide → { action: "plan", steps: [...] }
                    ↓
Brain iterates steps sequentially:
    Step 1: create child envelope → dispatch to agent → collect result
             ↓ on failure: retry once with error context
             ↓ on retry failure: break + consult Cortex
    Step 2: dispatch with accumulated context from step 1
    Step 3: dispatch with accumulated context from steps 1+2
    ...
    Step N (cerebellum): verify prior steps → ALL_PASS / FAIL JSON verdict
                    ↓
All plan results fed back to Cortex as prior_results
                    ↓
Cortex → { action: "synthesize", synthesis: "..." }
```

### Files Modified
| File | Change |
|------|---------|
| `brain/fleet/_brain/cortex/SOUL.md` | Added `plan` action with steps array, updated decision rules |
| `brain/fleet/_brain/cerebellum/SOUL.md` | Full rewrite for JSON verdict format (ALL_PASS/FAIL with checks array) |
| `corekit/daemon/agent-brain.mjs` | Added `plan` action handler (~140 lines) |

### End-to-End Verified Flow

**Test:** User sends "document deployment workflow for tachin-website, upload to Drive, research design system" to Stan (2026-05-19 18:54 UTC)

```
18:54:03 ▸ Intake from gchat (multi-step request)
18:54:03 ▸ Memory recall: 26 chars returned (33s, cold start)
18:54:47 ▸ Cortex classify → new_mission (type=M) ← correctly identified as mission!
18:55:00 ▸ Cortex decide → plan (3 steps) ← FIRST PLAN ACTION!
18:55:00 ▸ Plan step 1/3: motor → Draft MD doc + upload to Drive
18:55:37 ▸ Step 1 ✅ completed (37s) — Motor uploaded doc, returned Drive URL
18:55:37 ▸ Plan step 2/3: temporal-research → Research tachin.ai + 1health.io styling
18:56:08 ▸ Step 2 ✅ completed (31s) — 1,801 chars of design analysis
18:56:08 ▸ Plan step 3/3: cerebellum → Verify upload + design quality
18:56:32 ▸ Step 3 ✅ completed (24s) — 757 chars verdict
18:56:32 ▸ Plan execution complete: 3/3 steps. Consulting Cortex.
18:56:47 ▸ Cortex synthesize → final response with Drive link + design system
18:56:47 ▸ Memory write: storing completed mission
18:57:02 ▸ Memory write OK (14s)
18:57:04 ▸ Mouth delivered to GChat ✅
```

**Total time:** ~3 minutes for a 3-step mission (classify + 3 plan steps + synthesize + memory write)

### Architecture Decisions

1. **Plan steps are child envelopes** — each plan step creates a child Task envelope linked to the parent via `parent_id`. Full Firestore observability.

2. **Context accumulation** — each step sees all prior step results in its `context_summary`. Step 3 knows what steps 1 and 2 produced.

3. **Retry then consult** — on failure, Brain retries the same step once with error context injected. If retry also fails, Brain breaks the plan loop and feeds all results (including the failure) back to Cortex, who can adjust, skip, or escalate.

4. **Plan feeds back to Cortex loop** — after plan execution, all step results are added to `priorResults` and the Cortex decide loop `continue`s. Cortex sees all results and issues `synthesize`. This means plans compose with the existing loop — no special exit path needed.

5. **Cerebellum as plan step** — Cerebellum is just another agent in the steps array, not special-cased. It receives the same context accumulation and returns structured JSON. Brain doesn't parse the verdict — it's passed through to Cortex for synthesis.

### Commits
- `v2026.05.19.13.1` — Phase 4: multi-step plan action, sequential execution, retry, Cerebellum JSON verdicts
