# Skill Architecture — Architect Prime

> **Living document.** Defines how agent skills are composed, packaged, and assigned to agent types.

---

## Core Concepts

### Skill
A **skill** is a self-contained capability that an agent can use. Skills are implemented as executable scripts in `~/.openclaw/bin/` and invoked by the OpenClaw agent via the `exec` tool.

A skill must be:
- **Thin** — do one thing well
- **Fast-returning** — async operations write to a command queue and return immediately
- **Self-contained** — no inner LLM calls, no state management
- **Documented** — described in the agent's `TOOLS.md` so the LLM knows when and how to use it

### Identity
An **identity** is the combination of workspace files that define an agent's personality, knowledge, and behavioral constraints:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality, behavioral rules, decision-making style |
| `IDENTITY.md` | Name, role, specialty description |
| `MEMORY.md` | Persistent knowledge across sessions |
| `TOOLS.md` | Available skills and how to invoke them |
| `USER.md` | Who the agent serves |

### CoreKit
A **CoreKit** is the complete package for an agent type: **identity + skills**. Each agent type (Prime, DevOps, PM, etc.) has a distinct CoreKit that determines what the agent knows and what it can do.

```
CoreKit = Identity (workspace files) + Skills (exec scripts)
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

1. **Create the script** in `bundle/corekit/bin/`
   - Read-only? Return result to stdout
   - Async? Write to `primes/{id}/commands/` and return confirmation
2. **Add to manifest.txt** — maps repo path to VM install path
3. **Update TOOLS.md** for the agent type(s) that should use it
4. **Test** — verify the OpenClaw agent calls it via exec when appropriate
5. **Document** — add to this file's agent type skill table

## Adding a New Agent Type

1. **Create identity workspace** in `bundle/workspaces/<type>/`
   - At minimum: SOUL.md, IDENTITY.md, TOOLS.md
2. **Define CoreKit** — list skills in the type's TOOLS.md
3. **Add to `agent-types.json`** — register the type with metadata
4. **Update `fleet-deploy`** — ensure bootstrap overlays correct workspace
5. **Document** — add to this file's Agent Types section

---

## Principles

1. **OpenClaw is the brain** — it decides which skill to use. Skills don't make decisions.
2. **agent-ask is universal** — every agent can converse. No exceptions.
3. **Skills are scripts** — simple, testable, deployable via manifest.
4. **Heavy work goes to the queue** — agents never block on long operations.
5. **Identity is in workspace files** — not in code. Easy to update, version, and customize.
6. **Fleet agents are lean** — they get identity + agent-ask. Skills are added intentionally.
