# Architect Prime — Project Context

## What this project is
Architect Prime is an AI agent fleet management system for Google Workspace on GCP. It deploys autonomous AI agent teams (each with its own VM, OpenClaw AI brain, and Google Chat identity) that collaborate with humans via Google Chat.

## Current Architecture (v2026.06.04.3.0)

### System Stack
- **Cloud Run** — Next.js dashboard (17-page breadcrumb-navigated hierarchy, 1health design system) + REST API (control plane)
- **Firestore** — State: primes, fleet, messages, tasks, dispatch-log, introspect queries, config
- **Compute Engine VMs** — One per Prime + one per fleet agent
- **OpenClaw** — AI brain on each VM (v2026.4.15, Gemini 3.1 Pro via Vertex AI ADC)
- **Google Chat** — Agent-to-human communication via DWD

### Prime VM Architecture
- **6-agent brain**: cortex (plan executor) + 5 sub-agents (temporal-research, temporal-memory, prefrontal, motor, cerebellum)
- **Brain v3 (agent-brain.mjs)**: Deterministic envelope-based orchestration daemon running as a continuous systemd service. Polls Firestore intake → Cortex classify → Cortex decide loop → dispatches to sub-agents → synthesize. R/M/C/T hierarchy (Responsibilities → Missions → Checkpoints → Tasks). Rich context assembly: SOUL.md + IDENTITY.md + MEMORY.md + full agent registry in system prompt (~20K tokens). Envelope context accumulation (400K token rolling budget with oldest-first pruning). Per-agent generation parameters from agent-registry.json. Memory recall/write. Multi-step plans with retry. Delegation. Semantic failure detection. Responsibility scheduler (cron-driven, auto R→M envelopes). Contextual ack with recent mission history + project awareness. Motor timeout detection (`timed_out` status) with cortex `continue` action for re-dispatching timed-out tasks. Process step type dispatch (standard/delegation/spawn_responsibility/approval_gate/optional). Approval gate polling and resume. Responsibility→process linking via processRef (auto-execute, skip Cortex decide).
- **Prime role: infrastructure only** — fleet management (hire/fire/upgrade/monitor), visibility, delegation. ZERO Google Workspace tools. Prime's skills will be progressively exposed through the dashboard for manual triggering.
- **Tool ownership boundaries:**
  - Prime Motor has fleet lifecycle tools only (fleet-deploy, fleet-hire, fleet-fire, fleet-status, fleet-upgrade, fleet-verify)
  - Fleet Motor owns Google Workspace tools per job type: devops (Drive+Gmail), pm (Drive+Gmail+Docs+Sheets), assistant (Drive+Gmail+Calendar+Docs), etc.
  - temporal-research is web search + URL fetching (Vertex AI grounding + web-fetch, zero execution tools)
  - temporal-memory is pure memory (core-memory-read/write only, zero external APIs)
  - cerebellum is a pure test runner: executes validation rules, reports PASS/FAIL with evidence, structured verdicts (ALL_PASS/FAIL/NO_RULES)
- **Dynamic skill awareness**: `assemble-tools` generates per-agent TOOLS.md from `skill.json` manifests (routes by `agent_part` field). Execution agents get full SKILL.md content; planning agents get compact index tables. `skill-author` Motor tool for generating new skill packages. Custom skills synced from Firestore during `upgrade-corekit`. Prime runs nightly `r-skill-discovery` responsibility to propose new skills (uses `work-log-read`, `brain-telemetry-read`, `session-summary` for data gathering). Dashboard 3-tab skills page (Installed/Library/Proposals) with per-agent install/uninstall.
- **Processes vs Skills design principle**: Processes are for **orchestration** (when to do things, in what order, with what approvals). Skills are for **execution** (how to do a specific thing correctly every time). Processes should reference skills for mechanical steps. Anti-pattern: a process that tells motor to improvise deterministic operations without a skill providing the exact script.
- **Responsibility self-management**: Agents create responsibilities through normal M→C→T pipeline. `responsibility-manage` Motor tool for CRUD + toggle on `responsibilities-job.json`. Individual responsibilities can be toggled enabled/disabled via dashboard toggle switch, `responsibility-manage toggle` Motor tool, or `set_responsibility_enabled` introspection query. Cortex classifies responsibility requests as new_mission → Prefrontal designs process → Motor writes config → Cerebellum verifies. Brain scheduler fires responsibilities on cron schedules. Responsibilities can link to stored processes via `processRef` + `processParams` for deterministic execution.
- **Context assembly**: System prompt loads SOUL.md + IDENTITY.md + MEMORY.md + full agent registry (cached, 60s TTL). Per-agent generation params: Motor 65536 max_tokens, Cortex/Prefrontal 32768, Cerebellum/Memory 8192. Temperature tuned per role (0.1–0.6). Envelope context accumulation: rolling 400K token budget with oldest-first pruning.
- **Input/Output architecture (ears + mouth)**:
  - `agent-ears.mjs` — 100% deterministic input (poll, dedup, rate-limit, fire-and-forget gateway POST)
  - `agent-mouth.mjs` — 1 LLM call (classify+format) + deterministic delivery
  - Legacy `message-daemon.mjs` and `channel-respond` have been deleted from codebase

### Fleet VM Architecture
- Single OpenClaw agent per VM with specialty-specific workspace (identity fragment + shared SOUL_PROTOCOL.md composed at bootstrap) + brain sub-agents
- Same `agent-ears.mjs` + `agent-mouth.mjs` + `agent-introspect.mjs` as Prime (CHANNEL=gchat) — built-in DWD, fire-and-forget input, strict LLM output classification
- Introspect daemon reads real VM filesystem (bin/, skills/, workspace/) and responds to Firestore queries from the dashboard
- CoreKit tools shared with Prime via manifest system

### I/O Architecture (Ears + Mouth)
- Ears polls channel (Firestore or GChat), deduplicates, repairs Chat-mangled text via Gemini Flash preprocessor, detects approval gate responses in GChat (intercepts approve/reject replies), writes TASK.json, fires gateway POST (non-blocking)
- **GChat context window**: when @mention detected, ears includes prior N messages (default 5) from the space as `[Chat messages since your last reply - for context]` preamble with sender names
- Mouth v2 tails JSONL session transcript (`~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`) — structurally detects final responses vs intermediate tool output
- Turn state machine: IDLE → WORKING → ACKED → UPDATED → DONE
- Status updates: LLM-voiced ack at 5s, progress at 120s (deterministic fallback if LLM fails)
- LLM classify via Gemini Flash in JSON mode: `{"action": "deliver"|"suppress", "text": "..."}`
- Prompts loaded from external `.md` files (`mouth-classify-prompt.md`, `mouth-status-prompts.md`)
- Mouth also runs independent Brain v3 envelope poll (5s interval) — primary query on `delivery_status=pending`, fallback to 3-status query for migration
- `channel-respond` has been removed — OpenClaw agents never call delivery tools directly
- Ears and mouth are fully independent systemd services — crash/restart of one doesn't affect the other
- **Dashboard**: Living Agent Graph home screen — interactive network topology with prime chip selector (deploy chip as last inline element), SVG connection lines + pulse dots, glassmorphic agent cards with text nav labels (Work/Brain/Skills, unified for Prime and Fleet). Floating glassmorphic chat overlay (slide-in from right, resize handle 320-800px, X close button, specialty badge inline next to agent name) replaces old split-panel layout. +Hire card in fleet grid with dynamic specialty picker (fetches agent-types.json from GitHub, 5m cache). Shell header: logo + stacked title/version (version clickable → Settings System tab, sits below "Architect Prime") left-aligned with breadcrumb trail (Home as first clickable crumb). 17-page breadcrumb-navigated hierarchy (no sidebar). Home → Prime Hub → Chat/Fleet/Work/Brain/Skills/Settings → Agent Hub → Chat/Work/Brain/Skills/Settings. Brain page: 6-slot LLM grid with click-to-swap model picker. Model discovery moved to global Settings → Models tab. Skills page queries real VM filesystem via Firestore bus introspection API. Real-time M→C→T work tree, envelope detail view, human-in-the-loop response form for needs_input envelopes. Real-time Cloud Build status polling (regional API for step-level progress) for dashboard upgrades. 1health design system (Graphite/Charcoal/Teal/Aqua). Shared FleetSelector component (`useFleetSelection` hook + `FleetSelector` two-tier chip UI + `FleetEmptyPrompt`) provides consistent chip-based prime/agent selection with URL deep linking (`?prime=xxx&agent=yyy`) across all 5 top-level pages (Projects, Processes, Work, Brain, Skills). No auto-select — user must click a prime chip.

### Skills / Body-Part Categorization
The Skills page categorizes tools by agent "body part". The introspect daemon (`agent-introspect.mjs`) assigns categories by filename pattern. When adding new tools, follow the naming conventions below so they auto-categorize correctly:

| Body Part | Icon | Pattern | What goes here |
|-----------|------|---------|----------------|
| **Ears** | 👂 | `agent-ears*`, `ears-*`, `chat-*`, `dwd-token`, `ws-token` | Input pipeline, polling, DWD auth, chat I/O |
| **Mouth** | 🗣️ | `agent-mouth*`, `mouth-*` | Output pipeline, response classification, delivery |
| **Brain** | 🧠 | `agent-brain*`, `brain-telemetry-*`, `assemble-tools`, `agent-introspect*` | Orchestration daemon, telemetry, tool assembly |
| **Cortex** | 🔮 | `agent-ask`, `agent-status` | Decision layer — reasoning tools the cortex agent uses |
| **Motor** | ⚡ | `responsibility-manage`, `project-manage`, `task-log-*`, `fleet-*`, `work-log-read`, `drive-*`, `gmail-*`, `calendar-*`, `docs-*`, `sheets-*` | Execution layer — all tools Motor uses to DO things |
| **Memory** | 💾 | `core-memory-*`, `update-deep-truths`, `session-summary` | Temporal-memory tools |
| **Config** | ⚙️ | `upgrade-*`, `validate-contracts`, `render-config`, `oc`, `*.md`, `*.json`, `*.tmpl` | System config & base functions: OpenClaw/fleet infra |
| **Custom** | 🧩 | *(anything not matched above)* | Fallback for uncategorized / user-added tools |

Source of truth: categorization logic in `corekit/daemon/agent-introspect.mjs`, labels in `app/src/app/p/[id]/a/[agent]/skills/page.tsx`.

### Workspace Skill Manifests
Workspace tools (Google Drive/Gmail/Calendar/Docs/Sheets) are installed per job type, NOT globally. Manifest layering: `base.txt` → `role-{fleet|prime}.txt` → `job-{type}.txt`. Prime has ZERO workspace skills.

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
