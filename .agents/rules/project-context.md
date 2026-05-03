# Architect Prime — Project Context

## What this project is
Architect Prime is an AI agent fleet management system for Google Workspace on GCP. It deploys autonomous AI agent teams (each with its own VM, OpenClaw AI brain, and Google Chat identity) that collaborate with humans via Google Chat.

## Current Architecture (v2026.05.03.6.0)

### System Stack
- **Cloud Run** — Next.js dashboard + REST API (control plane)
- **Firestore** — State: primes, fleet, messages, tasks, dispatch-log, config
- **Compute Engine VMs** — One per Prime + one per fleet agent
- **OpenClaw** — AI brain on each VM (v2026.4.19, Gemini 3.1 Pro via Vertex AI ADC)
- **Google Chat** — Agent-to-human communication via DWD

### Prime VM Architecture
- **6-agent brain**: cortex (plan executor) + 5 sub-agents (temporal-research, temporal-memory, prefrontal, motor, cerebellum)
- **Prefrontal-First Gate (Brain v2)**: prefrontal is the mandatory dispatch planner
  - PreTurn hook: injects BRAIN_CARD.md (dispatch protocol reference)
  - Prefrontal produces structured `DISPATCH_PLAN:` block (intent, pipeline, reasoning)
  - Cortex executes pipeline mechanically via sessions_spawn/yield
  - PostTurn hook: validates dispatch compliance
- **Tool ownership boundaries:**
  - Motor owns ALL Google Workspace tools (Drive, Gmail, Sheets, Docs, Calendar)
  - temporal-memory is pure memory (core-memory-read/write only, zero external APIs)
  - cerebellum has read-only verification tools
- **Dynamic skill awareness**: `assemble-tools` generates TOOLS.md from agent type's skill list, copies to cortex + prefrontal + motor workspaces
- **brain-exec v2**: `--plan-exec` (execute pipeline step), `--validate-plan` (invariant checking)
  - Rejects temporal-memory and prefrontal in pipelines (already ran in gate)
- **Input/Output decomposition** (code complete, not yet active):
  - `agent-ears.mjs` — 100% deterministic input (poll, dedup, rate-limit, gateway POST)
  - `agent-mouth.mjs` — 1 LLM call (classify+format) + deterministic delivery
  - Legacy `message-daemon.mjs` still active during transition

### Fleet VM Architecture
- Single OpenClaw agent per VM with specialty-specific workspace + brain sub-agents
- Same `message-daemon.mjs` as Prime (CHANNEL=gchat) — built-in DWD, conversation history, think-block stripping, watchdog
- CoreKit tools shared with Prime via manifest system

### Channel Abstraction
- `channel-respond` — unified response delivery for both Prime (Dashboard) and Fleet (Google Chat)
- Agent calls `exec channel-respond "text"` regardless of input channel
- `TASK.json` in workspace carries channel metadata (set by daemon at submission)
- Backends: `dashboard-respond` (Firestore) and `chat-send` (Google Chat DWD)
- This makes Prime and Fleet brains architecturally identical

### Agent State System (STATUS.json)
- `agent-status` tool reads/writes `workspace/STATUS.json` with current activity
- States: `idle → classifying → planning → dispatching → synthesizing → responding → idle`
- PreTurn hook sets `classifying`, PostTurn hook resets to `idle`
- `brain-exec` sets `dispatching` (with sub-agent name), then `synthesizing` on return
- `channel-respond` sets `responding` before delivery, `idle` after
- **Status-aware responses**: when human pings while agent is busy, daemon reads STATUS.json and responds with current activity instead of queuing

## Repository Structure
```
app/              Cloud Run dashboard (Next.js)
infra/            Bootstrap scripts, manifests, contracts.json
corekit/          Runtime tools installed on VMs (brain, fleet, gateway, chat, dashboard, memory)
brain/            Agent workspace files (SOUL.md, TOOLS.md, BRAIN_CARD.md)
specialties/      Fleet agent specialty configs
skills/           OpenClaw skill manifests
docs/             Architecture docs
```

## Development Discipline

### Versioning
- Version format: `v{YYYY}.{MM}.{DD}.{index}.{subindex}` (e.g. `v2026.04.28.1.0`)
- Every commit message: `v2026.04.28.1.0: description` (version it's building toward)
- Untagged commit = **unstable** (work in progress)
- `STABLE` tag = the single moving tag marking the last verified-good commit
- Dashboard always deploys from `main` HEAD; `STABLE` tag is a safety checkpoint
- CoreKit upgrade (`upgrade-corekit --apply main`) always pulls latest `main`
- To finalize a checkpoint: `/finalize-checkpoint` (updates docs + tags)

### Workflow
1. Edit → update manifests if adding files → update contracts.json if cross-cutting
2. `/update-git` — stage, commit (with version prefix), push
3. Dashboard upgrade button — deploys to VM
4. `/ssh-vm-access` — debug if needed
5. `/firestore-query` — verify state
6. `/finalize-checkpoint` when stable — updates docs, tags, pushes

### Mandatory Workflow Reference

**BEFORE performing any of these actions, you MUST open and follow the corresponding workflow file.** Do not ad-hoc commands from memory.

| Action | Workflow | When to use |
|--------|----------|-------------|
| SSH into any VM | `/ssh-vm-access` | Any debugging, inspection, or command execution on a running VM. Contains exact quoting patterns for `gcloud compute ssh` + `docker exec` that work in PowerShell. |
| Query Firestore | `/firestore-query` | Verifying daemon behavior, telemetry, task lifecycle, fleet status. Contains SSH-based credential path that works on GCE VMs. |
| Commit & push | `/update-git` | Staging, committing with version prefix, pushing. Contains tagging instructions. |
| Development flow | `/development-process` | Full checkpoint-driven dev cycle. Manifest-first, no-secrets discipline. |
| Finalize checkpoint | `/finalize-checkpoint` | After verifying a stable checkpoint. Updates MISSION_PLAN.md, README.md, project-context.md, then tags and pushes. |

### Key Paths on VM
- OpenClaw root: `/opt/openclaw`
- Config: `/opt/openclaw/.openclaw/openclaw.json`
- CoreKit tools: `/opt/openclaw/.openclaw/bin/`
- Workspace: `/opt/openclaw/.openclaw/workspace/`

### Constraints
- No secrets in repo — runtime injection via env vars or GCP metadata
- Manifest-driven installs — `infra/manifests/` maps repo paths to VM destinations
- contracts.json — single source of truth for cross-cutting values
- Idempotent — every script safely re-runnable
- Public repo — curl-installable from `raw.githubusercontent.com`
