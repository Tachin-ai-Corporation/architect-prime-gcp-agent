# Brain v3 — Implementation Tracker

> Reference: [docs/brainV3/](file:///c:/Users/stoph/Antigravity/architect-prime/docs/brainV3/)
> Handoff: [HANDOFF.md](file:///c:/Users/stoph/Antigravity/architect-prime/docs/brainV3/HANDOFF.md)

---

## Phase 1 — Foundation ✅ COMPLETE
> Ears → Firestore intake → Brain classify → envelope → Cortex short_circuit → Mouth

- `[x]` Research: Validate OpenClaw gateway HTTP dispatch to individual agent routes on Stan ✅ works, clean JSON
- `[x]` Research: Validate named sessions via HTTP — ❌ sessions don't persist; Brain passes all context explicitly
- `[x]` Firestore schema: `intake/` collection + indexes ✅ composite index created via gcloud CLI
- `[x]` Firestore schema: `work/` collection + `history/` subcollection + indexes
- `[x]` Agent registry: `build-agent-registry` script + `agent-registry.json` for Stan
- `[x]` Brain service: `agent-brain.mjs` skeleton (intake listener → classify → short_circuit)
- `[x]` Brain service: `agent-brain.service` systemd unit + `start-agent-brain` launcher
- `[x]` Cortex SOUL.md v3: rewrite for `classify` + `short_circuit` (JSON-only responses)
- `[x]` Ears rewire: Firestore intake write (replaces gateway POST)
- `[x]` Mouth rewire: Firestore envelope listener (alongside JSONL tailing)
- `[x]` Manifest: add brain files to `base.txt`
- `[x]` Deploy to Stan + end-to-end test ✅ pipeline verified
- `[x]` Checkpoint verification: "who are you?" flows through entire pipeline ✅ envelope complete with response

### Phase 1 — Deployment Fixes Applied
- Fixed PRIME_ID/AGENT_ID discovery in all three daemon launchers (Docker env + hostname fallback)
- Fixed gateway token discovery in Brain (openclaw.json + env var fallbacks)
- Fixed Firestore query URL (use parent path, not database root)
- Created composite index via `gcloud firestore indexes composite create`
- Moved Brain log to `/tmp/` (writable by node user in Docker)

### Phase 1 — Known Issues (carry-forward)
1. **Dual delivery** — responses flow through BOTH v2 JSONL and v3 envelope paths
2. **Classify field mapping** — Cortex returns `intent` not `classification` (cosmetic)
3. **Stale envelopes** — 3 failed envelopes from pre-fix runs need cleanup

---

## Phase 2 — Cortex Loop
> Single-step dispatch → synthesize cycle. Fresh sessions only (no named sessions).

- `[x]` Cortex SOUL.md: add `dispatch` + `synthesize` + `status_update` actions
- `[x]` Cortex SOUL.md: queue-aware status updates (current work + ordered queue in message)
- `[x]` Brain: full iterative Cortex loop (dispatch → feed back → decide again)
- `[x]` Brain: gateway HTTP dispatch function (`callAgent`) with fresh sessions
- `[x]` Brain: response parser hardening (balanced JSON extraction, Action: block stripping, retry on parse failure)
- `[x]` Brain: gateway liveness polling (`checkGatewayLiveness`) before each dispatch
- `[x]` Brain: queue awareness (pending_intake_count + ordered queue → Cortex → status_update)
- `[x]` Brain: `status_update` action handler (transient envelope for Mouth delivery)
- `[x]` Brain: `[BRAIN-ORCHESTRATED]` marker on all Cortex/agent calls
- `[x]` Fix: suppress JSONL delivery for Brain-initiated sessions (Mouth skips `[BRAIN-ORCHESTRATED]`)
- `[x]` Brain: automated stale envelope cleanup at startup (archive failed envelopes >24h)
- `[ ]` Deploy + test: dispatch to temporal-research, synthesize result


---

## Phase 3 — Memory + Discovery
> Hardwired memory recall/write, active envelope scan, follow-up detection

- `[ ]` Temporal-memory HTTP integration validation
- `[ ]` Brain: hardwired memory recall (pre-loop, every consultation)
- `[ ]` Brain: hardwired memory write (post-loop, on Mission completion)
- `[ ]` Brain: active envelope scan (Firestore query for in-progress work)
- `[ ]` Cortex SOUL.md: `attach` classification support
- `[ ]` Brain: `attach` handling (follow-up, status check, needs_input resumption)
- `[ ]` Deploy + test: memory recall enriches decisions, follow-up detection, needs_input

---

## Phase 4 — Multi-Step Planning
> Cortex returns multi-step plans, Brain executes sequentially, Cerebellum verifies

- `[ ]` Cortex SOUL.md: `plan` action with ordered steps
- `[ ]` Brain: sequential child envelope execution with context accumulation
- `[ ]` Brain: retry-on-failure logic (1 retry, then Cortex consult)
- `[ ]` Cerebellum SOUL.md: envelope-aware structured verification (pass/fail JSON)
- `[ ]` Brain: plan-then-synthesize flow (auto-consult Cortex after last child)
- `[ ]` Deploy + test: multi-step Drive upload with Cerebellum verification

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
- `[ ]` Brain: waiting envelope resumption (poll for completed delegated children)
- `[ ]` Brain: fleet agent awareness (poll for envelopes owned by this agent)
- `[ ]` Dashboard: R/C/M/T tree view component (real-time Firestore)
- `[ ]` Dashboard: envelope detail view (instruction, output, history timeline)
- `[ ]` Dashboard: human-in-the-loop input for `needs_input` envelopes
- `[ ]` Deploy + test: Prime → Stan delegation, human-in-the-loop

---

## Phase 7 — Responsibilities + Rollout
> Cron scheduler, self-management, fleet-wide deployment, deprecated code removal

- `[ ]` Brain: Responsibility scheduler (cron parser, timer, R→M envelope creation)
- `[ ]` Responsibilities config: base, Prime, per-job JSON files
- `[ ]` Motor: responsibility-create / responsibility-remove / responsibility-list tools
- `[ ]` Dashboard: Responsibility view (schedule, last/next fire, enable/disable toggle)
- `[ ]` Prime deployment: Brain v3 on Prime
- `[ ]` Fleet bootstrap update: manifests, install.sh, fleet-bootstrap.sh
- `[ ]` contracts.json: add brain section + validate-contracts update
- `[ ]` Deprecated code removal (brain-exec, brain-exec-worker, check-plan-compliance, etc.)
- `[ ]` Feature flag removal (BRAIN_V3_* flags → v3 is the only path)
- `[ ]` Fleet-wide rollout + final validation
