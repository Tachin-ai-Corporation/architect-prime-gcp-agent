# Architect Prime

**Self-Bootstrapping AI Agent Factory for Google Cloud**

Architect Prime is an **agent factory** — it creates, upgrades, monitors, and tears down autonomous AI agents running on your own GCP infrastructure. Each agent gets its own Compute Engine VM, a Compute Engine host-native brain powered by Vertex AI Gemini, and a Google Workspace identity for team collaboration via Google Chat.

Prime handles **infrastructure, not orchestration**. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

> **Current version:** `v2026.06.08.1.0`


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
| **Plan Management** | Process-driven plans (draft → approve → execute) with full M→C→T blueprint visualization |
| **Project Hierarchy** | Recursive projects with context accumulation, dependency tracking, and auto-completion |
| **Agent Introspection** | Query actual installed tools/skills from agent VMs via Firestore bus — real filesystem data |
| **Autonomous Responsibilities** | Agents self-program recurring duties with cron/event triggers — R/M/C/T hierarchy |
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

Your Prime will be ready in ~15 minutes. It runs on a Compute Engine VM (e2-medium) with a Compute Engine host-native brain featuring 6 specialized sub-agents powered by Vertex AI Gemini.

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
│   ├── Dashboard UI (18-route hierarchical navigation, 1health design system)
│   ├── Routes: /p/[id]/... (prime-scoped) + /library/... (global)
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
│   ├── agent-brain-gateway (systemd, port 18789)
│   │   ├── cortex          — claude-opus-4-6 (configurable) — orchestrator (DEFAULT)
│   │   ├── temporal-research — Gemini 2.5 Flash — web search (Vertex AI grounding)
│   │   ├── temporal-memory — Gemini 2.5 Flash — memory/context recall
│   │   ├── prefrontal      — Gemini 2.5 Flash — strategic planning
│   │   ├── motor           — Gemini 2.5 Flash — execution (code + commands)
│   │   └── cerebellum      — Gemini 2.5 Flash — verification + QA
│   ├── agent-ears (systemd)       → Deterministic input processing (fire-and-forget, zero LLM)
│   ├── agent-brain (systemd)      → Brain state machine (intake → classify → decide → dispatch → synthesize)
│   ├── agent-mouth (systemd)      → Output classification + delivery (strict LLM filter)
│   ├── REST API: GET /api/primes/{id}/work, POST /api/primes/{id}/work/{workId}/respond
│   ├── CoreKit (50 scripts)     → fleet, chat, brain, memory, dashboard, system
│   └── contracts.json           → Cross-cutting values (models, ports, agent IDs)
│
└── Fleet Agent VMs (Compute Engine e2-medium, one per agent)
    ├── agent-brain-gateway (systemd, port 18789) → Specialist AI brain (cortex on Claude 3 Opus / Gemini)
    ├── agent-ears (systemd)      → GChat polling via DWD (deterministic, fire-and-forget)
    ├── agent-mouth (systemd)     → Output classification + GChat delivery
    ├── CoreKit (role-specific)   → Manifest-installed tools
    └── Specialty workspace       → SOUL.md, IDENTITY.md, TOOLS.md (per agent type)
```

### Brain Architecture (Prime)

Prime's brain uses **multi-agent dispatch** — Cortex is the user-facing orchestrator that delegates to 5 specialist sub-agents:

| Agent | Model | Role |
|-------|-------|------|
| **cortex** | claude-opus-4-6 (configurable) | Plan executor + synthesizer (DEFAULT) |
| **temporal-research** | gemini-2.5-flash | Web search + URL fetching (Vertex AI grounding + web-fetch) |
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
- **Native Brain Gateway** — Full agent framework with conversation memory, tool execution, and workspace files. Not a custom LLM wrapper.

---

## Repository Structure

```
architect-prime/
├── app/                              # MODULE 1: Control Plane (Cloud Run, Next.js)
│   ├── src/app/page.tsx              # Home (agent network topology)
│   ├── src/app/p/[id]/               # Prime Hub + prime-scoped pages
│   │   ├── a/[agent]/                # Agent Deep Dive (7 tabs)
│   │   ├── fleet/                    # Fleet Management
│   │   ├── work/                     # Work Tree
│   │   ├── plans/                    # Plans (draft/approved/executing/complete)
│   │   ├── projects/                 # Projects (hierarchy, context, dependencies)
│   │   ├── processes/                # Processes
│   │   ├── config/                   # Prime Configuration
│   │   └── chat/                     # Prime Chat
│   ├── src/app/library/              # Library Hub (global)
│   │   ├── skills/                   # Skill Catalog
│   │   ├── agent-types/              # Agent Type Explorer
│   │   └── models/                   # Model Catalog
│   ├── src/app/settings/             # Dashboard Settings
│   ├── src/app/api/primes/[id]/      # REST API routes (19 routes)
│   ├── src/components/               # Shell, Breadcrumb, NavCard, LiveIndicator, AgentHeader
│   │   ├── agent/                    # BrainInspector, SkillInventory, ResponsibilityList, MemoryViewer
│   │   └── work/                     # WorkTree, WorkDetail, useWorkEnvelopes
│   ├── src/contexts/                 # PrimeContext (shared state)
│   ├── src/hooks/                    # useProjects, useIntrospect
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
├── corekit/                          # MODULE 3: CoreKit Runtime (50 scripts)
│   ├── fleet/                        # Fleet lifecycle (9 scripts)
│   ├── chat/                         # Google Chat / DWD integration (3 scripts)
│   ├── brain/                        # Brain execution layer (19 scripts)
│   ├── memory/                       # Memory subsystem (5 scripts)
│   ├── dashboard/                    # Dashboard bridge (1 script)
│   ├── daemon/                       # Ears/Mouth/Brain I/O daemons (10 scripts)
│   ├── system/                       # Cross-cutting utilities (3 scripts)
│   └── config/                       # Templates, service files, agent-types
│
├── brain/                            # MODULE 4: Agent Identity
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
├── docs/                             # Documentation
│   ├── CULTURE_OF_WORK.md            # Culture of Work framework (7 primitives)
│   ├── primitives/                   # Primitive reference docs (Task → Responsibility)
│   ├── guides/                       # Authoring guides (processes, responsibilities)
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
   - Installs Node.js & npm on the GCE VM host
   - Installs CoreKit via `infra/install.sh --role prime` (chains `base.txt` + `role-prime.txt`)
   - Runs `npm install` on the host directory `/opt/corekit/corekit/brain`
   - Generates agent configuration `config.json` files
   - Starts `agent-brain-gateway` systemd service (port 18789)
   - Starts `agent-ears`, `agent-mouth`, `agent-brain`, and `agent-introspect` systemd services

**Fleet agents** follow the same pattern via `infra/bootstrap/fleet-bootstrap.sh`:
- `infra/install.sh --role fleet --job {specialty}` (chains `base.txt` + `role-fleet.txt` + `job-{specialty}.txt`)
- Deploys specialty workspace, validates rendered config via `validate-contracts --file`
- Writes `.identity-lock` (DWD impersonation guard)
- Starts `agent-brain-gateway` systemd service (port 18789)
- Starts `agent-ears`, `agent-mouth`, and `agent-introspect` systemd services
- Self-reports online status to Firestore

**Key benefit**: Bootstrap changes only require a `git push` — no Cloud Run rebuild needed.

---

## Contract Enforcement

`infra/contracts.json` is the **single source of truth** for all cross-cutting values:

```json
{
  "version": 2,
  "vertex": {
    "location": "us-central1",
    "models": {
      "cortex": "vertex-anthropic/claude-opus-4-6",
      "cortexFallback": "vertex-google/gemini-2.5-pro",
      "subagent": "vertex-google/gemini-2.5-flash"
    }
  },
  "agents": {
    "defaultId": "cortex",
    "subagentIds": ["temporal-research", "temporal-memory", "prefrontal", "motor", "cerebellum"]
  },
  "gateway": {
    "port": 18789,
    "timeoutSeconds": 180,
    "bind": "loopback"
  }
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
| **Native Brain Gateway** | Full agent framework with memory, tools, and sessions |
| **Host-native** | The brain gateway runs directly on the GCE host under systemd |
| **Idempotent** | All installs, deploys, and upgrades are safely re-runnable |
| **Self-upgradable** | Dashboard self-upgrades via Cloud Build; fleet agents upgraded individually via dashboard |
| **Fail fast** | `validate-contracts` runs before container start — catches config errors in seconds |
| **Observable** | All communication logged in Firestore; structured JSON logging with telemetry |

---

## Version History

| Version | Milestone |
|---------|-----------|
| v0.1–v0.9 | CoreKit scaffold → manifest → Chat integration → Cloud Run control plane → fleet lifecycle → DWD |
| **v2.0** | Boot stub pattern, Docker-based agent brain |
| **v3.0** | Multi-agent brain — 5 brain agents, exec dispatch |
| **v4.0** | Contract enforcement — `contracts.json`, `validate-contracts`, modular manifests |
| **v5.0** | 6-module architecture (`app/`, `infra/`, `corekit/`, `brain/`, `specialties/`, `skills/`) |
| **v2026.05.19.17.0** | Brain v3 — Envelope-based orchestration, M→C→T hierarchy, Work dashboard |
| **v2026.05.23.7.0** | Dashboard v3 — 8-page dashboard, shared FleetSelector |
| **v2026.05.25.2.1** | Processes & Responsibilities — Cron-driven autonomy, approval gates |
| **v2026.05.27.12.0** | Skill Ecosystem — Self-describing manifests, per-agent TOOLS.md, skill discovery |
| **v2026.06.05.1.0** | Host-native migration — Removed Docker/OpenClaw, systemd-based brain gateway |
| **v2026.06.06.4.0** | **Baseline checkpoint** — Dead code cleanup, fleet bug fixes, M→C→T enforcement, docs restructure |
| **v2026.06.06.5.0** | **Dashboard Redesign** — Hierarchical /p/[id] routing, Agent Deep Dive (7 tabs), Library namespace, LiveIndicator, responsive tabs |
| **v2026.06.07.1.0** | **Process Hardening** — Plan/Investigate v2 (read-only research steps, Drive artifact output, approval gate), auto-fill from source_meta |
| **v2026.06.08.1.0** | **Culture of Work** — 7 primitives (Task/Checkpoint/Mission/Project/Process/Plan/Responsibility), Plan engine (create→approve→stamp), recursive Projects with depends_on, event-triggered responsibilities, 6 core processes, dashboard Plans page, 12 documentation files |

Full version history is in git (`git log --oneline`).


---

## License

MIT License — Copyright (c) 2026 Tachin.ai Corporation. See [LICENSE](LICENSE) for details.
