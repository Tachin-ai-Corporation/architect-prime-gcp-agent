# Brain v3 — Session Handoff

> **Purpose:** Get a new session agent up to speed on the Brain v3 implementation.
> **Last updated:** 2026-05-19T04:35:00Z
> **Status:** Phase 2 COMPLETE ✅ — End-to-end verified on Stan.

---

## Quick Start

1. **Read the architecture:** `docs/brainV3/00-CORE-CONCEPTS.md` (the design bible)
2. **Read the roadmap:** `docs/brainV3/01-ROADMAP.md` (7-phase plan)
3. **Read this file** for current state, working process, and what's next
4. **Read the task tracker:** `docs/brainV3/TRACKER.md` (detailed checklist per phase)
5. **Read the next phase doc:** `docs/brainV3/04-PHASE-3-MEMORY-DISCOVERY.md`

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

## Current State (as of 2026-05-19)

### What's Live
- **Phase 1: Foundation** — COMPLETE ✅
- **Phase 2: Cortex Loop** — COMPLETE ✅ (deployed + verified end-to-end)
- **Stan** is running Brain v3 in production (fleet-stan VM)
- Full pipeline verified: Ears → intake → Brain → Cortex classify → Cortex decide → dispatch temporal-research → Cortex synthesize → Mouth LLM classify → GChat delivery

### Phase 2 Accomplishments
- Cortex SOUL expanded with `dispatch`, `synthesize`, `status_update` actions
- Full iterative Cortex loop: dispatch → feed result back → decide again (up to 12 iterations)
- `callAgent()` dispatches to any agent via gateway HTTP (fresh sessions only)
- Queue awareness: Cortex receives pending intake count + ordered queue details
- `status_update` action delivers "working on X, queue: Y" messages via Mouth
- Response parser hardened: balanced JSON extraction, Action: block stripping, retry on parse failure
- Gateway liveness check before each dispatch
- `[BRAIN-ORCHESTRATED]` marker prevents dual delivery through JSONL path
- Automated stale envelope cleanup at startup (archives failed >24h)
- Cortex workspace isolation: dedicated `workspace-cortex` with v3 SOUL
- `delegate` → `dispatch` action normalization (backward compatibility)
- Intake retry resilience: classify failures revert intake to `pending`
- Mouth Brain v3 integration: Firestore envelope polling, LLM voice/classify pipeline, delivered_at tracking
- `render-config` updated to prefer fleet template, substitute agent identity vars

### Key Infrastructure
| Component | File | Status |
|-----------|------|--------|
| Brain service | `corekit/daemon/agent-brain.mjs` | ✅ Phase 2 Cortex loop (882 lines) |
| Brain launcher | `corekit/daemon/start-agent-brain` | ✅ PRIME_ID/AGENT_ID/BRAIN_V3 discovery |
| Brain systemd unit | `corekit/daemon/agent-brain.service` | ✅ Enabled, auto-restart |
| Ears (rewired) | `corekit/daemon/agent-ears.mjs` | ✅ Writes Firestore intake |
| Mouth (dual mode) | `corekit/daemon/agent-mouth.mjs` | ✅ JSONL tailing + Brain v3 envelope polling + LLM classify |
| Cortex SOUL v3 | `brain/fleet/_brain/cortex/SOUL.md` | ✅ classify + decide (dispatch/synthesize/status_update/short_circuit) |
| Cortex workspace | `workspace-cortex/SOUL.md` (on VM) | ✅ Isolated workspace, prevents identity leakage |
| Agent registry | `corekit/config/agent-registry.json` | ✅ 6 agents registered |
| Fleet template | `corekit/config/openclaw-fleet-bootstrap.json5.tmpl` | ✅ Cortex mapped to workspace-cortex |
| render-config | `corekit/gateway/render-config` | ✅ Prefers fleet template, substitutes AGENT_DISPLAY_NAME |
| Firestore indexes | `intake(status, created_at)`, `work(owner, status)` | ✅ Live |

### Known Issues (carry-forward to Phase 3)
1. **Memory not wired** — Brain passes empty `memory: {}` to Cortex. Phase 3 will hardwire temporal-memory recall/write.
2. **No active envelope scan** — Brain doesn't check for in-progress work before classify. Phase 3.
3. **No attach handling** — Cortex can classify as `attach` but Brain doesn't handle it yet. Phase 3.
4. **Old envelopes re-delivered on first Mouth restart** — Mouth delivered 3 historical envelopes on first boot. The `delivered_at` flag now prevents this on subsequent restarts.
5. **upgrade-corekit CRLF warning** — Non-fatal syntax error from Windows CRLF in bash script. Doesn't affect function.

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
- `v2026.05.18.23.1` — Phase 2: Cortex loop dispatch/synthesize + queue awareness + dual delivery fix
- `v2026.05.18.23.2` — Cortex workspace isolation + manifest/bootstrap/upgrade + delegate→dispatch normalization
- `v2026.05.18.23.3` — render-config prefers fleet template, substitutes agent display name
- `v2026.05.18.23.4` — Revert intake to pending on classify failure (retry resilience)
- `v2026.05.18.23.5` — Fix missing opening brace in fleet template cortex block
- `v2026.05.18.23.6` — Fix Mouth Brain v3 integration (runQuery URL, owner/delivered filters, question context)
- `v2026.05.18.23.7` — Simplify Mouth envelope query (avoid composite index requirement)
