# Architect Prime — Project Context

## What this project is
Architect Prime is an AI agent fleet management system for Google Workspace on GCP. It deploys autonomous AI agent teams (each with its own VM, OpenClaw AI brain, and Google Chat identity) that collaborate with humans via Google Chat.

## Current Architecture (v1.0 → v2.0 migration)

### What's running now (v1.0)
- Cloud Run control plane (Next.js dashboard + REST API)
- Prime VM with custom bash pipeline: `control-daemon → agent-ask → raw Vertex AI API`
- Fleet agent VMs with: `inbox-daemon → agent-ask → raw Vertex AI API`
- OpenClaw is **installed but not activated** on VMs

### What we're building (v2.0)
- Replace the custom bash pipeline with OpenClaw's native agent loop
- Each VM runs an OpenClaw gateway with a **single main agent**
- `control-daemon` and `inbox-daemon` become thin message bridges to the OpenClaw gateway API
- OpenClaw handles: persistent sessions, conversation memory, context pruning, tool execution
- Fleet management tools (`fleet-deploy`, `fleet-teardown`) run as `exec` tools on OpenClaw's PATH

### Architecture: Single Main Agent (Phase 1)
Each VM gets one OpenClaw agent. No sub-agents, no brain model yet.

| VM | Agent | Message Source | Tools |
|----|-------|---------------|-------|
| **Prime VM** | `main` | Dashboard (Firestore) | `fleet-deploy`, `fleet-teardown`, `fleet-verify`, `fleet-upgrade` |
| **Fleet VM** | `{agent-name}` | Google Chat (DWD) | Specialty-specific (TBD per type) |

### Future: Brain Architecture (Phase 2+)
The 7-agent brain model (Cortex + 6 sub-agents) is documented in `docs/architecture/BRAIN_ARCHITECTURE_v2.md` but is **not yet implemented**. It will be layered on top of the single-agent foundation after v2.0 is stable.

## Key Infrastructure
- Cloud Run (control plane + dashboard)
- Firestore (state: primes, fleet, messages, config)
- Compute Engine VMs (one per Prime + one per fleet agent)
- OpenClaw (AI brain on each VM — being activated in v2.0)
- Vertex AI Gemini (LLM via ADC, no API keys)
- Google Chat via DWD (agent-to-human communication)

## Repository Structure
- `app/` — Cloud Run control plane (Next.js dashboard + REST API)
- `bundle/corekit/bin/` — CoreKit tools installed on VMs
- `bundle/corekit/config/` — OpenClaw bootstrap, agent types, chat config
- `bundle/workspaces/` — Agent workspace files (SOUL.md, IDENTITY.md, etc.)
- `bundle/openclaw/` — OpenClaw agent bootstrap (auth profiles, sessions)
- `bootstrap/` — VM startup scripts (phase1 Cloud Shell, phase2 on-VM)
- `deploy/` — Installation scripts (install.sh, uninstall.sh)
- `docs/architecture/` — Future architecture specs (brain model, R/C/M framework)

## Reference Docs
- `docs/architecture/BRAIN_ARCHITECTURE_v2.md` — Future brain agent specs (NOT YET IMPLEMENTED)
- `docs/architecture/RESPONSIBILITIES_CHECKPOINTS_MISSIONS.md` — Future R/C/M framework (NOT YET IMPLEMENTED)
