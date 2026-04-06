# Architect Prime

**AI Agent Fleet Management for Google Cloud**

Deploy autonomous AI agent teams into your own GCP project. Prime orchestrates specialist agents — each with its own VM, OpenClaw AI brain (powered by Vertex AI), and identity — that collaborate to get work done.

---

## What It Does

| Capability | How It Works |
|-----------|-------------|
| **Deploy Prime** | Dashboard deploys a Prime VM with a full OpenClaw AI brain |
| **Manage Fleet** | Web dashboard to hire/fire specialist agents (devops, swe, qa, pm, data, security) |
| **Chat with Prime** | Talk to your orchestrator directly through the dashboard |
| **Agent Communication** | Fleet agents communicate via Google Chat using DWD Workspace emails |
| **Self-Hosted** | Everything runs in YOUR project — zero shared infrastructure |
| **No API Keys** | Pure Service Account + Vertex AI authentication |

---

## Quick Deploy

### Option A: Cloud Shell (Recommended)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent&tutorial=deploy/tutorial.md)

### Option B: Manual

```bash
git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent
cd architect-prime-gcp-agent
export PROJECT_ID="your-project-id"
bash deploy/install.sh
```

The installer will:
1. Enable required GCP APIs (Cloud Run, Firestore, Compute, Vertex AI, IAM)
2. Create service accounts with least-privilege IAM roles
3. Create the DWD signer SA for agent-to-Chat communication
4. Deploy the Cloud Run control plane
5. Seed Firestore with initial configuration

After install, open the printed URL to access the dashboard.

---

## Getting Started

### 1. Deploy Your First Prime

Open the dashboard → Enter a name (e.g., "alpha") → Click **Deploy Prime**.

Your Prime will be ready in ~15 minutes. It runs on a Compute Engine VM (e2-medium) with a Docker-containerized OpenClaw AI brain powered by Vertex AI Gemini.

### 2. Configure Domain-Wide Delegation (Optional)

If you want fleet agents to communicate via Google Chat:

1. Go to **Dashboard → Setup tab**
2. Copy the **Client ID** and **OAuth Scopes** shown
3. Open [Google Admin → Security → API Controls → DWD](https://admin.google.com/ac/owl/domainwidedelegation)
4. Click **"Add new"**, paste the Client ID and scopes
5. Click **"Test DWD"** in the dashboard to verify

### 3. Hire Fleet Agents

1. Create a Workspace email for the agent (e.g., `job-agent-stan@yourcompany.com`)
2. Go to **Dashboard → Chat tab → ask Prime to hire an agent**
3. Prime will deploy a specialist VM and bring the agent online

### 4. Chat & Collaborate

- **Dashboard Chat**: Talk to Prime directly through the web interface
- **Google Chat**: Add fleet agent emails to your Chat spaces — they read and respond independently

---

## Architecture

```
Your GCP Project
├── Cloud Run (control plane)
│   ├── Dashboard UI (chat, fleet, setup tabs)
│   ├── REST API (primes, fleet, messages)
│   └── Firestore client (state management)
│
├── Firestore (state store)
│   ├── /primes/{id}             → Prime instance records
│   ├── /primes/{id}/messages    → Chat messages
│   ├── /primes/{id}/fleet       → Fleet agent records
│   └── /config/dwd              → DWD configuration
│
├── Prime VM (Compute Engine e2-medium)
│   ├── openclaw-gateway (Docker) → Full AI agent runtime
│   ├── control-daemon (systemd)  → Firestore message bridge
│   ├── CoreKit tools             → fleet-deploy, fleet-teardown, etc.
│   └── Workspace files           → SOUL.md, TOOLS.md, MEMORY.md
│
└── Fleet Agent VMs (Compute Engine, one per agent)
    ├── openclaw-gateway (Docker) → Specialist AI brain
    ├── inbox-daemon (systemd)    → Google Chat polling (DWD)
    ├── chat-send / chat-read     → DWD Chat tools
    └── Custom skills & personality
```

### Key Design Decisions

- **Single Project**: All VMs share one GCP project — isolation at VM level
- **OpenClaw Framework**: Each agent runs a full OpenClaw instance with conversation memory, tool execution, and context management — not a custom LLM wrapper
- **Specialist Focus**: Agents perform better with fewer, verified tools — each has a curated skillset
- **Docker-Containerized**: OpenClaw runs in Docker (`--network host`) for isolation and reproducibility

---

## Repository Structure

```
app/                              # Cloud Run control plane (Next.js)
├── src/app/page.tsx              # Dashboard UI (chat, fleet, setup)
├── src/app/api/                  # REST API routes
│   ├── primes/                   # Prime CRUD + deploy
│   ├── primes/[id]/fleet/        # Fleet hire/fire/list
│   ├── primes/[id]/messages/     # Chat messages
│   ├── setup/                    # DWD config + test
│   └── upgrade/                  # Version check + upgrade
├── src/lib/                      # Firestore, auth utilities
└── Dockerfile                    # Cloud Run container

bootstrap/                        # VM startup scripts
├── prime-bootstrap.sh            # Prime VM bootstrap (standalone bash)
├── fleet-bootstrap.sh            # Fleet agent VM bootstrap (mirrors Prime)
├── phase1-cloudshell.sh          # GCP project setup (manual flow)
└── phase2-vm.sh                  # Legacy VM startup (reference)

bundle/corekit/bin/               # CoreKit tools (installed on VMs)
├── control-daemon                # Firestore poller (Prime VMs)
├── inbox-daemon                  # Google Chat poller (fleet agents)
├── fleet-deploy                  # Hire an agent
├── fleet-teardown                # Fire an agent
├── chat-send / chat-read         # Google Chat DWD tools
├── dwd-token                     # DWD token generator
├── upgrade-corekit               # Self-upgrade mechanism
└── build-system-prompt           # Agent personality builder

bundle/workspaces/                # Agent persona files
├── main/                         # Prime agent (SOUL, TOOLS, MEMORY, etc.)
├── engineer/                     # Engineer specialty workspace
├── devops/                       # DevOps specialty workspace
└── fleet/                        # Fleet agent template

bundle/corekit/config/            # Config templates
├── openclaw-bootstrap.json5.tmpl # Prime OpenClaw config
└── openclaw-fleet-bootstrap.json5.tmpl # Fleet OpenClaw config

deploy/                           # Installation scripts
├── install.sh                    # One-command installer
├── uninstall.sh                  # Clean teardown
└── tutorial.md                   # Cloud Shell guided tutorial

install.sh                        # CoreKit manifest installer
manifest.txt                      # Repo path → VM path mapping
```

---

## How Bootstrap Works

The deploy API uses a **boot stub pattern**:

1. Dashboard calls `POST /api/primes/{id}/deploy`
2. Route creates a GCE VM with a ~10 line boot stub as the startup script
3. Boot stub curls `bootstrap/prime-bootstrap.sh` from GitHub
4. `prime-bootstrap.sh` handles everything:
   - Installs Docker CE (via `get.docker.com`)
   - Installs CoreKit via manifest (`install.sh`)
   - Clones OpenClaw, builds Docker image
   - Starts OpenClaw container (`--network host`)
   - Applies bootstrap config via RPC (retry + baseHash)
   - Installs `control-daemon` as systemd service

**Key benefit**: Bootstrap changes only require a `git push` — no Cloud Run rebuild needed.

---

## Uninstall

```bash
export PROJECT_ID="your-project-id"
bash deploy/uninstall.sh
```

This removes all VMs, service accounts, Cloud Run service, and Firestore data.

---

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Self-hosted** | Customer owns all infrastructure, data, and credentials |
| **No secrets in git** | Runtime injection via env vars, GCE metadata, and DWD signJwt |
| **OpenClaw-native** | Full agent framework — not a custom LLM wrapper |
| **Docker-containerized** | OpenClaw runs in Docker for isolation and reproducibility |
| **Boot stub pattern** | Startup script is pure bash on GitHub — no JS template escaping |
| **Idempotent** | All installs, deploys, and upgrades are repeatable |
| **Observable** | All communication logged in Firestore and auditable |

---

## Version History

| Version | Milestone |
|---------|-----------|
| v0.1–v0.3 | CoreKit scaffold, manifest, self-upgrade |
| v0.4–v0.5 | Google Chat integration, command loop |
| v0.6 | Fleet agent template |
| v0.7–v0.7.1 | DWD integration, shared signer SA |
| v0.8 | Cloud Run control plane, Firestore chat, VM provisioning |
| v0.9 | Fleet hire/fire from dashboard, single-project model |
| v0.9.1 | DWD setup wizard |
| v0.9.2 | Fleet agent logs & monitoring |
| v0.9.3 | Version display + upgrade button |
| **v2.0** | **OpenClaw pivot — Docker-based agent brain, boot stub pattern, fleet agents on OpenClaw** |

---

## License

Proprietary — Tachin AI Corporation. All rights reserved.
