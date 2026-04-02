# Architect Prime

**AI Agent Fleet Management for Google Workspace**

Deploy autonomous AI agent teams into your own GCP project. Prime orchestrates specialist agents — each with its own VM, AI brain, and Google Chat identity — that collaborate with your team to get work done.

---

## What It Does

| Capability | How It Works |
|-----------|-------------|
| **Deploy Prime** | One command installs the control plane (Cloud Run) into your GCP project |
| **Manage Fleet** | Web dashboard to hire/fire specialist agents (devops, swe, qa, pm, data, security) |
| **Chat with Prime** | Talk to your orchestrator directly through the dashboard |
| **Agent Communication** | Fleet agents communicate via Google Chat using their own Workspace emails (DWD) |
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

Your Prime will be ready in ~90 seconds. It runs on a Compute Engine VM with an OpenClaw AI brain powered by Vertex AI.

### 2. Configure Domain-Wide Delegation (Optional)

If you want fleet agents to communicate via Google Chat:

1. Go to **Dashboard → Setup tab**
2. Copy the **Client ID** and **OAuth Scopes** shown
3. Open [Google Admin → Security → API Controls → DWD](https://admin.google.com/ac/owl/domainwidedelegation)
4. Click **"Add new"**, paste the Client ID and scopes
5. Click **"Test DWD"** in the dashboard to verify

### 3. Hire Fleet Agents

1. Create a Workspace email for the agent (e.g., `job-agent-stan@yourcompany.com`)
2. Go to **Dashboard → Fleet tab → + Hire Agent**
3. Enter name, specialty, and the Workspace email
4. Prime will deploy a specialist VM and bring the agent online

### 4. Chat & Collaborate

- **Dashboard Chat**: Talk to Prime directly through the web interface
- **Google Chat**: Add fleet agent emails to your Chat spaces — they read and respond independently

---

## Architecture

```
Your GCP Project
├── Cloud Run (control plane)
│   ├── Dashboard UI (deploy, chat, fleet, setup)
│   ├── REST API (primes, fleet, messages, upgrade)
│   └── Firestore client (state management)
│
├── Firestore (state store)
│   ├── /primes/{id}         → Prime instance records
│   ├── /primes/{id}/msgs    → Chat messages
│   ├── /primes/{id}/fleet   → Fleet agent records
│   └── /config/dwd          → DWD configuration
│
├── Prime VM(s) (Compute Engine)
│   ├── control-daemon       → Firestore message polling
│   ├── agent-ask            → Gemini LLM brain (Vertex AI)
│   ├── fleet-deploy         → Hire specialist agents
│   └── fleet-teardown       → Fire agents
│
└── Fleet Agent VMs (Compute Engine, one per agent)
    ├── inbox-daemon          → Google Chat polling (DWD)
    ├── agent-ask             → Specialist LLM brain
    ├── chat-send / chat-read → DWD Chat tools
    └── Custom skills & personality
```

### Key Design Decisions

- **Single Project**: All VMs share one GCP project — isolation at VM/SA level
- **Per-Agent Identity**: Each agent has its own VM, Service Account, OpenClaw instance, and Workspace email
- **Specialist Focus**: Agents perform better with fewer, verified tools — each has a curated skillset
- **Peer-to-Peer**: Agents collaborate via Google Chat, not through Prime

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

deploy/                           # Installation scripts
├── install.sh                    # One-command installer
├── uninstall.sh                  # Clean teardown
└── tutorial.md                   # Cloud Shell guided tutorial

bundle/corekit/bin/               # CoreKit tools (installed on VMs)
├── agent-ask                     # LLM brain (Gemini + function calling)
├── control-daemon                # Firestore poller (Prime VMs)
├── inbox-daemon                  # Google Chat poller (fleet agents)
├── fleet-deploy                  # Hire an agent
├── fleet-teardown                # Fire an agent
├── chat-send / chat-read         # Google Chat DWD tools
├── dwd-token                     # DWD token generator
├── upgrade-corekit               # Self-upgrade mechanism
└── build-system-prompt           # Agent personality builder

bootstrap/phase2-vm.sh            # VM startup script
install.sh                        # CoreKit manifest installer
```

---

## Uninstall

```bash
export PROJECT_ID="your-project-id"
bash deploy/uninstall.sh
```

This removes all VMs, service accounts, Cloud Run service, and Firestore data. You'll be prompted to confirm with `YES`.

---

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Self-hosted** | Customer owns all infrastructure, data, and credentials |
| **No secrets in git** | Runtime injection via env vars and GCE metadata |
| **Agent isolation** | Each fleet agent: own VM, own SA, own OpenClaw, own personality |
| **Specialist focus** | Less tools = better performance. Curated skillsets per specialty |
| **Idempotent** | All installs, deploys, and upgrades are repeatable |
| **Observable** | All agent communication logged in Firestore and auditable |

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
| **v1.0** | **Production release** |

---

## License

Proprietary — Tachin AI Corporation. All rights reserved.
