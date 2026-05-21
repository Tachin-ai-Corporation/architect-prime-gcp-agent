---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-types.json, modifying bootstrap config agent definitions, or OpenClaw gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v2026.05.22.1.0)
6 brain agents in OpenClaw multi-agent configuration, coordinated by the `agent-brain.service` state machine.

### Agent Inventory

| Agent | Model | Role | Workspace |
|-------|-------|------|-----------|
| **cortex** | gemini-3.1-pro-preview | JSON Decide Loop — envelope coordinator (DEFAULT) | `~/.openclaw/workspace` |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `~/.openclaw/workspace-temporal-research` |
| **temporal-memory** | gemini-2.5-flash | Pure memory/context recall (NO external APIs) | `~/.openclaw/workspace-temporal-memory` |
| **prefrontal** | gemini-2.5-flash | Planning + dispatch (two-mode: simple + advisory) | `~/.openclaw/workspace-prefrontal` |
| **motor** | gemini-2.5-flash | Execution — ALL Google Workspace tools + advisory mode | `~/.openclaw/workspace-motor` |
| **cerebellum** | gemini-2.5-flash | Verification + validation-rule checking | `~/.openclaw/workspace-cerebellum` |

### Dispatch Pattern
- **Brain v3 state machine (`agent-brain.mjs`)**: Manages deterministic, envelope-based coordination as a continuous service.
- **Cortex JSON Decide Loop**: Cortex classifies inputs and makes structured decisions (`action: "classify"|"decide"|"short_circuit"|"dispatch"|"synthesize"`).
- **R/M/C/T Hierarchy**: Work is managed as nested envelopes of Responsibilities (cron scheduled), Missions, Checkpoints, and Tasks.
- **Sub-agent Dispatch**: Sub-agents are invoked dynamically by Cortex to execute planned steps.

### I/O Architecture
- `agent-ears` — deterministic input (poll, dedup, GChat preprocessor, fire-and-forget gateway POST)
- `agent-mouth` — output classification + delivery (JSONL-native transcript tailer, turn state machine, LLM status updates)
- OpenClaw agents never call delivery tools directly; `agent-mouth` polls for completed/needs_input envelopes

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

## Memory System (Three-Layer Lifecycle)
- **Working Memory** (`MEMORY.md`): Agent RAM — accumulates during sessions, pruned nightly to <2,000 chars
- **Core Memory** (Firestore `core_memory` collection): Long-term durable facts. Actively pruned via `core-memory-retire`
  - Scripts: `core-memory-read` (supports `--since` time-windowed queries), `core-memory-write`, `core-memory-retire`
- **Deep Truths** (`SOUL.md` `## Deep Truths` section): Behavioral firmware, max 10 items. Changes only during nightly consolidation (3+ sessions, 7+ day evidence)
  - Script: `update-deep-truths`
- **Dual-pass recall**: temporal-memory does targeted archive search (all time) + broad recent scan (30 days) + context fill
- **Nightly consolidation**: 10-step `r-memory-consolidation` responsibility (gather → triage → reconcile → retire → promote → prune → Deep Truths → report)

## OpenClaw Integration Points
- Gateway API: `POST http://localhost:18789/v1/chat/completions` with `model: "openclaw"` or `model: "openclaw/<agentId>"`
- `agent-ears` bridges input channels → OpenClaw gateway (fire-and-forget POST)
- `agent-mouth` bridges gateway output → delivery channel (GChat or Firestore)
- Fleet tools (`fleet-deploy`, etc.) available via OpenClaw exec tool on PATH
