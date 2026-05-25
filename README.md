# Architect Prime

**Self-Bootstrapping AI Agent Factory for Google Cloud**

Architect Prime is an **agent factory** — it creates, upgrades, monitors, and tears down autonomous AI agents running on your own GCP infrastructure. Each agent gets its own Compute Engine VM, a Docker-containerized [OpenClaw](https://github.com/openclaw/openclaw) brain powered by Vertex AI Gemini, and a Google Workspace identity for team collaboration via Google Chat.

Prime handles **infrastructure, not orchestration**. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

> **Current version:** `v2026.05.25.3.0`


---

## What It Does

| Capability | How It Works |
|-----------|-------------|
| **Deploy Prime** | Dashboard deploys a Prime VM with a multi-agent brain (6 sub-agents) |
| **Manage Fleet** | Hire/fire specialist agents from the dashboard — DevOps, Engineer, and more |
| **Chat with Prime** | Talk to your orchestrator through the web dashboard (non-streaming + async watchdog) |
| **Agent Communication** | Fleet agents communicate via Google Chat using Domain-Wide Delegation |
| **Dashboard Auth** | Google Workspace OAuth with domain restriction — defense-in-depth on all API routes |
| **Dynamic Model Discovery** | Scan Vertex AI Model Garden — auto-detect available Gemini, Claude, and other models |
| **Self-Upgrading** | Dashboard upgrades itself via Cloud Build; CoreKit upgrades cascade to fleet |
| **Contract Enforcement** | `contracts.json` is the single source of truth — validated at bootstrap and upgrade |
| **Work Tree Dashboard** | Real-time M→C→T work hierarchy, human-in-the-loop for agent questions |
| **Agent Introspection** | Query actual installed tools/skills from agent VMs via Firestore bus — real filesystem data |
| **Autonomous Responsibilities** | Agents self-program recurring duties with cron schedules — R/M/C/T hierarchy |
| **Self-Hosted** | Everything runs in YOUR GCP project — zero shared infrastructure, no API keys |

---

## Quick Deploy

### Option A: Cloud Shell (Recommended)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent&tutorial=infra/deploy/tutorial.md)

### Option B: Manual

```bash
git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent
cd architect-prime-gcp-agent
export PROJECT_ID="your-project-id"
bash infra/deploy/install.sh
```

The installer will:
1. Enable required GCP APIs (Cloud Run, Firestore, Compute, Vertex AI, IAM, Cloud Build)
2. Create service accounts with least-privilege IAM roles
3. Create the DWD signer SA for agent-to-Chat communication
4. Deploy the Cloud Run control plane (Next.js dashboard)
5. Seed Firestore with initial configuration

After install, open the printed URL to access the dashboard.

---

## Getting Started

### 1. Deploy Your First Prime

Open the dashboard → Enter a name (e.g., "alpha") → Click **Deploy Prime**.

Your Prime will be ready in ~15 minutes. It runs on a Compute Engine VM (e2-medium) with a Docker-containerized OpenClaw brain featuring 6 specialized sub-agents powered by Vertex AI Gemini.

### 2. Configure Domain-Wide Delegation (Optional)

Required for fleet agents to communicate via Google Chat:

1. Go to **Dashboard → Setup tab**
2. Copy the **Client ID** and **OAuth Scopes** shown
3. Open [Google Admin → Security → API Controls → DWD](https://admin.google.com/ac/owl/domainwidedelegation)
4. Click **"Add new"**, paste the Client ID and scopes
5. Click **"Test DWD"** in the dashboard to verify

### 3. Hire Fleet Agents

1. Set your **Agent Email Domain** on the Setup tab (e.g., `yourcompany.com`)
2. Create a Workspace email for the agent (e.g., `devops-agent-stan@yourcompany.com`)
3. Go to **Dashboard → Chat tab** and ask Prime to hire an agent, or use the Fleet tab
4. Prime deploys a specialist VM and brings the agent online (~10 min)

### 4. Chat & Collaborate

- **Dashboard Chat** — Talk to Prime through the web interface. Prime orchestrates sub-agents (research, planning, execution, verification) behind the scenes.
- **Google Chat** — Add fleet agent emails to your Chat spaces. They read and respond independently via DWD polling.

---

## Architecture

```
Your GCP Project
├── Cloud Run (Control Plane — Next.js Dashboard)
│   ├── Dashboard UI (17-page breadcrumb-navigated hierarchy, 1health design system)
│   ├── REST API (primes, fleet, messages, commands, projects, skills, upgrade)
│   └── Firestore client (state management)
│
├── Firestore (State Store)
│   ├── primes/{id}                   → Prime instance metadata
│   ├── primes/{id}/messages/{msg}    → Dashboard ↔ Prime chat
│   ├── primes/{id}/fleet/{agent}     → Fleet agent status + health
│   ├── primes/{id}/tasks/{taskId}    → Prime task lifecycle log
│   ├── primes/{id}/fleet/{agent}/tasks/{taskId} → Fleet task lifecycle log
│   ├── primes/{id}/brain/            → Dispatch telemetry
│   ├── primes/{id}/memory/core/      → Durable Core Memory
│   ├── primes/{id}/work/{id}         → Work envelopes (R/C/M/T state machine)
│   ├── primes/{id}/work/{id}/history/→ Status transition log
│   ├── primes/{id}/intake/{id}       → Brain intake queue
│   ├── config/settings               → Agent defaults (email domain, model catalog)
│   └── config/dwd                    → DWD configuration
│
├── Prime VM (Compute Engine e2-medium, Ubuntu 22.04)
│   ├── openclaw-gateway (Docker, --network host, port 18789)
│   │   ├── cortex          — Gemini 3.1 Pro Preview — orchestrator (DEFAULT)
│   │   ├── temporal-research — Gemini 2.5 Flash — web search (Vertex AI grounding)
│   │   ├── temporal-memory — Gemini 2.5 Flash — memory/context recall
│   │   ├── prefrontal      — Gemini 2.5 Flash — strategic planning
│   │   ├── motor           — Gemini 2.5 Flash — execution (code + commands)
│   │   └── cerebellum      — Gemini 2.5 Flash — verification + QA
│   ├── agent-ears (systemd)       → Deterministic input processing (fire-and-forget, zero LLM)
│   ├── agent-brain (systemd)      → Brain state machine (intake → classify → decide → dispatch → synthesize)
│   ├── agent-mouth (systemd)      → Output classification + delivery (strict LLM filter)
│   ├── REST API: GET /api/primes/{id}/work, POST /api/primes/{id}/work/{workId}/respond
│   ├── CoreKit (40 scripts)     → fleet, gateway, chat, brain, memory, dashboard, system
│   └── contracts.json           → Cross-cutting values (models, ports, agent IDs)
│
└── Fleet Agent VMs (Compute Engine e2-medium, one per agent)
    ├── openclaw-gateway (Docker) → Specialist AI brain (cortex on Gemini 3.1 Pro)
    ├── agent-ears (systemd)      → GChat polling via DWD (deterministic, fire-and-forget)
    ├── agent-mouth (systemd)     → Output classification + GChat delivery
    ├── CoreKit (role-specific)   → Manifest-installed tools
    └── Specialty workspace       → SOUL.md, IDENTITY.md, TOOLS.md (per agent type)
```

### Brain Architecture (Prime)

Prime's brain uses **multi-agent dispatch** — Cortex is the user-facing orchestrator that delegates to 5 specialist sub-agents:

| Agent | Model | Role |
|-------|-------|------|
| **cortex** | gemini-3.1-pro-preview | Plan executor + synthesizer (DEFAULT) |
| **temporal-research** | gemini-2.5-flash | Web search via Vertex AI grounding |
| **temporal-memory** | gemini-2.5-flash | Pure memory recall (NO external APIs) |
| **prefrontal** | gemini-2.5-flash | Mandatory dispatch planner |
| **motor** | gemini-2.5-flash | Execution + 28 Workspace tools (Drive, Gmail, Calendar, Docs, Sheets) |
| **cerebellum** | gemini-2.5-flash | Verification + QA |

Dispatch flow: Cortex returns structured JSON decisions → `agent-brain` daemon dispatches to sub-agents via HTTP → motor runs tools → cerebellum verifies → Cortex synthesizes response.

### Key Design Decisions

- **Contract-driven** — `contracts.json` is the single source of truth for models, ports, agent IDs, and environment. `validate-contracts` enforces consistency at bootstrap and upgrade.
- **Boot stub pattern** — VM startup scripts curl bash scripts from GitHub. Bootstrap changes only need `git push`, not a Cloud Run rebuild.
- **Modular manifests** — `install.sh --role prime|fleet --job devops|swe|qa|pm|finance|data|security|assistant` chains base + role + job fragments. Each specialty is independently iterable.
- **ADC authentication** — Pure Application Default Credentials via GCE metadata. No API keys, no service account key files.
- **OpenClaw-native** — Full agent framework with conversation memory, tool execution, and workspace files. Not a custom LLM wrapper.

---

## Repository Structure

```
architect-prime/
├── app/                              # MODULE 1: Control Plane (Cloud Run, Next.js)
│   ├── src/app/page.tsx              # Home (Prime cards, deploy)
│   ├── src/app/p/[id]/               # Prime hub + sub-pages (17 pages)
│   ├── src/app/settings/             # Dashboard Settings
│   ├── src/app/skills/               # Skill Kit Library
│   ├── src/app/api/primes/[id]/      # REST API routes (28 endpoints)
│   ├── src/components/               # Shell, Breadcrumb, NavCard, StatusStrip, AgentChip
│   ├── src/contexts/                 # PrimeContext (shared state)
│   ├── src/hooks/                    # useProjects (real-time Firestore)
│   └── Dockerfile
│
├── infra/                            # MODULE 2: Infrastructure
│   ├── contracts.json                # Single source of truth (cross-cutting values)
│   ├── install.sh                    # Modular manifest-driven installer
│   ├── cloudbuild.yaml               # Dashboard Cloud Build config
│   ├── bootstrap/                    # VM startup scripts (curled from GitHub)
│   │   ├── prime-bootstrap.sh        # Prime VM setup
│   │   └── fleet-bootstrap.sh        # Fleet agent VM setup (contract-driven)
│   ├── manifests/                    # Modular manifest fragments
│   │   ├── base.txt                  # Tools every agent needs
│   │   ├── role-prime.txt            # Prime-only tools + brain workspaces
│   │   ├── role-fleet.txt            # Fleet workspaces + brain sub-agents
│   │   ├── job-devops.txt            # DevOps specialty workspace
│   │   ├── job-swe.txt               # SWE specialty (maps to engineer workspace)
│   │   ├── job-engineer.txt          # Engineer specialty workspace
│   │   ├── job-qa.txt                # QA specialty workspace
│   │   ├── job-pm.txt                # PM specialty workspace
│   │   ├── job-finance.txt           # Finance specialty workspace
│   │   ├── job-data.txt              # Data specialty workspace
│   │   ├── job-security.txt          # Security specialty workspace
│   │   └── job-assistant.txt         # Assistant specialty workspace
│   └── deploy/                       # Standalone install/uninstall scripts
│       ├── install.sh                # One-command project installer
│       ├── uninstall.sh              # Clean teardown
│       └── tutorial.md               # Cloud Shell guided tutorial
│
├── corekit/                          # MODULE 3: CoreKit Runtime (59 VM-side scripts)
│   ├── fleet/                        # Fleet lifecycle (9 scripts)
│   ├── gateway/                      # OpenClaw gateway management (5 scripts)
│   ├── chat/                         # Google Chat / DWD integration (3 scripts)
│   ├── brain/                        # Brain execution layer (11 scripts)
│   ├── memory/                       # Memory subsystem (3 scripts)
│   ├── dashboard/                    # Dashboard bridge (1 script)
│   ├── daemon/                       # Ears/Mouth I/O services (6 scripts)
│   ├── system/                       # Cross-cutting utilities (2 scripts)
│   └── config/                       # Templates, service files, agent-types
│
├── brain/                            # MODULE 4: Agent Identity
│   ├── agents/main/                  # OpenClaw agent skeleton (auth, sessions)
│   ├── prime/                        # Prime brain workspaces (6 agents)
│   │   ├── cortex/                   # SOUL.md, IDENTITY.md, TOOLS.md, MEMORY.md
│   │   ├── temporal-research/        # SOUL.md, IDENTITY.md
│   │   ├── temporal-memory/          # SOUL.md, IDENTITY.md
│   │   ├── prefrontal/               # SOUL.md, IDENTITY.md
│   │   ├── motor/                    # SOUL.md, IDENTITY.md
│   │   └── cerebellum/               # SOUL.md, IDENTITY.md
│   └── fleet/                        # Fleet brain workspaces
│       ├── _base/                    # Generic fleet template (fallback)
│       └── _brain/                   # Shared sub-agent workspaces for fleet agents
│
├── specialties/                      # MODULE 5: Per-Agent-Type Bundles
│   ├── devops/workspace/             # DevOps specialty (3 files)
│   ├── engineer/workspace/           # Engineer specialty (3 files)
│   ├── qa/workspace/                 # QA specialty (3 files)
│   ├── pm/workspace/                 # PM specialty (3 files)
│   ├── finance/workspace/            # Finance specialty (3 files)
│   ├── data/workspace/               # Data specialty (3 files)
│   ├── security/workspace/           # Security specialty (3 files)
│   └── assistant/workspace/          # Assistant specialty (3 files)
│
├── skills/                           # MODULE 6: Skill Packages
│   ├── agent-ask/                    # Vertex AI grounding web search
│   ├── workspace-drive/              # Google Drive (9 tools + ws-token)
│   ├── workspace-gmail/              # Gmail (5 tools)
│   ├── workspace-calendar/           # Calendar (5 tools)
│   ├── workspace-docs/               # Docs (6 tools)
│   ├── workspace-sheets/             # Sheets (3 tools)
│   ├── fleet-hire/                   # Deploy a new fleet agent
│   ├── fleet-fire/                   # Remove a fleet agent
│   ├── fleet-status/                 # Query fleet status
│   ├── fleet-verify/                 # Verify agent health
│   ├── fleet-upgrade/                # Upgrade agent CoreKit
│   └── memory-consolidate/           # Nightly memory consolidation
│
├── docs/                             # Architecture documentation
│   ├── BOOTSTRAP.md                  # Bootstrap reference
│   ├── CHAT_SETUP.md                 # Google Chat / DWD setup guide
│   └── architecture/                 # AGENT_DESIGN, BRAIN_ARCHITECTURE, R/C/M spec
│
├── MISSION_PLAN.md                   # Living design document (current state only)
└── README.md                         # This file
```

---

## How Bootstrap Works

The deploy API uses a **boot stub pattern**:

1. Dashboard calls `POST /api/primes/{id}/deploy`
2. Route creates a GCE VM with a ~10 line boot stub as the startup script
3. Boot stub curls `infra/bootstrap/prime-bootstrap.sh` from GitHub
4. `prime-bootstrap.sh` handles everything:
   - Installs Docker CE
   - Installs CoreKit via `infra/install.sh --role prime` (chains `base.txt` + `role-prime.txt`)
   - Builds OpenClaw Docker image from pinned commit (`v2026.4.15`)
   - Renders gateway config from JSON5 template with contract values
   - Starts OpenClaw container (`--network host`, port 18789)
   - Applies ADC auth patch for GCE metadata fallback
   - Warm-up probe through cortex route
   - Installs `agent-ears` + `agent-mouth` as systemd services

**Fleet agents** follow the same pattern via `infra/bootstrap/fleet-bootstrap.sh`:
- `infra/install.sh --role fleet --job {specialty}` (chains `base.txt` + `role-fleet.txt` + `job-{specialty}.txt`)
- Deploys specialty workspace, validates rendered config via `validate-contracts --file`
- Writes `.identity-lock` (DWD impersonation guard)
- Starts `agent-ears` + `agent-mouth` for Google Chat I/O
- Self-reports online status to Firestore

**Key benefit**: Bootstrap changes only require a `git push` — no Cloud Run rebuild needed.

---

## Contract Enforcement

`infra/contracts.json` is the **single source of truth** for all cross-cutting values:

```json
{
  "openclaw":  { "pin": "041266a6...", "pinLabel": "v2026.4.15" },
  "vertex":    { "location": "global", "primaryModel": "gemini-3.1-pro-preview", "subagentModel": "gemini-2.5-flash" },
  "agents":    { "defaultId": "cortex", "gatewayRoute": "openclaw/cortex", "subagentIds": ["temporal-research", "temporal-memory", "prefrontal", "motor", "cerebellum"] },
  "gateway":   { "port": 18789, "timeoutSeconds": 120, "bind": "loopback" }
}
```

`validate-contracts` enforces these values across bootstraps, runtime configs, and rendered files — preventing the class of bug where one value is changed but stale references remain in 6 other files.

---

## Uninstall

```bash
export PROJECT_ID="your-project-id"
bash infra/deploy/uninstall.sh
```

This removes all VMs, service accounts, Cloud Run service, and Firestore data.

---

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| **No secrets in git** | Runtime injection via ADC, DWD signJwt, and GCE metadata |
| **Contracts over docs** | `contracts.json` single source of truth; `validate-contracts` enforces consistency |
| **Modular manifests** | `install.sh --role --job` chains base + role + job fragments |
| **Boot stub pattern** | Startup scripts are bash on GitHub — no JS template escaping |
| **OpenClaw-native** | Full agent framework with memory, tools, and sessions |
| **Docker-containerized** | OpenClaw runs in Docker (`--network host`) for isolation |
| **Idempotent** | All installs, deploys, and upgrades are safely re-runnable |
| **Self-upgradable** | Dashboard self-upgrades via Cloud Build; fleet agents upgraded individually via dashboard |
| **Fail fast** | `validate-contracts` runs before container start — catches config errors in seconds |
| **Observable** | All communication logged in Firestore; structured JSON logging with telemetry |

---

## Version History

| Version | Milestone |
|---------|-----------|
| v0.1–v0.9 | CoreKit scaffold → manifest → Chat integration → Cloud Run control plane → fleet lifecycle → DWD |
| **v2.0** | OpenClaw pivot — Docker-based agent brain, boot stub pattern |
| **v3.0** | Multi-agent brain — 5 brain agents (cortex, temporal, prefrontal, motor, cerebellum) |
| **v3.2** | 6 brain agents (temporal split), exec dispatch, Vertex AI grounding |
| **v3.3** | Node.js control-daemon with conversation history + structured logging |
| **v3.4** | Hybrid SSE streaming dispatch, Cortex error recovery |
| **v3.5** | Two-tier memory (working + core), Deep Truths, fleet-health-check + auto-recovery |
| **v3.6** | Dynamic email domain, fleet brain sub-agent workspaces |
| **v3.7** | Dynamic model discovery, Gemini 3.1 Pro + global endpoint, model catalog UI |
| **v4.0** | Modularization + contract enforcement — `contracts.json`, `validate-contracts`, modular manifests |
| **v5.0** | Clean-room migration to 6-module architecture (`app/`, `infra/`, `corekit/`, `brain/`, `specialties/`, `skills/`) |
| **v5.1** | Real-time command progress monitoring, cascading CoreKit upgrades, upgrade observability |
| **v5.2** | Async delivery stabilization — non-streaming gateway (Prime + Fleet), anti-spam, fleet gateway token fix, background ACK timer, 1:1 message delivery |
| **v5.3** | Unified message-daemon — single Node.js daemon for both Prime and Fleet, built-in DWD, channel adapter pattern, fleet gains conversation history + think-block stripping + watchdog |
| **v2026.05.01.1** | Markdown rendering (dashboard `react-markdown` + GChat format conversion), version detection fix, CommandProgress staleness timeout, canonical versioning restored |
| **v2026.05.01.2** | Per-fleet-agent upgrade buttons, fleet-upgrade fix (message-daemon + docker restart), no-clobber manifest flag, enhanced GChat markdown (headers/blockquotes/links/HR) |
| **v2026.05.01.3** | Tech debt cleanup — purged inbox-daemon + control-daemon (−1,613 lines), deployed message-daemon.service, fixed validate-contracts, aligned 25 files of documentation |
| **v2026.05.01.4** | Watchdog reliability — fixed orphaned daemon processes (root cause of phantom timeouts), TASK.json delivery detection, file-based daemon logging, 0 contract violations |
| **v2026.05.03.5** | Multi-step brain + Drive organization — 9 Drive tools via DWD, sessions_spawn/sessions_yield dispatch, PLAN.md tracking, fleet brain parity |
| **v2026.05.03.6** | Brain Architecture v2 — Prefrontal-first gate (mandatory dispatch planner), ears/mouth decomposition, tool reassignment (motor owns all Workspace tools, temporal-memory = pure memory), dynamic skill awareness (TOOLS.md) |
| **v2026.05.03.7** | Brain v2.1 Gate Enforcement — BRAIN_CARD stripped of routing hints, PLAN.md write gate (PLAN_VALID marker), validation rules (per-step criteria checked by cerebellum), two-mode prefrontal (simple + advisory), motor advisory mode, ws-token path fix, multi-step Drive organization validated end-to-end |
| **v2026.05.03.8** | Ears/Mouth Activation — Decoupled I/O: fire-and-forget agent-ears (deterministic input), strict-LLM agent-mouth (classify+deliver). Deleted message-daemon (−1,028 lines) + channel-respond. Both Prime and Fleet validated end-to-end. |
| **v2026.05.03.9** | Identity Lockdown + Task Lifecycle — Deterministic agent email (`{{AGENT_USER_EMAIL}}`), `.identity-lock` DWD impersonation guard, structured Firestore task logging (`task-log-write`/`task-log-read`), mouth voice fix (speaks AS agent), byte-offset log fix, stray re-delivery fix, ACK removal. |
| **v2026.05.03.10** | Repo Hardening Audit — 3-pass, 69-item audit: fixed contract validation paths, agent-ask model/region from contracts.json, identity-lock enforcement in ears/mouth, calendar bug in compliance gate, fleet-monitor milestone string, deleted web-search bypass + model-catalog.json, purged ~3,700 lines of dead code/stale docs, hardened hire API. |
| **v2026.05.03.11** | Fleet Activation + Workspace Capability — Final audit (validate-contracts, tachin.ai, sendACK), 4 Workspace skill packages (Gmail 5, Calendar 5, Docs 6, Sheets 3 = 19 new tools), assistant agent type, 8 agent types with specialty manifests, memory consolidation cron activated, DWD scopes expanded. |
| **v2026.05.05.12** | Fleet Auth Stabilization — Reverted OpenClaw pin to v2026.4.15 (v2026.5.2 broke GCE metadata auth), fixed fleet-bootstrap bash syntax error (Python patcher moved to host-side heredoc), fixed ADC patcher false-positive detection, mouth persona (brain→mouth architecture: mouth IS the agent's voice, classify receives human question as context), removed stale google-workspace-skills reference folder. |
| **v2026.05.05.13** | Prefrontal Hard Gate + Validation Architecture — BRAIN_CARD stripped to bare agent names (zero routing knowledge), dynamic SOUL.md composition (SOUL_PROTOCOL.md), PLAN_STATUS: APPROVED hard gate (check-plan-compliance injects PLAN_VIOLATION via stdout), validation mandatory for ALL pipeline steps, cerebellum converted to pure test runner (ALL_PASS/FAIL/NO_RULES verdicts). |
| **v2026.05.08.14** | Mouth v2 (JSONL-Native) + Ears Context Window — Replaced log scraping with JSONL session transcript tailing (structural final response detection, eliminates double delivery). Turn state machine (IDLE→WORKING→ACKED→UPDATED→DONE). LLM-voiced status updates (5s ack, 120s progress). Prompts externalized to .md files. Ears context window: prior N chat messages included with @mentions for ambient conversation awareness. |
| **v2026.05.18.15** | Chat Input Hardening & LLM Preprocessor — Restored deterministic agent-to-drive communication by adding a Gemini 2.5 Flash preprocessing step in `agent-ears.mjs` to automatically repair Chat-mangled text (e.g., stripped underscores in folder IDs) before dispatch to the OpenClaw brain. Added detailed audit logging. Hardened Drive skills to resolve 404s and fallback identity for 401s. |
| **v2026.05.18.16** | Memory Pipeline Stabilization & Prefrontal Gate — Fixed Firestore pathing in memory scripts to properly target the `core_memory` collection. Fixed regex in deep truths sync. Stripped root `exec` privileges from Cortex to strictly enforce the prefrontal/motor boundary. Added recency anchoring in `agent-ears.mjs` to dynamically wrap incoming GChat/Dashboard messages in a structured JSON payload with a `system_directive` reinforcing delegation. |
| **v2026.05.19.17** | Brain v3 Phase 6 — Envelope-based orchestration (Phases 1-6: classify+decide, memory, planning, checkpoint nesting M→C→T, delegation), Dashboard Work tab (real-time tree, detail panel, human-in-the-loop respond), Mouth v3 independent envelope poll (5s interval, complete+needs_input), dashboard lib refactor (shared types/api/firebase), server-side work API. |
| **v2026.05.19.18** | Brain v3 Phase 7A — Cron-driven autonomous responsibilities (R/M/C/T mental model, responsibility-manage Motor tool), rich context assembly (SOUL+IDENTITY+MEMORY in system prompt, 400K envelope context budget), per-agent generation parameters (max_tokens/temperature/top_p from agent-registry.json, Motor 65536 max output), quick ack, gateway param validation. |
| **v2026.05.19.19.0** | Brain v3 Phase 7B-C — Fleet-wide deployment of deterministic Cortex JSON orchestrator daemon (agent-brain.service) to Prime and Fleet VMs (including new PM specialty). Complete legacy cleanup: purged Prefrontal Gate, brain-exec, and check-plan-compliance from codebase and manifests. Disabled deprecated plan-compliance PostTurn hooks and updated validate-contracts. |
| **v2026.05.21.1.0** | Memory Architecture Overhaul — Three-layer memory lifecycle (Working Memory, Core Memory, Deep Truths) with active long-term pruning via `core-memory-retire`, dual-pass recall (targeted archive + broad recent + context fill), enhanced `core-memory-read --since` time-windowed queries, 10-step consolidation responsibility, and formally governed Deep Truths lifecycle. Stripped all self-monitoring responsibilities. |
| **v2026.05.21.2.0** | Deployment Hardening — Intake error resilience (automatic revert-to-pending on processing exceptions), ADC patcher fix (removed broken v2026.5.x branch using wrong sentinel key `gcp-vertex-credentials` instead of `<gce-adc>`), cross-agent poll interaction fix. |
| **v2026.05.22.1.0** | Production Hardening (Phase 8) — Periodic envelope archival (6h interval, archives complete/failed/needs_input envelopes), BRAIN_CARD.md removal (deleted files, manifests, PreTurn hooks), contracts `brain` section (8 configurable values replacing hardcoded constants), `BRAIN_V3_ENABLED` feature flag removal, `needs_input` 72h timeout, dead `delegate` handler cleanup, timestamp-based history IDs. |
| **v2026.05.22.4.0** | Brain hardening — contextual ACK, double-response fix, escalation directives, shared workspace persistence |
| **v2026.05.23.5.0** | Dashboard OAuth + Security Hardening — Google Workspace OAuth, requireAuth on 16/17 POST routes, error sanitization, branded sign-in page |
| **v2026.05.23.6.0** | Delivery Pipeline Fix + Memory Reliability — `delivery_status` field (pending/delivered/internal), mouth query restructured to single efficient query, archival limit 10→300, memory_written false-positive fix (failure patterns scoped to motor/verifier), ACK context extraction, 365-item backfill |
| **v2026.05.23.7.0** | Dashboard v3 Redesign (1health Design System) — Single-page monolith (1355 lines) → 17-page breadcrumb-navigated hierarchy (~150 lines avg). 1health design system (883 lines of design tokens). Projects as first-class Firestore entity with real-time listeners. Per-agent pages (Hub, Chat, Work, Brain, Skills, Settings). Skill Kit Library + API. No sidebar — breadcrumb navigation. 45 routes (17 pages + 28 APIs). |
| **v2026.05.23.7.1** | Dashboard v3 Polish — Removed link underlines globally, removed work bell from header, centered breadcrumb navigation, non-clickable structural breadcrumb segments (Primes/Agents), architect-prime-logo.png on home page. |
| **v2026.05.23.8.0** | Brain Resilience (Timeout Continue + Contextual Ack) — Motor timeout detection with distinct `timed_out` status, cortex `continue` action for re-dispatching timed-out tasks with check-first context, synthesize guard ignores timeouts. Contextual ack upgrade with recent mission history + project awareness for continuity recognition. DevOps SOUL hardening (task decomposition, Shared Drive flags, end-to-end verification). |
| **v2026.05.23.9.0** | Living Agent Graph Home Screen — Network topology home page replacing flat NavCard grid. Prime chips as compact selectable nodes, fleet agents as glassmorphic cards connected by animated SVG Bézier curves with traveling pulse dots. Prime/agent quick-nav icon rows for direct sub-page navigation. Staggered spring-eased entry animations, status-coded glow, hover lift effects. Fleet upgrade fix (`commandId` → `id` field mismatch). |
| **v2026.05.24.17.3** | Dashboard UX Upgrade (Split-Panel Home + Fleet Chat + Work Tree) — Full-width split-panel home with draggable divider, expandable prime chips with inline nav, inline fleet agent chat (dual-channel Firestore pipeline in ears/mouth), deploy progress bars on agent cards, M→C→T work tree hierarchy ported from demo spec (agent strip, 3-tab view, detail modal), ChatPanel component with instant-bottom scroll. Daemon log file permission fix. Shell scroll fix (viewport-locked header, no scroll-within-scroll). |
| **v2026.05.24.17.7** | Real-Time Visibility + Agent Introspection + Dashboard Polish — Real-time Cloud Build status polling (replaced fake countdown), Firestore bus introspection daemon (`agent-introspect.mjs` reads real VM filesystem), live skills page showing actual installed tools per agent, Shell header redesign (logo+title+version left-aligned with breadcrumb), Deploy Prime as inline chip, prime chip clipping fix. |
| **v2026.05.24.17.16** | Per-Job Workspace Skills + Body-Part Categorization -- Workspace tools installed per job type (devops: Drive+Gmail, pm: Drive+Gmail+Docs+Sheets, etc.), Prime stripped to infrastructure-only (zero Workspace skills), skills page reorganized by agent anatomy (Ears/Mouth/Brain/Cortex/Motor/Memory/Config/Custom), upgrade-corekit UTF-8 corruption fix, build progress UX improvements, CRLF hardening, fleet skill cleanup. |
| **v2026.05.24.19.09** | Dashboard UX Overhaul — Unified Prime/Fleet navigation (Work/Brain/Skills), Prime Brain page (6-slot LLM grid with model picker), model discovery moved to Settings→Models tab, +Hire card with dynamic specialty picker (agent-types API), floating glassmorphic chat overlay (slide-in animation, resize handle, X close), Home breadcrumb restoration, Prime Hub nav updated (Brain/Skills replace Projects/Models). |
| **v2026.05.24.19.51** | Dashboard UX Polish + Cloud Build Fix — Header version below title, specialty badge, text nav labels, hover underline removal, regional Cloud Build API, build status UX |
| **v2026.05.24.20.48** | Top-Level Route Consolidation — Work/Brain/Skills promoted to `/work`, `/brain`, `/skills` with `?prime=X&agent=Y` URL params. Built-in prime selector + agent strip. 12 old nested routes deleted. |
| **v2026.05.24.21.32** | Deployment & Scroll Fixes — Fixed `require('os')` ESM crash on Node v24 (silently broke fleet agent dashboard chat pickup), fixed Brain page crash due to ModelInfo object/string conversion, enabled vertical scrolling on Work/Brain/Skills/Settings pages (fixed viewport height shell constraints), real-time Cloud Build step-level progress estimation with elapsed time heuristics. |
| **v2026.05.24.21.48** | Workspace Agent Work Filter Hotfix — Fixed matching short agent names (e.g. `stan`) to structured email address owners (e.g. `devops-agent-stan@domain.com`) in work envelopes, and cleaned up structured email addresses to display simple, high-fidelity names universally in AgentChip, WorkDetail, and WorkTree. |
| **v2026.05.24.22.03** | Quick ACK Loop Prevention + Index Optimization — Added `quick_ack_sent` flag in Firestore to prevent infinite quick ACK loops during gateway restarts, optimized recent mission scan in memory using existing composite indexes to avoid Firestore composite index errors on GCE VMs, and added strict response check to Firestore PATCH inside mouth. |
| **v2026.05.25.2.1** | Projects & Processes Architecture (Phase 3 Composition) — Stored reusable processes with 5 step types (standard/delegation/spawn_responsibility/approval_gate/optional), responsibility→process linking (auto-execute, skip Cortex), project↔process composition with context promotion, approval gate polling + GChat approval detection in ears daemon, dashboard process editing (inline CRUD + approval badge), settings process linking UI (command builder), contracts.json `projects` section. |
| **v2026.05.25.3.0** | Codebase Audit Cleanup — Scrubbed sensitive data (project IDs, SAs, domains → placeholders), deleted 25+ stale files including entire `/p/` nested route tree (−6,462 lines), removed runtime state from git, expanded `.gitignore`, documented `job-swe.txt` alias. |


---

## License

MIT License — Copyright (c) 2026 Tachin.ai Corporation. See [LICENSE](LICENSE) for details.
