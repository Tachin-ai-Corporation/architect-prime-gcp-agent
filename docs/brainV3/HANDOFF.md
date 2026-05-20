# Brain v3 — Session Handoff

> **Purpose:** Get a new session agent up to speed on the Brain v3 implementation.
> **Last updated:** 2026-05-20T01:56:00Z
> **Status:** Phase 6.5 COMPLETE ✅ — Decision quality (dual memory recall, failure directives, synthesize_with_failure, Cortex SOUL failure rules). Next: Phase 7A (Responsibility scheduler).

---

## Quick Start

1. **Read the architecture:** `docs/brainV3/00-CORE-CONCEPTS.md` (the design bible)
2. **Read the roadmap:** `docs/brainV3/01-ROADMAP.md` (7-phase plan)
3. **Read this file** for current state, working process, and what's next
4. **Read the task tracker:** `docs/brainV3/TRACKER.md` (detailed checklist per phase)
5. **Read the next phase doc:** `docs/brainV3/08-PHASE-7-RESPONSIBILITIES.md`

---

## What is Brain v3?

A full rip-and-replace of the agent orchestration architecture from v2 (conversational LLM-loop) to v3 (deterministic, envelope-based Firestore pipeline). The key principle: **LLMs think. Deterministic systems orchestrate.**

### v2 (retired)
```
User → Ears → gateway POST → Cortex LLM session → Mouth tails JSONL → delivers
```
- Brittle: LLM decides execution order conversationally
- No state machine: just a chat session file
- No observability: can't inspect what happened or why

### v3 (live on Stan)
```
User → Ears → Firestore intake → Brain polls → Cortex classify → Cortex decide
                                  Brain creates work envelope (R/C/M/T state machine)
                                  Brain dispatches to sub-agents → feeds results back to Cortex
                                  Cortex synthesizes final response
                                  Mouth polls completed envelopes → LLM voice/format → delivers to GChat
```
- Deterministic: Brain is a state machine, Cortex only provides decisions
- Observable: every state transition is in Firestore
- Scalable: R/C/M/T hierarchy (Responsibilities, Checkpoints, Missions, Tasks)

---

## Current State (as of 2026-05-20)

### What's Live
- **Phase 1: Foundation** — COMPLETE ✅
- **Phase 2: Cortex Loop** — COMPLETE ✅
- **Phase 3: Memory + Discovery** — COMPLETE ✅
- **Phase 4: Multi-Step Planning** — COMPLETE ✅
- **Phase 5: Planning Iteration + Checkpoint Nesting** — COMPLETE ✅
- **Phase 6: Delegation + Dashboard** — COMPLETE ✅
- **Phase 6.5: Decision Quality** — COMPLETE ✅
- **Stan** is running Brain v3 in production (fleet-stan VM)
- Full pipeline verified: intake → dual memory recall → classify → enriched recall → decide → dispatch → M→C→T hierarchy → delegation → synthesize (with failure gate) → memory write → Mouth (orderBy DESC poll) → GChat
- Dashboard Work tab live: M→C→T tree view, envelope detail, human-in-the-loop respond

### Phase 6.5 Accomplishments
- Brain: Dual memory recall — ambient recall before classify + enriched recall after classify (using classify instruction + context_summary)
- Brain: Failure directive injection after failed dispatches and plan steps
- Brain: `synthesize_with_failure` action handler (requires `failure_summary` field)
- Brain: Synthesize gate — blocks plain `synthesize` when unresolved failures in `prior_results`
- Cortex SOUL: `synthesize_with_failure` action documentation + 4 failure handling rules (12-15)
- Mouth: `orderBy created_at DESC` query, heartbeat logging, skippedDelivered counter
- Firestore: Composite index `(owner ASC, status ASC, created_at DESC)` created
- Root causes fixed: Mouth delivery crowding, premature success synthesis, poor memory recall

### Key Infrastructure
| Component | File | Status |
|-----------|------|--------|
| Brain service | `corekit/daemon/agent-brain.mjs` | ✅ Phase 6.5 decision quality (~1677 lines) |
| Brain launcher | `corekit/daemon/start-agent-brain` | ✅ PRIME_ID/AGENT_ID/BRAIN_V3 discovery |
| Brain systemd unit | `corekit/daemon/agent-brain.service` | ✅ Enabled, auto-restart |
| Ears (rewired) | `corekit/daemon/agent-ears.mjs` | ✅ Writes Firestore intake |
| Mouth (dual mode) | `corekit/daemon/agent-mouth.mjs` | ✅ JSONL tailing + Brain v3 envelope poll (orderBy created_at DESC, heartbeat, skippedDelivered) |
| Cortex SOUL v3 | `brain/fleet/_brain/cortex/SOUL.md` | ✅ classify + decide (all actions incl. checkpoint_plan + delegate + synthesize_with_failure + failure rules 12-15) |
| Prefrontal SOUL v3 | `brain/fleet/_brain/prefrontal/SOUL.md` | ✅ JSON task/checkpoint plan decomposition |
| Cerebellum SOUL v3 | `brain/fleet/_brain/cerebellum/SOUL.md` | ✅ JSON verdict verification (ALL_PASS/FAIL) |
| Temporal-memory | `brain/fleet/_brain/temporal-memory/SOUL.md` | ✅ Recall + write via Brain dispatch |
| Agent registry | `corekit/config/agent-registry.json` | ✅ 6 agents registered |
| Firestore indexes | `intake(status, created_at)`, `work(owner, status, created_at)` | ✅ Live |
| Dashboard Work tab | `app/src/app/page.tsx` + `app/src/lib/` | ✅ M→C→T tree, detail, respond form |
| Dashboard Work API | `app/src/app/api/primes/[id]/work/` | ✅ Server-side Admin SDK (GET + POST respond) |

### Known Issues (carry-forward to Phase 7)
1. **Memory recall cold start latency** — First temporal-memory call takes ~43s (cold start). Subsequent calls are faster.
2. **No quick ack** — Brain v3 doesn't send an immediate "got it" to the channel. **Approved for Phase 7A.**
3. **Envelope accumulation** — Old delivered envelopes accumulate in Firestore. orderBy DESC mitigates. **Auto-archive approved for Phase 7C.**
4. **upgrade-corekit CRLF warning** — Non-fatal syntax error from Windows CRLF. Doesn't affect function.

---

## Working Process

### How We Work Through Phases

1. **Read the phase doc** — `docs/brainV3/0X-PHASE-X-*.md` has the full design
2. **Create a checkpoint plan** — implementation_plan.md with specific file changes, get user approval
3. **Update the tracker** — `docs/brainV3/TRACKER.md` with task items for the phase
4. **Implement** — Code, commit, push, deploy to Stan
5. **Verify on Stan** — End-to-end test via GChat, check logs + Firestore
6. **Update the walkthrough** — `docs/brainV3/WALKTHROUGH.md` with what was done + test results

### Deployment Process
```bash
# 1. Commit and push
git add -A; git commit -m "v2026.MM.DD.HH.N: description"; git push origin main

# 2. Deploy to Stan
echo y | gcloud compute ssh fleet-stan --zone=us-central1-a --project=architect-prime-beta \
  --tunnel-through-iap --command="sudo CORE_REF='main' OC_HOST_ROOT=/opt/openclaw \
  /opt/openclaw/.openclaw/bin/upgrade-corekit --apply 'main'"

# 3. Check logs
# Brain:
echo y | gcloud compute ssh fleet-stan ... --command="sudo docker exec openclaw-gateway tail -30 /tmp/agent-brain.log"
# Mouth:
echo y | gcloud compute ssh fleet-stan ... --command="sudo tail -20 /var/log/agent-mouth.log"

# 4. Hot-deploy a single file (when upgrade-corekit CDN cache lags):
echo y | gcloud compute ssh fleet-stan ... --command="sudo curl -sfL \
  'https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/{COMMIT_SHA}/path/to/file' \
  -o /opt/openclaw/.openclaw/bin/filename"
```

### SSH Access Pattern
- **Stan VM:** `fleet-stan` in `us-central1-a`, project `architect-prime-beta`
- **Always use IAP:** `--tunnel-through-iap`
- **Commands run as root via sudo**
- **Docker container:** `openclaw-gateway` — all services run inside this container
- **PowerShell quoting:** Complex inline scripts break in PS. Use SCP + `bash /tmp/script.sh` pattern instead.

### Key Paths on Stan
| Path | Description |
|------|-------------|
| `/opt/openclaw/.openclaw/` | Host-side OpenClaw root |
| `/home/node/.openclaw/` | Container-side OpenClaw root (mounted from host) |
| `/tmp/agent-brain.log` | Brain debug log (inside container) |
| `/var/log/agent-mouth.log` | Mouth log (host-side, via systemd) |
| `/tmp/agent-ears-state/` | Ears state dir (highwater, seen.json) |
| `/home/node/.openclaw/workspace-cortex/SOUL.md` | Active Cortex SOUL (isolated workspace) |
| `/home/node/.openclaw/corekit/agent-registry.json` | Agent capability registry |
| `/home/node/.openclaw/corekit/contracts.json` | Gateway contracts |

### Firestore Paths
| Path | Description |
|------|-------------|
| `primes/chucknorris/intake/{id}` | Intake records from Ears |
| `primes/chucknorris/work/{id}` | Work envelopes (R/C/M/T state machine) |
| `primes/chucknorris/work/{id}/history/{seq}` | Status transition log |

---

## What's Next: Phase 7A — Responsibility Scheduler

**Goal:** Agents run scheduled work autonomously. Stan gets cron-driven Responsibilities. Quick ack on intake.

**Read:** `docs/brainV3/08-PHASE-7-RESPONSIBILITIES-ROLLOUT.md` for the original design.

Key work items (Phase 7A):
1. Responsibility scheduler in Brain — cron parser, next-fire calculation, 60s interval, R→M envelope creation
2. Responsibilities config — base + per-specialty JSON files, loader + merger
3. Quick ack — immediate "Got it, working on this..." when Brain claims intake
4. Dashboard — R-level in Work tree
5. Deploy + test on Stan

Followed by:
- **Phase 7B**: Fleet rollout (Prime + all fleet agents + bootstrap update)
- **Phase 7C**: Cleanup (deprecated code removal, feature flags, contracts, envelope archival)

---

## Commit History (Phase 1)
- `v2026.05.18.17.1` — Brain v3 ears + mouth rewire
- `v2026.05.18.17.2` — Fix start-agent-brain PRIME_ID/AGENT_ID discovery
- `v2026.05.18.17.3` — Fix brain gateway token discovery
- `v2026.05.18.17.4` — Fix PRIME_ID/AGENT_ID in all three daemon launchers
- `v2026.05.18.17.5` — Fix brain firestoreQuery URL for scoped queries
- `v2026.05.18.17.6` — Add debug logging for cortex response format
- `v2026.05.18.17.7` — Move brain log to /tmp/

## Commit History (Phase 2)
- `v2026.05.18.23.1` — Phase 2: Cortex loop dispatch/synthesize + queue awareness + dual delivery fix
- `v2026.05.18.23.2` — Cortex workspace isolation + manifest/bootstrap/upgrade + delegate→dispatch normalization
- `v2026.05.18.23.3` — render-config prefers fleet template, substitutes agent display name
- `v2026.05.18.23.4` — Revert intake to pending on classify failure (retry resilience)
- `v2026.05.18.23.5` — Fix missing opening brace in fleet template cortex block
- `v2026.05.18.23.6` — Fix Mouth Brain v3 integration (runQuery URL, owner/delivered filters, question context)
- `v2026.05.18.23.7` — Simplify Mouth envelope query (avoid composite index requirement)

## Commit History (Phase 3)
- `v2026.05.19.00.1` — Phase 3: memory recall/write, active envelope scan, attach handler, needs_input support

## Commit History (Phase 4)
- `v2026.05.19.13.1` — Phase 4: multi-step plan action, sequential execution, retry, Cerebellum JSON verdicts

## Commit History (Phase 5)
- `v2026.05.19.17.1` — Phase 5: checkpoint nesting (M→C→T), workspace isolation, Prefrontal v3, iterative planning
- `v2026.05.19.18.1` — Brain detects Cerebellum FAIL verdicts + Motor tool failures → triggers retry logic

## Commit History (Phase 6.5)
- `fix: Mouth v3 poll limit 20->100, fix delivered envelope crowding out new envelopes`
- `fix: Mouth v3 query orderBy created_at DESC — newest envelopes first`
- `v2026.05.19.17.0: Brain decision quality — dual memory recall, synthesize_with_failure, failure directives, Cortex SOUL failure rules`
