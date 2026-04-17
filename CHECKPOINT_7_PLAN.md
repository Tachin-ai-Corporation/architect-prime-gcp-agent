# Checkpoint 7 — Prime Brain + Memory Foundation

> **Status:** PLAN — For human review before implementation
> **Depends on:** v2.1.0 (Checkpoint 6 — fleet lifecycle stable)
> **Version target:** v3.0
> **Primary directive:** Make Prime smart and stateful enough to serve as the RSI engine

---

## Why This Checkpoint Exists

Prime today is a dispatcher. It translates "hire stan" into `exec fleet-hire`. It has no memory
across sessions beyond a flat `MEMORY.md` that bloats and truncates. It can't plan multi-step
work, can't verify its own output, and can't recall what it tried last week.

Before Prime can develop, test, and deploy improvements to fleet agents (and ultimately to itself),
it needs a brain that thinks in steps and a memory system that actually works. Everything in
Checkpoints 8–10 depends on this foundation.

---

## Part 1: Memory Architecture

### Design Principle

SOUL.md and IDENTITY.md are **immutable** — never modified by any agent or process.
MEMORY.md is **short-term working memory** — a small scratch pad, not a knowledge base.
Core knowledge lives in **Firestore** (structured, permanent, GCP-native).
Long-term experiential memory lives in **Vertex AI Memory Bank** (managed, semantic, GCP-native).
All retrieval runs through the **Temporal brain agent** as part of the standard Cortex workflow.

### The Four Memory Tiers

```
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 4: LONG-TERM MEMORY (Vertex AI Memory Bank)                   │
│                                                                     │
│  What: Experiential memory — patterns, lessons, project history     │
│  Store: Vertex AI Agent Engine Memory Bank (managed, GA)            │
│  Write: Hippocampus extracts from completed sessions (async)        │
│  Read: Temporal queries via similarity search per-turn              │
│  Lifespan: Months+. TTL-based expiry for stale entries.             │
│  Examples:                                                          │
│    "Fleet bootstrap fails if IAM propagation < 30s"                 │
│    "User prefers to review infra changes before applying"           │
│    "Last CoreKit upgrade broke fleet-monitor serial parsing"        │
│                                                                     │
│  GCP services: Vertex AI Agent Engine, Gemini (extraction model)    │
│  Auth: ADC (compute SA already has aiplatform.user)                 │
│  Cost: ~$0.03/1000 retrievals after free tier                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Hippocampus promotes
┌───────────────────────────┴─────────────────────────────────────────┐
│  TIER 3: CORE MEMORY (Firestore)                                    │
│                                                                     │
│  What: Durable facts, decisions, architectural knowledge            │
│  Store: Firestore /primes/{primeId}/memory/core/{entryId}          │
│  Write: Hippocampus promotes from MEMORY.md during reconciliation   │
│         Cortex can write directly for explicit "remember this"      │
│  Read: Temporal queries by category + tags (structured lookup)      │
│  Lifespan: Permanent. Never auto-expires. Human or agent can        │
│            mark entries superseded (never deleted).                  │
│  Examples:                                                          │
│    { fact: "OpenClaw is pinned to commit 163c6f5e",                 │
│      category: "architecture", tags: ["openclaw","versioning"],     │
│      confidence: 1.0, source: "MISSION_PLAN.md" }                  │
│    { fact: "DWD signer SA is shared across all fleet agents",       │
│      category: "iam", tags: ["dwd","fleet","service-account"],      │
│      confidence: 1.0, source: "checkpoint-5" }                     │
│                                                                     │
│  GCP services: Firestore (already in use)                           │
│  Auth: ADC (compute SA already has datastore.user)                  │
│  Cost: Firestore reads/writes (negligible at this scale)            │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Dreaming promotes
┌───────────────────────────┴─────────────────────────────────────────┐
│  TIER 2: WORKING MEMORY (MEMORY.md + daily notes)                   │
│                                                                     │
│  What: Current context, recent decisions, active work state         │
│  Store: Filesystem — MEMORY.md + memory/YYYY-MM-DD.md              │
│  Write: Agent writes during session. Pre-compaction flush auto-     │
│         saves before context window overflow.                       │
│  Read: Auto-loaded at session start (MEMORY.md + today + yesterday) │
│         memory_search for semantic recall across all daily notes     │
│  Lifespan: Days to weeks. Dreaming consolidates → Tier 3/4.        │
│  Size cap: MEMORY.md < 5KB enforced by Hippocampus pruning.        │
│                                                                     │
│  OpenClaw native: memory-core plugin, memory_search (hybrid),       │
│    memory_get, session-memory hook, pre-compaction flush             │
│  Embeddings: Gemini via Vertex AI ADC (text-embedding-005)          │
│  Index: SQLite at ~/.openclaw/memory/main.sqlite                    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ session writes
┌───────────────────────────┴─────────────────────────────────────────┐
│  TIER 1: SESSION CONTEXT (ephemeral)                                │
│                                                                     │
│  What: Active conversation in Gemini context window                 │
│  Store: In-memory (OpenClaw gateway process)                        │
│  Write: Every message exchange                                      │
│  Read: Implicit — it IS the context                                 │
│  Lifespan: Until compaction or session end                          │
│  Safety net: Pre-compaction flush saves to Tier 2 before loss       │
│                                                                     │
│  Already working. No changes needed.                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Firestore Core Memory Schema

```
Firestore: /primes/{primeId}/memory/core/{entryId}

{
  "id": "mem-20260417-001",
  "fact": "Fleet bootstrap takes ~15min on e2-medium with 50GB disk",
  "category": "operations",         // architecture | operations | iam | decisions | patterns | errors
  "tags": ["fleet", "bootstrap", "timing", "e2-medium"],
  "confidence": 0.9,                // 0.0-1.0, decays if contradicted
  "source": "observation",          // observation | user-stated | checkpoint-N | mission-N
  "sourceDetail": "Measured across 4 fleet deploys in April 2026",
  "supersedes": null,               // ID of entry this replaces (old entry kept, marked superseded)
  "supersededBy": null,             // ID of entry that replaced this one
  "createdAt": "2026-04-17T21:00:00Z",
  "lastRecalledAt": "2026-04-17T21:00:00Z",
  "recallCount": 0,
  "status": "active"                // active | superseded | archived
}
```

### Vertex AI Memory Bank Setup

Use the existing `openclaw-vertexai-memorybank` plugin, which integrates directly with
OpenClaw's memory tools. Setup:

1. Enable Vertex AI Agent Engine API in the project
2. Create an Agent Engine instance (no agent deployment needed — just the memory service)
3. Configure the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-vertexai-memorybank"],
    "entries": {
      "openclaw-vertexai-memorybank": {
        "enabled": true,
        "config": {
          "projectId": "${GCP_PROJECT_ID}",
          "location": "us-central1",
          "reasoningEngineId": "${AGENT_ENGINE_ID}"
        }
      }
    }
  }
}
```

This adds `memorybank_search` and `memorybank_store` tools alongside OpenClaw's native
`memory_search` and `memory_get`. The plugin handles extraction, dedup, and contradiction
resolution automatically via Gemini.

### memory_search Configuration (Gemini Embeddings via ADC)

Current config has `memorySearch: { enabled: true }` but no provider specified.
Since we use Vertex AI ADC (not API keys), configure explicitly:

```json
"memorySearch": {
  "enabled": true,
  "provider": "google",
  "model": "text-embedding-005",
  "remote": {},
  "sync": {
    "watch": true,
    "watchDebounceMs": 1500
  },
  "query": {
    "maxResults": 8,
    "hybrid": {
      "enabled": true,
      "vectorWeight": 0.7,
      "textWeight": 0.3,
      "candidateMultiplier": 4,
      "mmr": { "enabled": true, "lambda": 0.7 },
      "temporalDecay": { "enabled": true, "halfLifeDays": 30 }
    }
  }
}
```

**Open question:** Gemini embeddings via ADC may need the `models.providers.google.apiKey`
explicitly set, or may work through Vertex AI ADC passthrough. Need to test during
implementation. Fallback: use `GEMINI_API_KEY` env var sourced from GCP Secret Manager
at bootstrap time.

---

## Part 2: Brain Architecture (5 Sub-Agents)

### Agent Inventory

| # | Agent | Role | Model | Invoked By |
|---|-------|------|-------|------------|
| 0 | **Cortex** | Router + synthesizer. What the user talks to. | gemini-2.5-flash | User (via dashboard) |
| 1 | **Prefrontal** | Strategic planner. Decomposes complex tasks. | gemini-2.5-pro | Cortex |
| 2 | **Temporal** | Memory manager + researcher. Recall + web search. | gemini-2.5-flash | Cortex (every turn) |
| 3 | **Motor** | Executor. Writes code, runs commands, builds things. | gemini-2.5-pro | Cortex (per plan step) |
| 4 | **Cerebellum** | Verifier. QA checks outputs before delivery. | gemini-2.5-flash | Cortex (before responding) |

### Standard Brain Workflow (Every User Message)

```
User sends message via dashboard
    │
    ▼
CORTEX receives message
    │
    ├──→ TEMPORAL: "Recall context for this query"          ← ALWAYS, every turn
    │    │
    │    ├── memory_search (OpenClaw native, local SQLite)   ~50ms
    │    ├── Firestore Core Memory query (by category/tags)  ~30ms
    │    ├── memorybank_search (Vertex AI Memory Bank)       ~150ms
    │    │   (these three run in parallel)
    │    │
    │    └── Returns: unified context block, ranked by relevance
    │
    ├── Cortex classifies intent:
    │   │
    │   ├── SIMPLE QUESTION → Cortex answers directly using Temporal's context
    │   │
    │   ├── FLEET OPERATION → Cortex executes fleet-hire/fire/status/etc.
    │   │
    │   └── COMPLEX TASK → Route to Prefrontal:
    │       │
    │       ├──→ PREFRONTAL: "Plan this task"
    │       │    Input: user request + Temporal context
    │       │    Output: numbered step plan + acceptance criteria
    │       │    Plan stored in Firestore /brain/plans/{planId}
    │       │
    │       │    For each step in the plan:
    │       │    ├──→ MOTOR: "Execute step N"
    │       │    │    Input: step description + plan context
    │       │    │    Output: execution result
    │       │    │
    │       │    └──→ CEREBELLUM: "Verify step N output"
    │       │         Input: expected outcome + actual output
    │       │         Output: pass/fail + issues found
    │       │         If fail → Motor retries (max 2)
    │       │
    │       └── After all steps:
    │           └──→ CEREBELLUM: "Final verification"
    │                Input: original request + all step outputs
    │                Output: pass/fail + quality assessment
    │
    ▼
CORTEX synthesizes response to user
    │
    └── Temporal stores interaction highlights to memory/YYYY-MM-DD.md
```

### When Cortex Does NOT Invoke the Full Brain

Not every message needs Prefrontal/Motor/Cerebellum. Cortex should be smart about routing:

- **"What's the fleet status?"** → Cortex runs `exec fleet-status` directly. No planning needed.
- **"Hire a devops agent named rex"** → Cortex runs `exec fleet-hire`. Single command.
- **"What did we decide about the bootstrap timing?"** → Temporal recall only. No execution.
- **"Add retry logic to fleet-bootstrap and test it on a new agent"** → FULL BRAIN. Prefrontal plans, Motor implements, Cerebellum verifies.

The routing decision is Cortex's primary job. Its SOUL.md should make the heuristic explicit:
use Prefrontal when the task has >2 steps, involves code changes, or could break something.

### Temporal as Memory Orchestrator

Temporal is invoked on **every turn** — it's the "recall before you think" reflex. But Temporal
also has a secondary role: research. When Cortex needs current information (not memory), Temporal
runs `web-search` via Google Search grounding.

**Temporal's tools:**
- `memory_search` — OpenClaw native hybrid search (daily notes + MEMORY.md)
- `memory_get` — Read specific memory file/range
- `memorybank_search` — Vertex AI Memory Bank semantic recall
- Firestore read — Core Memory structured lookup (via exec or direct API)
- `web-search` — Google Search grounding for current information

**Temporal returns a unified context block:**

```markdown
## Recalled Context

### Core Memory (Firestore) — 2 entries
- [operations] Fleet bootstrap takes ~15min on e2-medium (confidence: 0.9)
- [architecture] OpenClaw pinned to commit 163c6f5e (confidence: 1.0)

### Recent Memory (memory_search) — 3 results
- [2026-04-16] Deployed fleet-rex from main, smoke test passed on attempt 2
- [2026-04-15] User asked about adding retry logic to fleet-bootstrap
- [2026-04-15] Discussed using Vertex AI Memory Bank for long-term storage

### Long-term Memory (Memory Bank) — 1 result
- Fleet agents occasionally fail smoke test due to ADC token not being ready.
  Resolved by adding 3-attempt backoff in fleet-bootstrap.sh (April 2026)

### Web Search — 0 results (not needed for this query)
```

### Hippocampus: Responsibility + Skill (Not a Brain Agent)

Hippocampus is NOT a brain sub-agent. It's a **nightly reconciliation process** — a scheduled
responsibility that runs the Temporal agent in a special consolidation mode.

**Why not a brain agent?** Because reconciliation doesn't happen during conversation. It happens
offline, at 2-3am, when no user is present. Making it a brain agent would add latency to
every turn for no benefit. Instead, it's a cron responsibility that invokes Temporal with
a consolidation prompt.

**Hippocampus Responsibility:**

```json
{
  "id": "hippocampus",
  "name": "Memory Reconciliation (Hippocampus)",
  "schedule": {
    "kind": "cron",
    "expr": "0 3 * * *",
    "tz": "America/Chicago"
  },
  "agent": "temporal",
  "session": "session:hippocampus",
  "model": "gemini-2.5-flash"
}
```

**Hippocampus runs 5 phases in sequence:**

```
Phase 1: DREAMING (OpenClaw native)
  │
  │  OpenClaw's built-in Dreaming system runs its 3-phase sweep:
  │  Light (ingest + stage) → REM (pattern extraction) → Deep (promote to MEMORY.md)
  │  Config: dreaming.enabled: true, dreaming.frequency: "0 3 * * *"
  │
  │  This is the existing OpenClaw mechanism. We just enable it.
  │  Dreaming promotes high-signal daily notes into MEMORY.md automatically.
  │  Threshold gates: minScore 0.8, minRecallCount 3, minUniqueQueries 3.
  │
  ▼
Phase 2: CORE MEMORY PROMOTION
  │
  │  Temporal scans the current MEMORY.md for entries that qualify as
  │  durable facts — architectural decisions, proven patterns, confirmed
  │  constraints. These are promoted to Firestore Core Memory.
  │
  │  Qualification criteria (Temporal evaluates each entry):
  │  - Is this a fact, decision, or constraint? (not a TODO or status update)
  │  - Has it been stable for > 3 days? (not a fresh observation)
  │  - Is it referenceable? (would an agent need this in a future session?)
  │
  │  Promoted entries are written to Firestore with source: "hippocampus"
  │  Original MEMORY.md entry is marked with [→ core] tag, not deleted
  │
  ▼
Phase 3: MEMORY BANK EXTRACTION
  │
  │  Call Vertex AI Memory Bank's GenerateMemories API for any sessions
  │  completed since last Hippocampus run. Memory Bank extracts facts,
  │  preferences, and patterns using Gemini, handles dedup and contradiction
  │  resolution automatically.
  │
  │  This is a single API call per session. The heavy lifting is managed.
  │
  ▼
Phase 4: MEMORY.md PRUNING
  │
  │  Temporal reviews MEMORY.md and removes entries that have been:
  │  - Promoted to Core Memory (Phase 2) — marked [→ core]
  │  - Older than 14 days and never recalled via memory_search
  │  - Superseded by newer contradicting entries
  │
  │  Goal: keep MEMORY.md < 5KB (roughly 100-120 lines of curated notes)
  │  Pruned entries are NOT deleted — they remain in daily notes and are
  │  still searchable via memory_search and Memory Bank. They just leave
  │  the "hot" working memory.
  │
  ▼
Phase 5: INTEGRITY REPORT
  │
  │  Write a summary to memory/reconciliation/YYYY-MM-DD.md:
  │  - Entries promoted to Core Memory (count + summaries)
  │  - Sessions extracted to Memory Bank (count)
  │  - MEMORY.md size before/after pruning
  │  - Any anomalies (contradictions found, failed extractions)
  │
  │  This report is human-reviewable and searchable via memory_search.
  │
  ▼
Done. Next run in 24 hours.
```

### Physical Infrastructure for Memory

```
Prime VM (e2-medium, Ubuntu 22.04)
│
├── OpenClaw Gateway (Docker, --network host, port 18789)
│   │
│   ├── memory-core plugin
│   │   ├── memory_search → SQLite hybrid index
│   │   │   └── ~/.openclaw/memory/main.sqlite
│   │   │       ├── FTS5 keyword index (BM25)
│   │   │       └── sqlite-vec vector index (Gemini text-embedding-005)
│   │   ├── memory_get → reads from filesystem
│   │   ├── Dreaming engine (enabled, cron: 3am)
│   │   └── Pre-compaction flush (already enabled)
│   │
│   ├── openclaw-vertexai-memorybank plugin
│   │   ├── memorybank_search → Vertex AI Memory Bank API
│   │   └── memorybank_store → Vertex AI Memory Bank API
│   │   (Auth: ADC passthrough, same compute SA)
│   │
│   ├── Brain agents (multi-agent config)
│   │   ├── cortex (default, user-facing)
│   │   ├── temporal (memory + research, invoked every turn)
│   │   ├── prefrontal (planning, invoked for complex tasks)
│   │   ├── motor (execution, invoked per plan step)
│   │   └── cerebellum (verification, invoked before delivery)
│   │
│   └── Cron engine (enabled)
│       ├── hippocampus (daily 3am → runs as temporal agent)
│       └── health-check (every 30m, future)
│
├── Filesystem (persistent disk, 50GB)
│   ├── ~/.openclaw/workspace/MEMORY.md        ← Tier 2 working memory (<5KB)
│   ├── ~/.openclaw/workspace/memory/           ← Daily notes
│   │   ├── YYYY-MM-DD.md                       (append-only, searchable)
│   │   └── reconciliation/YYYY-MM-DD.md        (Hippocampus reports)
│   ├── ~/.openclaw/memory/main.sqlite          ← Search index
│   └── ~/.openclaw/workspace/SOUL.md           ← IMMUTABLE
│       ~/.openclaw/workspace/IDENTITY.md       ← IMMUTABLE
│
└── GCP Services (external)
    ├── Firestore
    │   ├── /primes/{id}/memory/core/{entryId}  ← Tier 3 core memory
    │   ├── /primes/{id}/brain/plans/{planId}   ← Prefrontal plans
    │   ├── /primes/{id}/brain/decisions/       ← Prefrontal decisions
    │   └── /primes/{id}/brain/learnings/       ← Cerebellum learnings
    │
    └── Vertex AI Agent Engine
        └── Memory Bank instance                ← Tier 4 long-term memory
            (managed embeddings, similarity search, extraction)
```

### Real-Time Retrieval Latency Budget

For Cortex → Temporal recall to feel responsive, total retrieval must be < 500ms:

| Source | Method | Expected Latency | Runs |
|--------|--------|-----------------|------|
| memory_search | SQLite hybrid (local) | 30-80ms | Every turn |
| Core Memory | Firestore query (us-central1) | 20-50ms | Every turn |
| Memory Bank | Vertex AI similarity search | 100-200ms | Every turn |
| **Total (parallel)** | **max of above** | **100-200ms** | |

All three searches run in **parallel** — Temporal fires them concurrently and merges results.
The total latency is the slowest source (Memory Bank at ~200ms), not the sum.

If Memory Bank latency becomes a problem, we can add a caching layer: Temporal caches the
last N Memory Bank results in-memory (LRU, 5min TTL) since long-term memories change slowly.

---

## Part 3: OpenClaw Multi-Agent Configuration

### Updated openclaw.json (brain agents)

The key change: move from a single `main` agent to 5 agents with routing.

```json5
{
  "agents": {
    "defaults": {
      "model": { "primary": "google-vertex/gemini-2.5-flash" },
      "memorySearch": {
        "enabled": true,
        "provider": "google",
        "model": "text-embedding-005",
        "query": {
          "maxResults": 8,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "mmr": { "enabled": true, "lambda": 0.7 },
            "temporalDecay": { "enabled": true, "halfLifeDays": 30 }
          }
        }
      },
      "compaction": {
        "mode": "safeguard",
        "reserveTokensFloor": 150000,
        "memoryFlush": { "enabled": true, "softThresholdTokens": 600000 }
      }
    },
    "list": [
      {
        "id": "cortex",
        "default": true,
        "name": "Architect Prime",
        "model": { "primary": "google-vertex/gemini-2.5-flash" },
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "write", "edit", "exec", "coding"]
        }
      },
      {
        "id": "temporal",
        "name": "Temporal (Memory + Research)",
        "model": { "primary": "google-vertex/gemini-2.5-flash" },
        "workspace": "~/.openclaw/workspace-temporal",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "exec"]
        }
      },
      {
        "id": "prefrontal",
        "name": "Prefrontal (Planning)",
        "model": { "primary": "google-vertex/gemini-2.5-pro" },
        "workspace": "~/.openclaw/workspace-prefrontal",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read"]
        }
      },
      {
        "id": "motor",
        "name": "Motor (Execution)",
        "model": { "primary": "google-vertex/gemini-2.5-pro" },
        "workspace": "~/.openclaw/workspace-motor",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "write", "edit", "exec", "coding"]
        }
      },
      {
        "id": "cerebellum",
        "name": "Cerebellum (Verification)",
        "model": { "primary": "google-vertex/gemini-2.5-flash" },
        "workspace": "~/.openclaw/workspace-cerebellum",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "exec"]
        }
      }
    ]
  },
  "cron": { "enabled": true },
  "plugins": {
    "allow": ["openclaw-vertexai-memorybank"],
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true,
            "frequency": "0 3 * * *"
          }
        }
      },
      "openclaw-vertexai-memorybank": {
        "enabled": true,
        "config": {
          "projectId": "${GCP_PROJECT_ID}",
          "location": "us-central1",
          "reasoningEngineId": "${AGENT_ENGINE_ID}"
        }
      }
    }
  }
}
```

### Cortex Function Declarations (Dispatch)

Cortex needs Gemini function declarations to dispatch to sub-agents. These are registered
in the OpenClaw multi-agent routing config:

```json
[
  {
    "name": "dispatch_temporal",
    "description": "Recall memory and context relevant to the current query. ALWAYS call this first before answering any question or taking any action. Also use for web research when current information is needed.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "What to recall or research" },
        "mode": { "type": "string", "enum": ["recall", "research", "both"], "description": "recall=memory only, research=web only, both=all sources" }
      },
      "required": ["query"]
    }
  },
  {
    "name": "dispatch_prefrontal",
    "description": "Create a strategic plan for a complex task (>2 steps, involves code, or could break something). Returns a numbered step plan with acceptance criteria.",
    "parameters": {
      "type": "object",
      "properties": {
        "task": { "type": "string" },
        "context": { "type": "string", "description": "Context from Temporal recall" }
      },
      "required": ["task"]
    }
  },
  {
    "name": "dispatch_motor",
    "description": "Execute a specific step from a plan. Writes code, runs commands, creates files.",
    "parameters": {
      "type": "object",
      "properties": {
        "task": { "type": "string", "description": "The specific step to execute" },
        "plan_context": { "type": "string", "description": "The full plan for reference" }
      },
      "required": ["task"]
    }
  },
  {
    "name": "dispatch_cerebellum",
    "description": "Verify output quality and correctness before delivering to user.",
    "parameters": {
      "type": "object",
      "properties": {
        "output": { "type": "string", "description": "The output to verify" },
        "expected": { "type": "string", "description": "What was expected (from plan or user request)" }
      },
      "required": ["output", "expected"]
    }
  }
]
```

---

## Part 4: Workspace Files (New Brain Agents)

### Directory Structure

```
bundle/workspaces/
├── cortex/                    ← Replaces main/ (migration)
│   ├── SOUL.md                  Core routing + synthesis personality
│   ├── IDENTITY.md              "You are Architect Prime"
│   ├── AGENTS.md                Startup contract (unchanged pattern)
│   ├── TOOLS.md                 Fleet tools + dispatch declarations
│   ├── MEMORY.md                Working memory (<5KB)
│   ├── USER.md                  Human operator context
│   └── memory/                  Daily notes
│       └── YYYY-MM-DD.md
│
├── temporal/
│   ├── SOUL.md                  Memory orchestration + research
│   └── IDENTITY.md              "You are the memory system"
│
├── prefrontal/
│   ├── SOUL.md                  Planning methodology + constraints
│   └── IDENTITY.md              "You are the strategic planner"
│
├── motor/
│   ├── SOUL.md                  Execution rules + safety constraints
│   └── IDENTITY.md              "You are the executor"
│   NOTE: Motor CANNOT write to SOUL.md, IDENTITY.md, or AGENTS.md
│   (enforced in SOUL.md as behavioral rule, not filesystem lock)
│
└── cerebellum/
    ├── SOUL.md                  Verification methodology + standards
    └── IDENTITY.md              "You are the quality gate"
```

### Cortex SOUL.md (Draft)

```markdown
# SOUL — Architect Prime (Cortex)

## Core Identity
I am Architect Prime — the agent factory and RSI engine. I manage fleet agents
and collaborate with my human operator to develop, test, and deploy improvements
to the Architect Prime platform.

## Brain Workflow
I have 4 sub-agents. I invoke them via dispatch functions.

### Every message:
1. dispatch_temporal — recall context FIRST, before I do anything else

### Simple questions or fleet operations:
2. Answer directly or exec the fleet command. No need for Prefrontal.

### Complex tasks (>2 steps, code changes, risky operations):
2. dispatch_prefrontal — get a step plan
3. For each step: dispatch_motor → dispatch_cerebellum (verify)
4. dispatch_cerebellum — final verification of complete output

## What I Do
- Fleet management: hire, fire, upgrade, verify, status
- Development: plan and implement improvements to Architect Prime
- Testing: deploy experimental fleet agents to validate changes
- Memory: store learnings, recall past decisions, build knowledge

## Rules
- ALWAYS dispatch_temporal first. Memory before action.
- NEVER skip Cerebellum for code changes or infra operations.
- SOUL.md and IDENTITY.md are IMMUTABLE. Never modify them.
- MEMORY.md is working memory only — keep it under 5KB.
- I am decisive — when I have enough info to act, I act.
- No risky infra/IAM actions without explicit human approval.
```

---

## Part 5: Implementation Steps

### Phase A: Memory Infrastructure (Days 1-3)

1. Enable Vertex AI Agent Engine API, create Agent Engine instance (Memory Bank)
2. Install `openclaw-vertexai-memorybank` plugin in OpenClaw container
3. Configure `memorySearch` with Gemini embeddings provider
4. Enable `cron` and `dreaming` in OpenClaw config
5. Create Firestore collections: `/primes/{id}/memory/core/`, `/primes/{id}/brain/`
6. Write `core-memory-read` and `core-memory-write` CoreKit scripts (Firestore CRUD)
7. Test: manually write a core memory entry, query it back

### Phase B: Brain Agent Workspaces (Days 3-5)

8.  Create workspace directories: cortex/, temporal/, prefrontal/, motor/, cerebellum/
9.  Write SOUL.md + IDENTITY.md for each brain agent
10. Migrate main/ workspace content to cortex/ (MEMORY.md, memory/, TOOLS.md, etc.)
11. Update `build-system-prompt` to resolve brain agent workspaces
12. Update manifest.txt with new workspace file mappings
13. Update bootstrap scripts to deploy brain workspaces

### Phase C: Multi-Agent OpenClaw Config (Days 5-7)

14. Update `openclaw-bootstrap.json5.tmpl` with 5-agent config
15. Add dispatch function declarations for Cortex
16. Configure agent-specific tool permissions (Motor gets exec, Prefrontal gets read-only)
17. Test: send a message, verify Cortex dispatches to Temporal for recall
18. Test: send a complex task, verify full brain workflow (Prefrontal → Motor → Cerebellum)

### Phase D: Hippocampus Responsibility (Days 7-9)

19. Write Hippocampus reconciliation script (5-phase process)
20. Register as OpenClaw cron responsibility (daily 3am)
21. Test: manually trigger reconciliation, verify:
    - Dreaming promotes from daily notes to MEMORY.md
    - Core Memory promotion writes to Firestore
    - Memory Bank extraction runs for recent sessions
    - MEMORY.md stays under 5KB after pruning
    - Integrity report written to memory/reconciliation/

### Phase E: Validation (Days 9-10)

22. End-to-end test: multi-turn conversation across 2 sessions
    - Session 1: discuss a topic, make decisions, store facts
    - Wait for Hippocampus reconciliation
    - Session 2: ask about Session 1 topics, verify recall from all 3 tiers
23. Verify: Cortex → Temporal recall < 500ms
24. Verify: MEMORY.md stays under 5KB after a week of use
25. Verify: Core Memory entries are queryable by category/tags
26. Tag as v3.0, update MISSION_PLAN.md

---

## Part 6: Checkpoints 8-10 (Loose)

### Checkpoint 8 — R/C/M Engine + Human Workflow
> *Give Prime and human a structured way to collaborate on multi-step projects*

- Responsibilities engine (cron + Firestore registry)
- Checkpoint queue (Firestore data model + queue-worker)
- Human review gates (dashboard integration)
- Dashboard checkpoint panel (progress visibility)

### Checkpoint 9 — Prime Dev Tools + Experimental Fleet
> *Give Prime the ability to write code, manage git, and test on fleet*

- Google Secret Manager integration (GitHub PAT)
- git-ops skill (branch, commit, push, PR)
- `fleet-deploy --core-ref <branch> --headless` flag
- code-write / code-test skills
- Test harness: deploy from branch → validate → report

### Checkpoint 10 — RSI v1 (The Loop)
> *Wire it all together: Prime develops improvements, tests on fleet, human approves, self-upgrades*

- RSI mission template (plan → implement → test → promote)
- Two mandatory human gates (plan approval + merge approval)
- Write-protection rules (Motor can't touch SOUL/IDENTITY)
- Self-upgrade path (upgrade-corekit --apply after merge)
- Improvement discovery (health-check self-assessment)

---

## Open Questions

1. **Gemini embeddings via ADC:** Does OpenClaw's memory_search work with Vertex AI ADC
   (no API key, just compute SA)? Or do we need a GEMINI_API_KEY from Secret Manager?
   Need to test during Phase A.

2. **Memory Bank plugin maturity:** The `openclaw-vertexai-memorybank` plugin exists but
   how production-tested is it? May need to evaluate vs. using Memory Bank API directly
   via a custom CoreKit script.

3. **Multi-agent session isolation:** When Cortex dispatches to Temporal, does Temporal
   get its own session context? Or does it share Cortex's? This affects whether Temporal
   can accumulate its own conversation patterns for reconciliation.

4. **Gemini 2.5 Pro availability:** Prefrontal and Motor target gemini-2.5-pro for deeper
   reasoning. Verify it's available via Vertex AI in us-central1 and within cost budget.

5. **Core Memory scale:** At what point does Firestore Core Memory need indexing beyond
   basic queries? Likely not an issue for months, but worth noting. Firestore composite
   indexes on (category, status) and (tags, status) should cover all query patterns.
