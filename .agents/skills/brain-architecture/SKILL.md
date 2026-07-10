---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-registry.json, modifying bootstrap config agent definitions, or neural gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v2026.07.10.8.0)
6 brain agents in gateway multi-agent configuration, coordinated by the `agent-brain.service` state machine. Brain daemon builds `skill_index` deterministically at startup and injects into cortex payloads with `intent_keywords` for process selection. System prompt = SOUL.md only (no TOOLS.md injection). `assemble-persona` handles specialty SOUL appends at bootstrap and during `upgrade-corekit`. Motor dispatches receive full project context (`_projectContext`) and raw user request (`_sourceText`) as first-class user message sections. LoopGuard provides duplicate detection, semantic stuck detection, and structured `[STUCK REPORT]` output. Cross-agent delegation flows through checkpoint-executor with a 4-layer self-delegation prevention system: prefrontal SOUL specialty ownership detection, cortex SOUL delegation rules, inbound delegation rules, and a code-level checkpoint-executor guard that converts self-delegations to local motor tasks. Delegation dispatches via GChat @-mention with machine-parseable envelope references. Parallel delegation fan-out within a single checkpoint. Product Architect and PM agents are delegation-first (delegate before executing). Designer motor has mandatory step-by-step HTML writeFile enforcement. **Prime Unbound**: Prime is a creative system operator with `system-shell`, `gcp-admin`, and `scripting` skills, mandated to solve problems resourcefully using native tools. **Wait Capability**: All agents can invoke `wait` to pause missions for a duration; the daemon detects expired timers and resumes from the last state. **Harness Horizon**: transitions fleet agent messaging exclusively to Google Chat, retires all dashboard write paths with 405/read-only panel migrations, streamlines chronological thread assembly, establishes safe tool-verified conversational response gates (10s whitelisted REST reads timeout racing), implements tone-continuity conversation voicing context tracking (1500-char tail slice), directs all chat session triage through standard nightly memory consolidation, and visualizes deepest active descendant tasks dynamically inside the presence dashboard ribbon.

### Agent Inventory

| Agent | Model | Role | Workspace |
|-------|-------|------|-----------|
| **cortex** | gemini-3.1-pro-preview | JSON Decide Loop — envelope coordinator (DEFAULT) | `/opt/corekit/workspace` |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `/opt/corekit/workspace-temporal-research` |
| **temporal-memory** | gemini-2.5-flash | Pure memory/context recall (NO external APIs) | `/opt/corekit/workspace-temporal-memory` |
| **prefrontal** | gemini-2.5-flash | Planning + dispatch (two-mode: simple + advisory) | `/opt/corekit/workspace-prefrontal` |
| **motor** | gemini-2.5-flash | Execution — ALL Google Workspace tools + advisory mode | `/opt/corekit/workspace-motor` |
| **cerebellum** | gemini-2.5-flash | Verification + validation-rule checking | `/opt/corekit/workspace-cerebellum` |

### Dispatch Pattern
- **Brain v3 state machine (`agent-brain.mjs`)**: Manages deterministic, envelope-based coordination as a continuous service.
- **Cortex JSON Decide Loop**: Cortex classifies inputs and makes structured decisions (`action: "classify"|"decide"|"short_circuit"|"dispatch"|"synthesize"`). 10-case response normalizer infers actions from fields present (e.g., `intent:"synthesize"` → synthesize, `blocker` → blocked, `result` → synthesize fallback).
- **R/M/C/T Hierarchy**: Work is managed as nested envelopes of Responsibilities (cron scheduled, individually toggleable), Missions, Checkpoints, and Tasks.
- **Sub-agent Dispatch**: Sub-agents are invoked dynamically by Cortex to execute planned steps.

### Outcome Integrity
Contract-driven guarantees that dispatch and completion produce verifiable results:
- **smartTruncate**: Content truncation follows a field-priority contract (`result` → `summary` → `notes`), never silently drops outcome data.
- **Mission record persistence**: `completeEnvelope` Step 3a writes a durable mission record to Firestore before marking the envelope complete.
- **Delegation trailer grammar**: Delegation dispatches append a machine-parseable trailer (envelope ref, expected output, return address) so the receiving agent can satisfy the contract.
- **Completion verification**: `synthesize` verifies that every dispatched checkpoint has a recorded outcome before composing the final response.
- **GOAL STATE + goal_check**: Prefrontal plans include an explicit `GOAL STATE` block; cortex runs a `goal_check` pass before synthesize to confirm the goal was met.

### I/O Architecture
- `agent-ears` — deterministic input (poll, dedup, GChat preprocessor, fire-and-forget gateway POST)
- `agent-mouth` — output classification + delivery (JSONL-native transcript tailer, turn state machine, LLM status updates)
- Agents never call delivery tools directly; `agent-mouth` polls for `delivery_status=pending` envelopes (fallback to 3-status query)

## Key Files
- `corekit/config/chat-config.json.tmpl` — Chat adapter config template
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

## Gateway Integration Points
- Gateway API: `POST http://localhost:18789/v1/chat/completions` with `model: "brain"` or `model: "brain/<agentId>"`
- `agent-ears` bridges input channels → neural gateway (fire-and-forget POST)
- `agent-mouth` bridges gateway output → delivery channel (GChat or Firestore)
- Fleet tools (`fleet-deploy`, etc.) available via VM execution on PATH
