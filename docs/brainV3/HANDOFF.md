# Brain v3 — Session Handoff

> **Purpose:** Get a new session agent up to speed on the Brain v3 implementation.
> **Last updated:** 2026-05-18T23:35:00Z
> **Status:** Phase 2 CODE COMPLETE. Pending deploy + test on Stan.

---

## Quick Start

1. **Read the architecture:** `docs/brainV3/00-CORE-CONCEPTS.md` (the design bible)
2. **Read the roadmap:** `docs/brainV3/01-ROADMAP.md` (7-phase plan)
3. **Read this file** for current state, working process, and what's next
4. **Read the task tracker:** `docs/brainV3/TRACKER.md` (detailed checklist per phase)
5. **Read the next phase doc:** `docs/brainV3/03-PHASE-2-CORTEX-LOOP.md`

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
                                  Mouth polls completed envelopes → delivers
```
- Deterministic: Brain is a state machine, Cortex only provides decisions
- Observable: every state transition is in Firestore
- Scalable: R/C/M/T hierarchy (Responsibilities, Checkpoints, Missions, Tasks)

---

## Current State (as of 2026-05-18)

### What's Live
- **Phase 1: Foundation** — COMPLETE ✅
- **Phase 2: Cortex Loop** — CODE COMPLETE, pending deploy ✅
- **Stan** is running Brain v3 in production (fleet-stan VM)
- End-to-end pipeline verified: Ears → intake → Brain → Cortex classify/decide → envelope complete → Mouth delivery
- All code is on `main` branch, deployed via `upgrade-corekit`

### Phase 2 Changes
- Cortex SOUL expanded with `dispatch`, `synthesize`, `status_update` actions
- Full iterative Cortex loop: dispatch → feed result back → decide again
- `callAgent()` dispatches to any agent via gateway HTTP (fresh sessions only)
- Queue awareness: Cortex receives pending intake count + ordered queue details
- `status_update` action delivers "working on X, queue: Y" messages via Mouth
- Response parser hardened: balanced JSON extraction, Action: block stripping, retry on parse failure
- Gateway liveness check before each dispatch
- `[BRAIN-ORCHESTRATED]` marker prevents dual delivery through JSONL path
- Automated stale envelope cleanup at startup (archives failed >24h)

### Key Infrastructure
| Component | File | Status |
|-----------|------|--------|
| Brain service | `corekit/daemon/agent-brain.mjs` | ✅ Phase 2 Cortex loop |
| Brain launcher | `corekit/daemon/start-agent-brain` | ✅ Handles PRIME_ID/AGENT_ID discovery |
| Brain systemd unit | `corekit/daemon/agent-brain.service` | ✅ Enabled, auto-restart |
| Ears (rewired) | `corekit/daemon/agent-ears.mjs` | ✅ Writes Firestore intake |
| Mouth (dual mode) | `corekit/daemon/agent-mouth.mjs` | ✅ JSONL tailing + envelope polling + Brain-skip |
| Cortex SOUL v3 | `brain/fleet/_base/SOUL.md` | ✅ classify + decide (dispatch/synthesize/status_update) |
| Agent registry | `corekit/config/agent-registry.json` | ✅ 6 agents registered |
| Firestore index | `intake(status, created_at)` | ✅ Created manually |

### Known Issues (carry-forward to Phase 3)
1. **Memory not wired** — Brain passes empty `memory: {}` to Cortex. Phase 3 will hardwire temporal-memory recall/write.
2. **No active envelope scan** — Brain doesn't check for in-progress work before classify. Phase 3.
3. **No attach handling** — Cortex can classify as `attach` but Brain doesn't handle it yet. Phase 3.

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
echo y | gcloud compute ssh fleet-stan --zone=us-central1-a --project=architect-prime-beta \
  --tunnel-through-iap --command="sudo docker exec openclaw-gateway tail -30 /tmp/agent-brain.log"

# 4. Check Firestore (intake + work envelopes)
# Use the scratch scripts or dashboard
```

### SSH Access Pattern
- **Stan VM:** `fleet-stan` in `us-central1-a`, project `architect-prime-beta`
- **Always use IAP:** `--tunnel-through-iap`
- **Commands run as root via sudo**
- **Docker container:** `openclaw-gateway` — all services run inside this container
- **SSH is flaky** with chained docker exec commands — keep commands simple

### Key Paths on Stan
| Path | Description |
|------|-------------|
| `/opt/openclaw/.openclaw/` | Host-side OpenClaw root |
| `/home/node/.openclaw/` | Container-side OpenClaw root (mounted from host) |
| `/tmp/agent-brain.log` | Brain debug log (inside container) |
| `/tmp/agent-ears-state/` | Ears state dir (highwater, seen.json) |
| `/home/node/.openclaw/workspace/SOUL.md` | Active Cortex SOUL |
| `/home/node/.openclaw/corekit/agent-registry.json` | Agent capability registry |
| `/home/node/.openclaw/corekit/contracts.json` | Gateway contracts |

### Firestore Paths
| Path | Description |
|------|-------------|
| `primes/chucknorris/intake/{id}` | Intake records from Ears |
| `primes/chucknorris/work/{id}` | Work envelopes (R/C/M/T state machine) |
| `primes/chucknorris/work/{id}/history/{seq}` | Status transition log |

---

## What's Next: Phase 3 — Memory + Discovery

**Goal:** Hardwired memory recall/write, active envelope scan, follow-up detection.

**Read:** `docs/brainV3/04-PHASE-3-MEMORY-DISCOVERY.md` for the full design.

Key work items:
1. Integrate temporal-memory HTTP calls for recall (before classify) and write (on envelope completion)
2. Active envelope scan before classify (Firestore query for in-progress work)
3. Handle `attach` classification (follow-up to existing envelopes, status checks, needs_input resumption)
4. Test: memory recall enriches Cortex decisions, follow-up detection works

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
- (pending) — Phase 2: Cortex loop dispatch/synthesize + queue awareness + dual delivery fix
