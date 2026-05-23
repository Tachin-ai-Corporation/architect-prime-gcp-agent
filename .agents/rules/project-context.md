# Architect Prime — Project Context

## What this project is
Architect Prime is an AI agent fleet management system for Google Workspace on GCP. It deploys autonomous AI agent teams (each with its own VM, OpenClaw AI brain, and Google Chat identity) that collaborate with humans via Google Chat.

## Current Architecture (v2026.05.23.7.1)

### System Stack
- **Cloud Run** — Next.js dashboard (17-page breadcrumb-navigated hierarchy, 1health design system) + REST API (control plane)
- **Firestore** — State: primes, fleet, messages, tasks, dispatch-log, config
- **Compute Engine VMs** — One per Prime + one per fleet agent
- **OpenClaw** — AI brain on each VM (v2026.4.15, Gemini 3.1 Pro via Vertex AI ADC)
- **Google Chat** — Agent-to-human communication via DWD

### Prime VM Architecture
- **6-agent brain**: cortex (plan executor) + 5 sub-agents (temporal-research, temporal-memory, prefrontal, motor, cerebellum)
- **Brain v3 (agent-brain.mjs)**: Deterministic envelope-based orchestration daemon running as a continuous systemd service. Polls Firestore intake → Cortex classify → Cortex decide loop → dispatches to sub-agents → synthesize. R/M/C/T hierarchy (Responsibilities → Missions → Checkpoints → Tasks). Rich context assembly: SOUL.md + IDENTITY.md + MEMORY.md + full agent registry in system prompt (~20K tokens). Envelope context accumulation (400K token rolling budget with oldest-first pruning). Per-agent generation parameters from agent-registry.json. Memory recall/write. Multi-step plans with retry. Delegation. Semantic failure detection. Responsibility scheduler (cron-driven, auto R→M envelopes). Quick ack.
- **Tool ownership boundaries:**
  - Motor owns ALL Google Workspace tools (Drive, Gmail, Sheets, Docs, Calendar) + advisory mode
  - temporal-memory is pure memory (core-memory-read/write only, zero external APIs)
  - cerebellum is a pure test runner: executes validation rules, reports PASS/FAIL with evidence, structured verdicts (ALL_PASS/FAIL/NO_RULES)
- **Dynamic skill awareness**: `assemble-tools` generates TOOLS.md from agent type's skill list, copies to cortex + prefrontal + motor workspaces
- **Responsibility self-management**: Agents create responsibilities through normal M→C→T pipeline. `responsibility-manage` Motor tool for CRUD on `responsibilities-job.json`. Cortex classifies responsibility requests as new_mission → Prefrontal designs process → Motor writes config → Cerebellum verifies. Brain scheduler fires responsibilities on cron schedules.
- **Context assembly**: System prompt loads SOUL.md + IDENTITY.md + MEMORY.md + full agent registry (cached, 60s TTL). Per-agent generation params: Motor 65536 max_tokens, Cortex/Prefrontal 32768, Cerebellum/Memory 8192. Temperature tuned per role (0.1–0.6). Envelope context accumulation: rolling 400K token budget with oldest-first pruning.
- **Input/Output architecture (ears + mouth)**:
  - `agent-ears.mjs` — 100% deterministic input (poll, dedup, rate-limit, fire-and-forget gateway POST)
  - `agent-mouth.mjs` — 1 LLM call (classify+format) + deterministic delivery
  - Legacy `message-daemon.mjs` and `channel-respond` have been deleted from codebase

### Fleet VM Architecture
- Single OpenClaw agent per VM with specialty-specific workspace (identity fragment + shared SOUL_PROTOCOL.md composed at bootstrap) + brain sub-agents
- Same `agent-ears.mjs` + `agent-mouth.mjs` as Prime (CHANNEL=gchat) — built-in DWD, fire-and-forget input, strict LLM output classification
- CoreKit tools shared with Prime via manifest system

### I/O Architecture (Ears + Mouth)
- Ears polls channel (Firestore or GChat), deduplicates, repairs Chat-mangled text via Gemini Flash preprocessor, writes TASK.json, fires gateway POST (non-blocking)
- **GChat context window**: when @mention detected, ears includes prior N messages (default 5) from the space as `[Chat messages since your last reply - for context]` preamble with sender names
- Mouth v2 tails JSONL session transcript (`~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`) — structurally detects final responses vs intermediate tool output
- Turn state machine: IDLE → WORKING → ACKED → UPDATED → DONE
- Status updates: LLM-voiced ack at 5s, progress at 120s (deterministic fallback if LLM fails)
- LLM classify via Gemini Flash in JSON mode: `{"action": "deliver"|"suppress", "text": "..."}`
- Prompts loaded from external `.md` files (`mouth-classify-prompt.md`, `mouth-status-prompts.md`)
- Mouth also runs independent Brain v3 envelope poll (5s interval) — primary query on `delivery_status=pending`, fallback to 3-status query for migration
- `channel-respond` has been removed — OpenClaw agents never call delivery tools directly
- Ears and mouth are fully independent systemd services — crash/restart of one doesn't affect the other
- **Dashboard**: 17-page breadcrumb-navigated hierarchy (no sidebar). Home → Prime Hub → Chat/Fleet/Work/Projects/Models/Settings → Agent Hub → Chat/Work/Brain/Skills/Settings. Real-time M→C→T work tree, envelope detail view, human-in-the-loop response form for needs_input envelopes. Projects as first-class Firestore entity with real-time listeners. 1health design system (Graphite/Charcoal/Teal/Aqua). Skill Kit Library (11 kits).

### Identity Lockdown
- `.identity-lock` file (chmod 444) written at bootstrap/upgrade with the agent's Workspace email
- `dwd-token` refuses to impersonate any email that doesn't match the lockfile
- `{{AGENT_USER_EMAIL}}` injected into IDENTITY.md templates at bootstrap/upgrade
- Task lifecycle records include agent email for full audit trail

### Agent State System (STATUS.json)
- `agent-status` tool reads/writes `workspace/STATUS.json` with current activity
- States: `idle → classifying → idle` (primary turn lifecycle via internal hooks)
- PreTurn hook sets `classifying`, PostTurn hook resets to `idle`
- Full cognitive execution state (claimed, active, waiting, complete, failed, needs_input) is managed dynamically by the `agent-brain` orchestrator daemon inside the Firestore `work` envelopes collection.

## Repository Structure
```
app/              Cloud Run dashboard (Next.js, 17 pages, 1health design system)
infra/            Bootstrap scripts, manifests, contracts.json
corekit/          Runtime tools installed on VMs (brain, fleet, gateway, chat, dashboard, memory)
brain/            Agent workspace files (SOUL.md, IDENTITY.md, TOOLS.md, MEMORY.md)
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
