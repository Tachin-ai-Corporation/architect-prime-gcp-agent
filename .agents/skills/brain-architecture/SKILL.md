---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-types.json, modifying bootstrap config agent definitions, or OpenClaw gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v3.0)
5 brain agents in OpenClaw multi-agent configuration on Prime VM.

### Agent Inventory

| Agent | Model | Role | Workspace |
|-------|-------|------|-----------|
| **cortex** | gemini-2.5-flash | Router + synthesizer (DEFAULT) | `~/.openclaw/workspace` |
| **temporal** | gemini-2.5-flash | Memory + research (every turn) | `~/.openclaw/workspace-temporal` |
| **prefrontal** | gemini-2.5-pro | Strategic planning | `~/.openclaw/workspace-prefrontal` |
| **motor** | gemini-2.5-pro | Execution (code + commands) | `~/.openclaw/workspace-motor` |
| **cerebellum** | gemini-2.5-flash | Verification + QA | `~/.openclaw/workspace-cerebellum` |

### Dispatch Pattern
- Cortex dispatches sub-agents via `@agent` routing (OpenClaw native)
- Every message: cortex → @temporal for context recall
- Complex tasks: @prefrontal plans → @motor executes → @cerebellum verifies

## Key Files
- `bundle/corekit/config/openclaw-bootstrap.json5.tmpl` — Prime OpenClaw config (5 agents)
- `bundle/corekit/config/openclaw-fleet-bootstrap.json5.tmpl` — Fleet agent OpenClaw config
- `bundle/corekit/config/agent-types.json` — Available agent specialties
- `bundle/workspaces/cortex/` — Prime brain: router + synthesizer
- `bundle/workspaces/temporal/` — Prime brain: memory + research
- `bundle/workspaces/prefrontal/` — Prime brain: strategic planning
- `bundle/workspaces/motor/` — Prime brain: execution
- `bundle/workspaces/cerebellum/` — Prime brain: verification
- `bundle/workspaces/devops/` — Fleet: DevOps specialty
- `bundle/workspaces/engineer/` — Fleet: Engineer specialty
- `bundle/workspaces/fleet/` — Fleet: Generic template (fallback)

## Memory System
- **Tier 1**: Session context (ephemeral, in OpenClaw)
- **Tier 2**: Working memory (MEMORY.md + daily notes, memory_search)
- **Tier 3**: Core Memory (Firestore `/primes/{id}/memory/core/`)
  - Scripts: `core-memory-read`, `core-memory-write`
- **Tier 4**: Long-term Memory (Vertex AI Memory Bank — planned)

## OpenClaw Integration Points
- Gateway API: `POST http://localhost:18789/v1/chat/completions` with `model: "openclaw"` or `model: "openclaw/<agentId>"`
- `control-daemon` bridges Firestore → OpenClaw gateway (uses `model: "openclaw"` → routes to cortex default)
- `inbox-daemon` bridges Google Chat → OpenClaw gateway (fleet)
- Fleet tools (`fleet-deploy`, etc.) available via OpenClaw exec tool on PATH
