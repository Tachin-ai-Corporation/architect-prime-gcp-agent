---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-types.json, modifying bootstrap config agent definitions, or OpenClaw gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v2026.05.18.16.0)
6 brain agents in OpenClaw multi-agent configuration. Prefrontal-first gate enforced.

### Agent Inventory

| Agent | Model | Role | Workspace |
|-------|-------|------|-----------|
| **cortex** | gemini-3.1-pro-preview | Plan executor + synthesizer (DEFAULT) | `~/.openclaw/workspace` |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `~/.openclaw/workspace-temporal-research` |
| **temporal-memory** | gemini-2.5-flash | Pure memory/context recall (NO external APIs) | `~/.openclaw/workspace-temporal-memory` |
| **prefrontal** | gemini-2.5-flash | Planning + dispatch (two-mode: simple + advisory) | `~/.openclaw/workspace-prefrontal` |
| **motor** | gemini-2.5-flash | Execution — ALL Google Workspace tools + advisory mode | `~/.openclaw/workspace-motor` |
| **cerebellum** | gemini-2.5-flash | Verification + validation-rule checking | `~/.openclaw/workspace-cerebellum` |

### Dispatch Pattern
- Prefrontal-first gate: every message → spawn prefrontal → receive DISPATCH_PLAN
- Two modes: Simple (immediate plan) or Complex (PLANNING_ROUND_REQUIRED → advisory round)
- PLAN.md write gate: Cortex writes PLAN_VALID marker before executing any pipeline
- Validation rules: per-step criteria checked by cerebellum

### I/O Architecture
- `agent-ears` — deterministic input (poll, dedup, fire-and-forget gateway POST)
- `agent-mouth` — output classification + delivery (speaks AS the agent, first person)
- OpenClaw agents never call delivery tools directly

## Key Files
- `corekit/config/openclaw-bootstrap.json5.tmpl` — Prime OpenClaw config (6 agents)
- `corekit/config/openclaw-fleet-bootstrap.json5.tmpl` — Fleet agent OpenClaw config
- `corekit/config/agent-types.json` — Available agent specialties
- `brain/prime/cortex/` — Prime brain: plan executor + synthesizer
- `brain/prime/temporal-research/` — Prime brain: web search
- `brain/prime/temporal-memory/` — Prime brain: memory recall
- `brain/prime/prefrontal/` — Prime brain: planning + dispatch
- `brain/prime/motor/` — Prime brain: execution
- `brain/prime/cerebellum/` — Prime brain: verification
- `brain/fleet/_base/` — Fleet: generic template (fallback)
- `brain/fleet/_brain/` — Fleet: shared sub-agent workspaces
- `specialties/devops/` — Fleet: DevOps specialty workspace
- `specialties/engineer/` — Fleet: Engineer specialty workspace

## Memory System
- **Tier 1**: Session context (ephemeral, in OpenClaw)
- **Tier 2**: Working memory (MEMORY.md, updated during turns)
- **Tier 3**: Core Memory (Firestore `/primes/{id}/memory/core/`)
  - Scripts: `core-memory-read`, `core-memory-write`, `update-deep-truths`

## OpenClaw Integration Points
- Gateway API: `POST http://localhost:18789/v1/chat/completions` with `model: "openclaw"` or `model: "openclaw/<agentId>"`
- `agent-ears` bridges input channels → OpenClaw gateway (fire-and-forget POST)
- `agent-mouth` bridges gateway output → delivery channel (GChat or Firestore)
- Fleet tools (`fleet-deploy`, etc.) available via OpenClaw exec tool on PATH
