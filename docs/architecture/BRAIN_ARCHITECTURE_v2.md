# Brain Architecture v2 — Prefrontal Gate + Ears/Mouth

> **The One Rule:** LLMs think. Deterministic systems move data, enforce rules, and deliver output.

## Deterministic vs. LLM Boundary Map

| Component | Deterministic | LLM | Why |
|---|---|---|---|
| **Ears** (input) | Polling, parsing, dedup, rate-limit, delivery | _(nothing)_ | Input processing is pure data movement |
| **Prefrontal gate** | Pipeline invariant validation | Intent classification, dispatch planning | Understanding intent requires language |
| **brain-exec** | Pipeline orchestration, sequencing, timeout, retry | _(nothing)_ | Executing a plan is following instructions |
| **Sub-agents** | _(nothing)_ | All cognitive work | This is where LLMs belong — thinking |
| **Cortex** | _(nothing)_ | Synthesis of sub-agent outputs | Combining expert outputs requires language |
| **Mouth** (output) | @-mention regex, [ESCALATE] detection, delivery, logging | Internal-vs-external classification, formatting | Deciding "is this for the user" requires understanding |

## LLM Call Budget Per User Interaction

| # | Call | Model | When |
|---|------|-------|------|
| 1 | temporal-memory (recall) | gemini-2.5-flash | Every message (automatic) |
| 2 | prefrontal (dispatch plan) | gemini-2.5-flash | Every message (automatic) |
| 3-6 | Sub-agents (0-4 calls) | gemini-2.5-flash/pro | Per prefrontal's plan |
| 7 | Cortex (synthesis) | gemini-3.1-pro-preview | Every message |
| 8 | Mouth (classify + format) | gemini-2.5-flash | Every output |

**Total: 4-8 LLM calls per interaction.**

## Architecture

```
┌──────────────────────────────────────────────┐
│  THE EARS (agent-ears.mjs)                    │
│  systemd: agent-ears.service                  │
│  100% deterministic — zero LLM calls          │
│                                               │
│  Inputs:                                      │
│  ├── Firestore poll (dashboard messages)      │
│  ├── Google Chat DWD poll                     │
│  ├── @-mention routes from other agents       │
│  └── Schedule/responsibility cron triggers    │
│                                               │
│  Output:                                      │
│  └── POST to OpenClaw gateway (HTTP)          │
└──────────────────────────┬───────────────────┘
                           │
                    OpenClaw Gateway
                   (Cortex session)
                           │
┌──────────────────────────┴───────────────────┐
│  THE MOUTH (agent-mouth.mjs)                  │
│  systemd: agent-mouth.service                 │
│  1 LLM call (classify+format) + deterministic │
│                                               │
│  Input:                                       │
│  └── Poll gateway session for new output      │
│                                               │
│  Output (all deterministic):                  │
│  ├── Deliver to dashboard (Firestore write)   │
│  ├── Deliver to Google Chat (DWD HTTP)        │
│  ├── Route @mentions to agents (DWD send)     │
│  └── Write escalation flag (Firestore)        │
└──────────────────────────────────────────────┘
```

## Tool Assignment

| Brain Agent | Workspace Tools | Rationale |
|---|---|---|
| temporal-memory | _(none)_ | Pure memory: memory_search, core-memory-read/write only |
| motor | All workspace tools (27) | Motor has exec permission, handles all external action |
| cerebellum | docs-comments-* (4) | Doc review IS verification |

## Prefrontal Dispatch Plan Format

```
DISPATCH_PLAN:
intent: build
reasoning: User wants a Terraform module. Requires execution with verification.
pipeline: [motor, cerebellum]
parallel: []
short_circuit: false
approval_needed: false
motor_mode: build
context_summary: User is working on deploy-api mission.
```

## Pipeline Patterns

- Simple question (answerable from memory): `short_circuit: true, pipeline: []`
- Research question: `pipeline: [temporal-research, cerebellum]`
- Build/create request: `pipeline: [motor, cerebellum]`
- Research then build: `pipeline: [temporal-research, motor, cerebellum]`
- Read from Workspace: `pipeline: [motor]`
- Write to Workspace: `pipeline: [motor, cerebellum]`
