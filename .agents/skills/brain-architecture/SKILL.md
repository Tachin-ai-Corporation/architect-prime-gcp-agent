---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-registry.json, modifying bootstrap config agent definitions, or OpenClaw gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v2026.06.04.3.0)
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
- **Cortex JSON Decide Loop**: Cortex classifies inputs and makes structured decisions (`action: "classify"|"decide"|"short_circuit"|"dispatch"|"synthesize"`). 10-case response normalizer infers actions from fields present (e.g., `intent:"synthesize"` → synthesize, `blocker` → blocked, `result` → synthesize fallback).
- **R/M/C/T Hierarchy**: Work is managed as nested envelopes of Responsibilities (cron scheduled, individually toggleable), Missions, Checkpoints, and Tasks.
- **Sub-agent Dispatch**: Sub-agents are invoked dynamically by Cortex to execute planned steps.

### I/O Architecture
- `agent-ears` — deterministic input (poll, dedup, GChat preprocessor, fire-and-forget gateway POST)
- `agent-mouth` — output classification + delivery (JSONL-native transcript tailer, turn state machine, LLM status updates)
- OpenClaw agents never call delivery tools directly; `agent-mouth` polls for `delivery_status=pending` envelopes (fallback to 3-status query)

## Key Files
- `corekit/config/openclaw-bootstrap.json5.tmpl` — Prime OpenClaw config (6 agents)
- `corekit/config/openclaw-fleet-bootstrap.json5.tmpl` — Fleet agent OpenClaw config
- `corekit/config/agent-registry.json` — Per-agent settings (routes, models, intents, tools)
- `corekit/config/agent-types.json` — Available fleet agent specialties
- `brain/prime/cortex/` — Prime brain: plan executor + synthesizer
- `brain/prime/temporal-research/` — Prime brain: web search
- `brain/prime/temporal-memory/` — Prime brain: memory recall
- `brain/prime/prefrontal/` — Prime brain: planning + dispatch
- `brain/prime/motor/` — Prime brain: execution
- `brain/prime/cerebellum/` — Prime brain: verification
- `brain/fleet/_base/` — Fleet: generic template (fallback)
- `brain/fleet/_brain/` — Fleet: shared sub-agent workspaces
- `specialties/<type>/workspace/` — Fleet specialty workspaces (assistant, data, devops, engineer, finance, pm, qa, security)

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
