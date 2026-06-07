# Architect Prime — Mission Plan

> **Current version:** `v2026.06.07.1.0`
>
> This document describes *what Architect Prime is* and *how it works right now*.
> Implementation plans live in `docs/plans/`. Historical changes live in git.

---

## Vision

Architect Prime is a **self-bootstrapping agent factory** built on a native brain gateway and GCP.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

---

## Architecture

```
Dashboard (Cloud Run — Next.js)
    │
    ├─ REST API (28 endpoints)        → Fleet lifecycle, chat, work, introspect
    ├─ 18-route hierarchy              → /p/[id]/... (prime-scoped) + /library/... (global)
    │
    ▼
Firestore (state store)
    ├── primes/{id}/work/{id}          → M/C/T envelope state machine
    ├── primes/{id}/intake/{id}        → Brain intake queue
    ├── primes/{id}/fleet/{agent}      → Fleet agent status + health
    ├── primes/{id}/messages/          → Dashboard ↔ Prime chat
    ├── primes/{id}/projects/{id}      → Project context
    ├── primes/{id}/processes/{id}     → Stored reusable processes
    └── config/settings                → Agent defaults (email domain)
    │
    ▼
Agent VMs (e2-medium, Ubuntu 22.04)
    ├── agent-ears      (systemd) — Deterministic input: poll, dedup, fire-and-forget
    ├── agent-brain     (systemd) — Envelope orchestrator: classify, decide, dispatch
    ├── agent-mouth     (systemd) — Output delivery: JSONL tail + envelope polling
    ├── agent-introspect(systemd) — Dashboard introspection bus
    └── brain-gateway   (systemd, port 18789) — 6-agent LLM configuration
        ├── cortex            — Orchestrator (default)
        ├── motor             — Execution + Workspace tools
        ├── prefrontal        — Planning
        ├── cerebellum        — Verification
        ├── temporal-research — Web search (Vertex AI grounding)
        └── temporal-memory   — Memory recall (no external APIs)
```

### Cognitive Hierarchy: R → M → C → T

All work flows through four levels. No exceptions.

- **Responsibilities (R):** Cron-scheduled recurring duties. Configured in JSON, hot-reloaded.
- **Missions (M):** Multi-checkpoint objectives with definitions of done. Every user request becomes a mission.
- **Checkpoints (C):** Observable milestones within a mission. Created by prefrontal or brain.
- **Tasks (T):** Atomic execution steps dispatched to sub-agents. Always nested under a checkpoint.

### Brain State Machine

`agent-brain.mjs` is the central orchestrator. It runs a deterministic loop:

1. **Intake → Classify** — Cortex classifies the input (`new_mission`, `attach`, `continue`, `cancel`)
2. **Quick Ack** — LLM-voiced acknowledgment injected as first C→T under the new mission
3. **Decide Loop** — Cortex returns structured JSON actions (`dispatch`, `synthesize`, `continue`, `delegate`, etc.)
4. **Dispatch** — Tasks dispatched to motor/cerebellum/temporal agents via gateway sessions
5. **Synthesize** — Final response composed and marked for delivery
6. **Delivery** — `agent-mouth` polls for `delivery_status: 'pending'` envelopes and sends to channel

### I/O Pipeline

- **Ears**: Polls GChat (DWD) or Firestore. Zero LLM calls. Deduplicates. Fire-and-forget gateway POST.
- **Mouth**: Tails JSONL transcript + polls brain envelopes. LLM classify per output. Delivers to GChat/Firestore.
- Both are fully independent — crash of one doesn't affect the other.

### Fleet Agent Lifecycle

**Hire:** Dashboard → `fleet-hire` → `fleet-deploy` (SA + IAM + VM) → `fleet-bootstrap.sh` (CoreKit + gateway + services) → `fleet-monitor` (serial console polling) → online

**Fire:** Dashboard → `fleet-fire` → `fleet-teardown` (VM deleted, SA preserved for re-hire)

**Upgrade:** Dashboard → `upgrade-corekit` (manifest re-install + contract validation + service restart)

### Three-Layer Memory

- **Working Memory (`MEMORY.md`):** Agent's RAM. Loaded into every system prompt. Pruned nightly.
- **Core Memory (Firestore):** Durable facts. Queried via time-windowed reads. Promoted during consolidation.
- **Deep Truths (`SOUL.md`):** Behavioral firmware. Changes only during nightly consolidation with evidence spanning 3+ sessions.

---

## Design Principles

1. **No secrets in repo** — runtime injection via ADC, DWD signJwt, GCP metadata
2. **Contracts over documentation** — `contracts.json` is the single source of truth; `validate-contracts` enforces it
3. **Modular manifests** — `install.sh --role prime|fleet --job devops|engineer` chains base + role + job fragments
4. **Boot stub pattern** — startup scripts as `.sh` files on GitHub, not embedded in JS
5. **M→C→T always** — every output exists within the mission/checkpoint/task hierarchy
6. **LLMs think, systems move data** — brain orchestrator is deterministic; LLMs make decisions within structured JSON schemas
7. **Fail fast at bootstrap** — `validate-contracts` runs before services start
8. **Idempotent everything** — scripts safely re-runnable; upgrades overwrite manifest files, never delete non-manifest files
9. **Preserve state across cycles** — SAs and IAM persist across fire/re-hire; STATE.json records role/job

---

## File Layout

```
architect-prime/
├── app/                    # Dashboard (Cloud Run, Next.js) — 28 API endpoints
├── infra/                  # Infrastructure — contracts.json, install.sh, bootstraps, manifests
├── corekit/                # CoreKit Runtime — 50 VM-side scripts grouped by domain
│   ├── fleet/              # Fleet lifecycle (9 scripts)
│   ├── chat/               # Google Chat / DWD (3 scripts)
│   ├── brain/              # Brain tools (11 scripts)
│   ├── daemon/             # Ears/Mouth/Brain/Introspect services
│   ├── memory/             # Memory subsystem (3 scripts)
│   ├── system/             # upgrade-corekit, validate-contracts
│   └── config/             # Registries, templates, agent-types
├── brain/                  # Agent Identity — SOUL.md, IDENTITY.md per agent per role
├── specialties/            # Per-agent-type bundles (8 specialties)
├── skills/                 # Skill packages (agent-ask, workspace-drive, fleet-*, etc.)
├── docs/                   # Documentation + plans
│   ├── plans/              # Implementation plans (referenced, not inlined)
│   └── architecture/       # Design documents
├── MISSION_PLAN.md         # This document
└── README.md
```

---

## Fleet

| Agent | Specialty | VM | Status |
|-------|-----------|-----|--------|
| stan | devops | fleet-stan | Online |
| anora | pm | fleet-anora | Online |

**Prime:** `chucknorris` — `prime-chucknorris`, `us-central1-a`, `architect-prime-beta`

---

## Plans

Active and upcoming implementation plans live in [`docs/plans/`](docs/plans/).

No active plans.
