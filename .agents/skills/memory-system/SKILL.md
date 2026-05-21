---
name: memory-system
description: "Memory consolidation and long-term memory. 3-layer system: Working Memory (MEMORY.md), Core Memory (Firestore), Deep Truths (SOUL.md). Dual-pass recall. Nightly 10-step consolidation active (2am CT via temporal-memory cron)."
---
# Memory System (LIVE)

## Three-Layer Memory Architecture

### 1. Working Memory (`MEMORY.md`)
- Agent RAM — accumulates observations, decisions, and context during sessions
- Pruned nightly to < 2,000 chars during consolidation
- Lives in each agent's workspace directory

### 2. Core Memory (Firestore `core_memory` collection)
- Long-term durable facts — identity, preferences, learned patterns
- Actively pruned via `core-memory-retire` to keep the collection relevant
- Scripts:
  - `core-memory-read` — supports `--since` time-windowed queries
  - `core-memory-write` — stores new facts
  - `core-memory-retire` — removes stale/redundant entries

### 3. Deep Truths (`SOUL.md` `## Deep Truths` section)
- Behavioral firmware — max 10 items
- Changes only during nightly consolidation (requires 3+ sessions and 7+ day evidence)
- Script: `update-deep-truths`

## Dual-Pass Recall
Temporal-memory performs two-pass recall on every memory request:
1. **Targeted archive search** (all time) — semantic search across the full memory archive
2. **Broad recent scan** (30 days) — captures recent context that may not match the query semantically
3. **Context fill** — assembles retrieved memories into a coherent context window

## Nightly Consolidation (10-Step)
The `r-memory-consolidation` responsibility runs at 2am CT via temporal-memory cron:
1. **Gather** — Collect working memory from all sessions
2. **Triage** — Categorize memories by importance and type
3. **Reconcile** — Merge with existing Core Memory entries
4. **Retire** — Remove stale/redundant Core Memory entries
5. **Promote** — Elevate important working memory to Core Memory
6. **Prune** — Trim working memory (MEMORY.md) to < 2,000 chars
7. **Deep Truths** — Evaluate candidates for Deep Truths promotion (3+ sessions, 7+ day evidence)
8. **Report** — Generate consolidation summary

Reference: `skills/memory-consolidate/SKILL.md`, `docs/architecture/RESPONSIBILITIES_CHECKPOINTS_MISSIONS.md` (Section 4)
