# Architect Prime

**Self-Bootstrapping AI Agent Factory for Google Cloud**

Architect Prime is an **agent factory** — it creates, upgrades, monitors, and tears down autonomous AI agents running on your own GCP infrastructure. Each agent gets its own Compute Engine VM, a Docker-containerized [OpenClaw](https://github.com/openclaw/openclaw) brain powered by Vertex AI Gemini, and a Google Workspace identity for team collaboration via Google Chat.

Prime handles **infrastructure, not orchestration**. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

> **Current version:** `v5.2.0`

---

## What It Does

| Capability | How It Works |
|-----------|-------------|
| **Deploy Prime** | Dashboard deploys a Prime VM with a multi-agent brain (6 sub-agents) |
| **Manage Fleet** | Hire/fire specialist agents from the dashboard — DevOps, Engineer, and more |
| **Chat with Prime** | Talk to your orchestrator through the web dashboard (non-streaming + async watchdog) |
| **Agent Communication** | Fleet agents communicate via Google Chat using Domain-Wide Delegation |
| **Dynamic Model Discovery** | Scan Vertex AI Model Garden — auto-detect available Gemini, Claude, and other models |
| **Self-Upgrading** | Dashboard upgrades itself via Cloud Build; CoreKit upgrades cascade to fleet |
| **Contract Enforcement** | `contracts.json` is the single source of truth — validated at bootstrap and upgrade |
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
│   ├── Dashboard UI (chat, fleet, setup, models)
│   ├── REST API (primes, fleet, messages, commands, upgrade)
│   └── Firestore client (state management)
│
├── Firestore (State Store)
│   ├── primes/{id}                   → Prime instance metadata
│   ├── primes/{id}/messages/{msg}    → Dashboard ↔ Prime chat
│   ├── primes/{id}/fleet/{agent}     → Fleet agent status + health
│   ├── primes/{id}/brain/            → Dispatch telemetry
│   ├── primes/{id}/memory/core/      → Durable Core Memory
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
│   ├── control-daemon (systemd) → Firestore message bridge (Node.js, non-streaming + anti-spam)
│   ├── CoreKit (34 scripts)     → fleet, gateway, chat, brain, memory, dashboard, system
│   └── contracts.json           → Cross-cutting values (models, ports, agent IDs)
│
└── Fleet Agent VMs (Compute Engine e2-medium, one per agent)
    ├── openclaw-gateway (Docker) → Specialist AI brain (cortex on Gemini 3.1 Pro)
    ├── inbox-daemon (systemd)    → Google Chat polling via DWD (non-streaming + ACK timer)
    ├── CoreKit (role-specific)   → Manifest-installed tools
    └── Specialty workspace       → SOUL.md, IDENTITY.md, TOOLS.md (per agent type)
```

### Brain Architecture (Prime)

Prime's brain uses **multi-agent dispatch** — Cortex is the user-facing orchestrator that delegates to 5 specialist sub-agents:

| Agent | Model | Role |
|-------|-------|------|
| **cortex** | gemini-3.1-pro-preview | Orchestrator + synthesizer (DEFAULT) |
| **temporal-research** | gemini-2.5-flash | Web search via Vertex AI grounding |
| **temporal-memory** | gemini-2.5-flash | Memory recall + nightly consolidation |
| **prefrontal** | gemini-2.5-flash | Strategic planning |
| **motor** | gemini-2.5-flash | Code execution + commands |
| **cerebellum** | gemini-2.5-flash | Verification + QA |

Dispatch flow: `cortex` → `exec brain-exec <agent-id> "<task>"` → sub-agent runs → output returned to cortex → cortex synthesizes response.

### Key Design Decisions

- **Contract-driven** — `contracts.json` is the single source of truth for models, ports, agent IDs, and environment. `validate-contracts` enforces consistency at bootstrap and upgrade.
- **Boot stub pattern** — VM startup scripts curl bash scripts from GitHub. Bootstrap changes only need `git push`, not a Cloud Run rebuild.
- **Modular manifests** — `install.sh --role prime|fleet --job devops|engineer` chains base + role + job fragments. Each specialty is independently iterable.
- **ADC authentication** — Pure Application Default Credentials via GCE metadata. No API keys, no service account key files.
- **OpenClaw-native** — Full agent framework with conversation memory, tool execution, and workspace files. Not a custom LLM wrapper.

---

## Repository Structure

```
architect-prime/
├── app/                              # MODULE 1: Control Plane (Cloud Run, Next.js)
│   ├── src/app/page.tsx              # Dashboard UI (single-page)
│   ├── src/app/api/primes/[id]/      # REST API routes
│   │   ├── messages/                 # Dashboard ↔ Prime chat
│   │   ├── commands/                 # Command execution bridge
│   │   ├── deploy/                   # Prime VM creation
│   │   └── fleet/                    # Fleet lifecycle (hire, fire, status, health)
│   ├── src/components/settings/      # Settings tabs (General, Models, System)
│   ├── src/lib/                      # Firestore, auth utilities
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
│   │   └── job-engineer.txt          # Engineer specialty workspace
│   └── deploy/                       # Standalone install/uninstall scripts
│       ├── install.sh                # One-command project installer
│       ├── uninstall.sh              # Clean teardown
│       └── tutorial.md               # Cloud Shell guided tutorial
│
├── corekit/                          # MODULE 3: CoreKit Runtime (34 VM-side scripts)
│   ├── fleet/                        # Fleet lifecycle (9 scripts)
│   ├── gateway/                      # OpenClaw gateway management (5 scripts)
│   ├── chat/                         # Google Chat / DWD integration (4 scripts)
│   ├── brain/                        # Brain execution layer (6 scripts)
│   ├── memory/                       # Memory subsystem (3 scripts)
│   ├── dashboard/                    # Dashboard bridge (4 scripts)
│   ├── system/                       # Cross-cutting utilities (3 scripts)
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
│   ├── devops/workspace/             # DevOps specialty (8 files)
│   └── engineer/workspace/           # Engineer specialty (8 files)
│
├── skills/                           # MODULE 6: Skill Packages
│   ├── agent-ask/                    # Vertex AI grounding web search
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
   - Builds OpenClaw Docker image from pinned commit (`v2026.4.19`)
   - Renders gateway config from JSON5 template with contract values
   - Starts OpenClaw container (`--network host`, port 18789)
   - Applies ADC auth patch for GCE metadata fallback
   - Warm-up probe through cortex route
   - Installs `control-daemon` as systemd service

**Fleet agents** follow the same pattern via `infra/bootstrap/fleet-bootstrap.sh`:
- `infra/install.sh --role fleet --job {specialty}` (chains `base.txt` + `role-fleet.txt` + `job-{specialty}.txt`)
- Deploys specialty workspace, validates rendered config via `validate-contracts --file`
- Starts `inbox-daemon` for Google Chat polling
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
| **Self-upgradable** | Dashboard self-upgrades via Cloud Build; CoreKit cascades to fleet |
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

---

## License

MIT License — Copyright (c) 2026 Tachin.ai Corporation. See [LICENSE](LICENSE) for details.
