# Skill Architecture — Architect Prime

> **Status:** DEPRECATED — Superseded by the Architecture section in `MISSION_PLAN.md`.
> **Last verified:** v2026.05.03.11.0
>
> This document uses pre-v5.0 `bundle/` paths throughout the body and has not been updated.
> For the canonical skill/workspace/CoreKit architecture, see `MISSION_PLAN.md → Architecture`.
> This file is retained for historical reference only.

---

## Core Concepts

### Skill
A **skill** is a self-contained capability. Each skill lives in its own directory under `bundle/skills/<name>/` and contains:

| File | Purpose |
|------|---------|
| `SKILL.md` | **Self-describing manifest.** Tells the LLM what this skill does, when to use it, the exact command syntax, and any post-action instructions. This is concatenated into the system prompt automatically. |
| `bin/<script>` | The executable script (installed to `~/.openclaw/bin/`) |

A skill must be:
- **Thin** — do one thing well
- **Fast-returning** — async operations write to a command queue and return immediately
- **Self-contained** — no inner LLM calls, no state management
- **Self-describing** — SKILL.md contains everything the agent needs to know

### Identity
An **identity** is the combination of workspace files that define an agent's personality, knowledge, and behavioral constraints:

| File | Purpose |
|------|---------:|
| `SOUL.md` | Core personality, behavioral rules, decision-making style. **No skill-specific instructions.** |
| `IDENTITY.md` | Name, role, specialty description |
| `MEMORY.md` | Persistent knowledge across sessions |
| `USER.md` | Who the agent serves |

> **Design rule:** SOUL.md is about WHO the agent is. Skills are about WHAT the agent can do. Never mix them.

### CoreKit
A **CoreKit** is the complete package for an agent type: **identity + skills**. Each agent type (Prime, DevOps, PM, etc.) has a distinct CoreKit that determines what the agent knows and what it can do.

```
CoreKit = Identity (workspace files) + Skills (SKILL.md + scripts)
```

---

## System Prompt Assembly

`build-system-prompt` assembles the system prompt automatically:

```
1. Read SOUL.md          → "Who I am"
2. Read IDENTITY.md      → "My name and role"
3. Read MEMORY.md        → "What I remember"
4. Look up agent type    → agent-types.json → skills list
5. For each skill:
   Read SKILL.md         → "What I can do and how"
6. Append general        → Response style, boundaries
   instructions
```

This replaces the old `TOOLS.md` approach. Skills are now self-describing — when you add a skill to an agent type, its documentation is automatically included in the system prompt.

### Directory layout on VM

```
~/.openclaw/
├── workspace/               # Identity files (SOUL.md, IDENTITY.md, etc.)
├── skills/                  # Self-describing skill manifests
│   ├── agent-ask/SKILL.md
│   ├── fleet-hire/SKILL.md
│   ├── fleet-fire/SKILL.md
│   ├── fleet-status/SKILL.md
│   ├── fleet-verify/SKILL.md
│   └── fleet-upgrade/SKILL.md
├── bin/                     # Executable scripts (on PATH via exec)
│   ├── agent-ask
│   ├── fleet-hire
│   ├── fleet-fire
│   └── ...
└── corekit/
    └── agent-types.json     # Maps agent types → skill lists
```

---

## Fundamental Skills

### `agent-ask` — Conversational Intelligence
**Every agent gets this.** This is the most fundamental skill in the platform.

`agent-ask` provides:
- System prompt assembly from workspace files (SOUL, MEMORY, IDENTITY)
- Vertex AI Gemini call with Google Search grounding
- Real-time conversational ability with users and other agents

`agent-ask` is **read-only** — it answers questions, explains concepts, and provides guidance. It does NOT perform infrastructure operations, write to databases, or modify state.

> **Design rule:** If an agent can't converse with a human, it's not an agent — it's a cron job. `agent-ask` is what makes agents *agents*.

### OpenClaw Gateway
All agents run an OpenClaw gateway container that provides:
- Agent loop (Gemini 2.5 Flash)
- Session memory and context management
- `exec` tool for invoking skills
- `/v1/chat/completions` API for message routing

The OpenClaw agent reads workspace files and decides which skill to use via `exec`. The agent IS the orchestrator — skills are its hands.

---

## Agent Types

### Prime
**Role:** Agent factory — creates, upgrades, monitors, and tears down fleet agents.

**Identity:** `bundle/workspaces/main/`
**Skills:**
| Skill | Script | Type | Description |
|-------|--------|------|-------------|
| agent-ask | `agent-ask` | read-only | Conversational Q&A with Google Search |
| fleet-hire | `fleet-hire` | async/queue | Hire a new fleet agent |
| fleet-fire | `fleet-fire` | async/queue | Decommission a fleet agent |
| fleet-upgrade | `fleet-upgrade` | async/queue | Upgrade a fleet agent's CoreKit |
| fleet-status | `fleet-status` | read-only | Check fleet health and deploy progress |
| fleet-verify | `fleet-verify` | read-only | Ping a fleet agent to verify it's alive |

### DevOps (`devops`)
**Role:** GCP operations, deploys, IAM/API enablement, reliability.

**Identity:** `bundle/workspaces/devops/`
**Skills:**
| Skill | Script | Type | Description |
|-------|--------|------|-------------|
| agent-ask | `agent-ask` | read-only | Conversational Q&A with Google Search |

**Future skills:** GCP CLI, Terraform, monitoring dashboards

### PM (`pm`)
**Role:** Project management, planning, coordination.

**Identity:** `bundle/workspaces/fleet/` (generic fleet identity)
**Skills:**
| Skill | Script | Type | Description |
|-------|--------|------|-------------|
| agent-ask | `agent-ask` | read-only | Conversational Q&A with Google Search |

**Future skills:** Google Workspace (Docs, Sheets, Calendar), Jira/Linear integration

### SWE (`swe`)
**Role:** Software engineering, code review, implementation.

**Identity:** `bundle/workspaces/engineer/`
**Skills:**
| Skill | Script | Type | Description |
|-------|--------|------|-------------|
| agent-ask | `agent-ask` | read-only | Conversational Q&A with Google Search |

**Future skills:** GitHub API, code analysis tools, test runners

---

## Skill Types

### Read-Only Skills
Instant, synchronous. Agent calls via `exec`, gets result, includes in response.
- `agent-ask` — Q&A
- `fleet-status` — reads Firestore
- `fleet-verify` — pings a VM

### Async/Queue Skills
Write to Firestore command queue and return immediately. The `command-runner` daemon on the host OS picks up and executes the heavy operation.
- `fleet-hire` → queues `fleet_deploy`
- `fleet-fire` → queues `fleet_teardown`
- `fleet-upgrade` → queues `fleet_upgrade`

```
agent exec fleet-hire → writes to commands/ → returns "Deploying..."
                                    ↓
                            command-runner (host)
                                    ↓
                            fleet-deploy (3-5 min)
```

### Future: MCP Skills
When agents need to interact with external APIs (Google Workspace, GitHub), skills will be implemented as MCP (Model Context Protocol) servers that OpenClaw connects to natively.

---

## Adding a New Skill

1. **Create the skill directory:** `bundle/skills/<skill-name>/`
2. **Write `SKILL.md`** — describe what the skill does, when to use it, command syntax, and post-action instructions
3. **Create the script** in `bundle/corekit/bin/<script-name>`
   - Read-only? Return result to stdout
   - Async? Write to `primes/{id}/commands/` and return confirmation
4. **Add to `manifest.txt`** — both the SKILL.md and the script
5. **Add to `agent-types.json`** — add the skill name to the `skills` array for each agent type that should have it
6. **Test** — verify the OpenClaw agent calls it via exec when appropriate
7. **Document** — add to this file's agent type skill table

## Adding a New Agent Type

1. **Create identity workspace** in `bundle/workspaces/<type>/`
   - At minimum: SOUL.md, IDENTITY.md
   - SOUL.md is pure identity — no skill instructions
2. **Register in `agent-types.json`** — add type with `skills` array
3. **Update `fleet-deploy`** — ensure bootstrap overlays correct workspace
4. **Document** — add to this file's Agent Types section

---

## Principles

1. **OpenClaw is the brain** — it decides which skill to use. Skills don't make decisions.
2. **agent-ask is universal** — every agent can converse. No exceptions.
3. **Skills are self-describing** — each skill carries its own SKILL.md with triggers, syntax, and post-action instructions.
4. **SOUL.md is pure identity** — personality, boundaries, decision style. Never skill instructions.
5. **Heavy work goes to the queue** — agents never block on long operations.
6. **Identity is in workspace files** — not in code. Easy to update, version, and customize.
7. **Fleet agents are lean** — they get identity + agent-ask. Skills are added intentionally.
8. **System prompt is auto-assembled** — `build-system-prompt` reads identity + skill manifests. No manual TOOLS.md maintenance.
