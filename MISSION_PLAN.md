# Architect Prime — Mission Plan

Current version: v2026.07.19.5.0


> This document describes **what Architect Prime is** and **what it is becoming**.
> The normative boundaries live in [`docs/PRODUCT_CANON.md`](docs/PRODUCT_CANON.md); the definition of improvement lives in [`docs/BRAIN_CANON.md`](docs/BRAIN_CANON.md); implementation plans live in [`docs/plans/`](docs/plans/).

---

## What Architect Prime Is

Architect Prime is a **self-bootstrapping agent factory**. It deploys autonomous AI specialist agents into a Google Cloud project, where they operate as named teammates inside Google Workspace — reachable by chat and email, present on calendars, working alongside humans in the channels humans already use.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages their cost, and tears them down. Humans assign work to agents directly; agents delegate to each other directly. The factory builds and maintains the fleet — it never sits in the middle of the work.

Within its own operational domain, Prime is a capable system operator: because it is reachable only by the sys-admin through the dashboard and holds no broad Workspace identity, it safely carries system-level power — shell, Google Cloud CLI, and scripting — to diagnose, build, and self-improve creatively (B-26). This breadth is deliberate and fenced structurally (manifest + IAM), and it does not make Prime a router of fleet work: the factory-not-orchestrator boundary (C-1) is unchanged.

Everything runs inside the operator's own GCP project: no shared infrastructure, no external runtime dependencies, no API keys. Authentication is Application Default Credentials, Domain-Wide Delegation, and per-agent IAM, end to end.

---

## How It Is Organized

```
Dashboard (Cloud Run — Next.js)
    │  control plane: fleet lifecycle, chat, work trees, introspection,
    │  projects, processes, plans, secret management, sidebar-navigated
    │  agent deep-dive (shared AgentWorkPanel, FleetPanel, ChatPanel)
    ▼
Firestore (state store)
    ├── primes/{id}/work/{id}       → M/C/T envelope state machine
    ├── primes/{id}/intake/{id}     → Brain intake queue
    ├── primes/{id}/fleet/{agent}   → Fleet agent status + health
    ├── primes/{id}/messages/       → Dashboard ↔ Prime chat
    ├── primes/{id}/projects/{id}   → Project context (recursive, with dependencies)
    ├── primes/{id}/processes/{id}  → Stored reusable processes
    ├── primes/{id}/plans/{id}      → Plan blueprints (draft → approved → executing → complete)
    └── config/                     → Settings, secret metadata + grants
    ▼
Agent VMs (GCE, host-native — no containers)
    ├── agent-ears       (systemd) — deterministic input: poll, dedup, fire-and-forget
    ├── agent-brain      (systemd) — envelope orchestrator: classify, decide, dispatch
    ├── agent-mouth      (systemd) — output delivery to the channel
    ├── agent-introspect (systemd) — dashboard introspection bus
    └── neural-gateway    (systemd) — the cognitive organs:
        ├── cortex            — the voice: classify, decide, synthesize
        ├── prefrontal        — the structurer: M→C→T blueprints
        ├── motor             — the hands: tools, exec, files (the only mutator)
        ├── cerebellum        — the conscience: independent verification
        ├── temporal-research — the outside world: search + grounding
        └── temporal-memory   — internal recall (no external APIs)
```

Secret material lives only in GCP Secret Manager, managed from the dashboard's Secret Store: humans store secrets, share them with individual agents via per-secret IAM grants on each agent's service account, and rotate or revoke them without touching a VM. Agents read what they are granted at runtime, over ADC, and nothing else.

---

## The Culture of Work

All work flows through a closed set of nine primitives. The execution spine is **R → M → C → T**:

- **Responsibilities (R):** Recurring duties — cron-scheduled or event-triggered, configured in JSON, hot-reloaded. Singleton responsibilities guarantee at most one live cycle at a time.
- **Missions (M):** Multi-checkpoint objectives with definitions of done. Every request becomes a mission. Missions are always flat — they never nest — and every mission belongs to a project.
- **Checkpoints (C):** Observable milestones within a mission, executed strictly in sequence. Verification gates their closure.
- **Tasks (T):** Atomic steps dispatched to the cognitive organs, always nested under a checkpoint.

Around the spine, four organizing primitives:

- **Projects:** The sole recursive primitive (bounded depth) — organizational containers with accumulated context and dependencies.
- **Plans:** Unexecuted mission blueprints with a full lifecycle: drafted, approved, stamped into M→C→T.
- **Processes:** Reusable, parameterized templates that produce plans — the system's repeatable ways of working, including delegation steps and human approval gates.
- **Artifacts:** Files produced during missions, stored in the git artifact substrate (GCS-backed repos with Firestore CAS refs, one per project) with merge-policy governance and changed-paths manifests.
- **Skills:** Versioned, fleet-shared instruction packages — the system's codified know-how.

The set is closed. New coordination needs are expressed by composing these nine — never by inventing a tenth. The full framework is documented in [`docs/CULTURE_OF_WORK.md`](docs/CULTURE_OF_WORK.md).

---

## The Cognitive Loop

The brain is a deterministic machine that consults intelligence. It owns the loop; the models own only the judgments inside it.

Every envelope advances through one canonical cycle:

1. **GATHER** — assemble minimum sufficient context: memory recall, and research only when the question needs the outside world. Read-only gathering may fan out in parallel; every fan-out joins before a decision.
2. **DECIDE** — cortex returns exactly one structured decision from the daemon's legal-move set.
3. **ACT** — the daemon dispatches: prefrontal to structure **outcome tasks** (by outcome, ownership, and dependency — never tool steps; the planner does not know the executor's command surface), motor to mutate (one pair of hands — mutation is exclusive; within its task, motor owns the full tool sequence, reading the governing skill and iterating to the outcome), temporal organs to fetch, delegation outward to other agents.
4. **VERIFY** — cerebellum checks results against acceptance criteria, independently of whoever produced them. A missing verdict fails closed — unverified work never passes as success.
5. **CLOSE or REPEAT** — the daemon applies the transition: advance, complete, ask, fail, or iterate within a bounded count.

One envelope at a time, fully attended; throughput is achieved by hiring more agents, never by making one brain juggle. Where an installed skill covers the work, the skill governs — skill resolution is part of dispatch, across every organ, and improvisation beside an applicable skill is a defect, not a style. The division is strict: SOULs carry operating character and how to *find* skills; command syntax and multi-step procedure live exclusively in the skill packages (B-17).

**Input and output are deterministic and independent.** Ears polls the channels, deduplicates, and hands off — zero judgment. Mouth classifies and delivers outputs back to the channel. Either can fail without taking the other down.

**Inter-agent work travels where humans can see it.** Agents delegate to each other over Google Chat with @-mentions: a machine-parseable envelope reference plus a human-readable summary. 


The conversation is legible to everyone in the room; the state machine resumes from Firestore, never from parsing chat.

---

## Memory

Three layers, three speeds, one discipline:

- **Working Memory (`MEMORY.md`):** The agent's RAM, loaded into every system prompt and pruned relentlessly.
- **Core Memory (Firestore):** Durable facts, promoted on evidence, retired and superseded as actively as they are added.
- **Deep Truths (`SOUL.md`):** Behavioral firmware, changed rarely and only on evidence spanning multiple sessions.

Memory exists to make context smaller, not larger. Skills hold what the *system* has learned; memory holds what *one agent* has lived — and proven improvisations are promoted into skills so that learning compounds at fleet level.

---

## The Fleet Lifecycle

- **Hire:** Dashboard → service account + IAM + VM → bootstrap (CoreKit + gateway + services from a boot stub that pulls directly from the repository) → health monitoring → online.
- **Fire:** VM deleted; service account and IAM preserved, so re-hire is fast and identity is stable.
- **Upgrade:** Manifest re-install at any git ref, contract validation, service restart — the same path deploys a release to the fleet or a feature branch to a test agent.

Agent capability is layered by manifest: universal tools in the base layer, role tools in the role layer, specialty tools and credential grants in the job layer. What an agent *cannot* do is enforced by manifests, IAM, code ownership, and CI — structure, not promises.

---

## Governing Principles

The full normative set lives in [`docs/PRODUCT_CANON.md`](docs/PRODUCT_CANON.md) (the walls — invariants that must hold) and [`docs/BRAIN_CANON.md`](docs/BRAIN_CANON.md) (the gradient — what better looks like for the brain). The shortest possible distillation:

1. **Everything that can be deterministic is deterministic.** LLM calls are reserved for judgment.
2. **Contracts over documentation.** `infra/contracts.json` is the single source of truth, validated before anything starts.
3. **No secrets in the repository, on disk images, or in Firestore.** Runtime injection only: ADC, DWD, Secret Store.
4. **Manifest discipline is absolute.** Files and their manifest entries ship in the same commit.
5. **R→M→C→T always.** Every output exists within the envelope hierarchy.
6. **Idempotent everything.** Re-runnable scripts, resumable state, restart as routine.
7. **Observable by default.** Every transition writes history; every mechanism ships with its telemetry.
8. **Capability fencing is structural.** Personas reinforce; manifests, IAM, and CI enforce.
9. **Each content layer holds one purpose.** Organs are WHO/HOW-it-thinks (the static, soft-locked identity core); Skills are the HOW of tools; Projects are the 40,000-ft working area; Processes are the proven paths. Content in the wrong layer is a defect — the map is [`docs/MODULE_CHARTER.md`](docs/MODULE_CHARTER.md) (C-28).

---

## File Layout

```
.
├── app/            # Dashboard control plane (Cloud Run, Next.js)
├── infra/          # contracts.json, install.sh, bootstraps, manifests
├── corekit/        # VM runtime — daemons, libs, brain tools, fleet/chat/memory/system scripts, config
├── brain/          # Agent identity workspaces — SOUL.md, IDENTITY.md per role
├── specialties/    # Per-agent-type bundles — workspace, brain appends, skills, responsibilities
├── skills/         # Versioned skill packages — the system's codified know-how
├── docs/           # Culture of Work, primitive references, authoring guides, plans
├── operator/       # Operator-specific content — sites, processes, docs (not loaded by default)
├── MISSION_PLAN.md # This document
└── README.md
```

Seven modules, one home for everything. The platform default surface (`base.txt` and role/job manifests) is operator-neutral — a fresh fork ships generic placeholders and zero shared infrastructure. Operator-specific content (sites, processes, design docs) lives in `operator/`, loaded only via an explicit job manifest layer. The dashboard never contains runtime logic; the runtime never reaches into the dashboard.

---

## What Architect Prime Is Becoming

The trajectory, stated as direction rather than schedule:

**A system that improves itself.** A Product Architect agent stewards the canons, continuously audits the codebase, and proposes the single highest-value improvement per cycle — ranked by the Brain Canon's rubric, rejected at the Product Canon's walls. Engineering agents implement on branches, deploy to an ephemeral test agent, exercise it with canned missions, QA it through the introspection bus, and open pull requests that carry their evidence. Humans hold the approval gates — on scope before work begins, on merge before code lands — and those gates loosen only as the loop earns it. Every cycle that hires and fires its test agent regression-tests the factory itself.

**A system whose learning compounds.** Skill governance is a deterministic stage of dispatch: the brain daemon builds a skill index at startup by scanning installed packages, injects it into the cortex payload as structured context, and execution agents read specific skill docs on-demand. When work matches an installed skill, every organ follows the procedure, deviations are recorded, and recurring deviations become skill proposals. Know-how migrates continuously out of prompts and individual memory into versioned, fleet-shared skills — so the system's competence is a property of the repository, not of any one agent.

**A society of agents that humans can read.** Delegation, status, and results flow through the same chat humans inhabit — machine-precise underneath, human-legible on the surface. The fleet grows toward richer specialist collaboration: structured handoffs, layered review, and work trees that show exactly who is doing what for whom, in real time.

**A brain that perceives.** A deterministic vision pipeline is taking shape — ingest, deduplicate, classify, route, analyze through typed lenses, persist — giving agents eyes that follow the same governing principle as everything else: deterministic stages around narrowly scoped judgment.

**A factory that governs itself at scale.** As confidence accumulates, structural self-governance deepens: promotion ladders expressed as git tags, automated auditors that watch for drift, scope-checked CI that makes out-of-bounds change impossible rather than discouraged. The destination is a fleet that proposes, builds, verifies, and ships its own improvements at a cadence no human team could sustain — inside walls no agent can move.

What it is becoming is, deliberately, more of what it is: more deterministic, more attentive, more economical, more honest, and easier to read — a factory whose product, increasingly, is its own next version.
