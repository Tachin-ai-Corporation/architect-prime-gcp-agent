# Architect Prime

AI Agent Fleet Management for Google Workspace.

Deploy Prime into your own GCP project. Manage AI agent fleets through a web dashboard. Fleet agents collaborate with your team in Google Chat.

---

## Quick Deploy

Click below to deploy the Architect Prime control plane into your GCP project:

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent&tutorial=deploy/tutorial.md)

Or manually:

```
git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent
cd architect-prime-gcp-agent
export PROJECT_ID=your-project-id
bash deploy/install.sh
```

---

## Architecture

```
Your GCP Project
+-- Cloud Run (control plane web app)
|   +-- Dashboard UI
|   +-- Chat with Prime instances
|   +-- Fleet management API
+-- Firestore (state store)
+-- Prime VM(s) (OpenClaw + CoreKit)
|   +-- control-daemon (Firestore polling)
|   +-- agent-ask (Gemini LLM brain)
+-- Fleet Agent VMs (each with own OpenClaw)
    +-- inbox-daemon (GChat polling via DWD)
    +-- Unique personality, skills, specialty
```

**Key points:**
- Everything runs in YOUR GCP project (zero shared infrastructure)
- Prime talks to you through the web dashboard
- Fleet agents talk to your team through Google Chat
- Each agent has its own VM, OpenClaw instance, and personality
- Agents share DWD signer SA and LLM credentials

---

## Repository Structure

```
app/                          # Cloud Run control plane (Next.js)
+-- src/app/                  # Pages and API routes
+-- src/lib/                  # Firestore, auth
+-- Dockerfile                # Cloud Run container

deploy/                       # Cloud Shell deployment
+-- install.sh                # One-shot deploy script
+-- tutorial.md               # Guided Cloud Shell tutorial

bundle/corekit/bin/           # CoreKit tools (installed on VMs)
+-- agent-ask                 # LLM brain (Gemini + function calling)
+-- control-daemon            # Firestore poller (Prime VMs)
+-- inbox-daemon              # GChat poller (fleet agent VMs)
+-- fleet-deploy              # Hire an agent
+-- fleet-teardown            # Fire an agent
+-- chat-send, chat-read      # GChat DWD tools (fleet agents)
+-- dwd-token                 # DWD token generator
+-- build-system-prompt       # Agent personality builder

bootstrap/phase2-vm.sh        # VM startup script
install.sh                    # CoreKit manifest installer
```

---

## Design Principles

- **Self-hosted**: Customer owns all infrastructure and data
- **No secrets in git**: Runtime injection via env vars and metadata
- **Each agent is unique**: Own VM, OpenClaw, skills, personality
- **Idempotent**: All installs and deploys are repeatable
- **Observable**: All agent communication logged and auditable
