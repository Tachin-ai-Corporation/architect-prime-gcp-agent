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
- **Size guard**: The daemon stops appending at 3,000 chars (logs `skipping append (await consolidation)`)
- After pruning, ~1,000 chars of headroom allows new writes before the guard triggers again

### 2. Core Memory (Firestore `core_memory` collection)
- Long-term durable facts — identity, preferences, learned patterns
- Actively pruned via `core-memory-retire` to keep the collection relevant
- Scripts:
  - `core-memory-read` — supports `--since` time-windowed queries, `--category` filtering
  - `core-memory-write` — stores new facts (generates `mem-YYYYMMDD-XXXXXXXX` IDs)
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

## Nightly Consolidation (9-Step Process: `p-memory-consolidate`)
The `r-memory-consolidation` responsibility runs at 2am CT (8:00 UTC) via scheduler:
1. **Pre-flight** — Read MEMORY.md, report character count
2. **Gather sessions** — `session-summary --hours 24`
3. **Gather Core Memory (recent)** — `core-memory-read --limit 20`
4. **Gather Core Memory (full archive)** — Read all 5 categories
5. **Triage and reconcile** — Classify each entry as ACTIVE/COMPLETED/STALE/PROMOTE
6. **Execute retirements** — `core-memory-retire` for stale entries
7. **Execute promotions** — `core-memory-write` for promoted facts
8. **Rewrite MEMORY.md** — Only ACTIVE items, must be under 2,000 chars
9. **Deep Truths review** — `update-deep-truths --list`, promote if criteria met

## Troubleshooting

### Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| MEMORY.md grows past 3000 chars | Consolidation failed or skipped | Manually reset MEMORY.md to only current items, then trigger consolidation |
| `skipping append (await consolidation)` in logs | MEMORY.md exceeded 3000-char guard | Normal behavior — consolidation will prune it. If repeated for days, consolidation is broken |
| `already executed on this envelope — forcing synthesize` | Process guard prevents re-execution on same envelope | Normal — the process ran on iteration 1, Cortex tried again on iteration 2 |
| Process steps about unrelated topics | Context contamination from recent work | Step 1 has scope enforcement. If still happening, check that the process context is isolated |
| Core memory has no entries after consolidation | Motor failed to execute `core-memory-write` promotions | Check step 7 logs for command errors. Common issue: shell escaping in fact text |
| MEMORY.md write fails with heredoc errors | Heredoc syntax is fragile in motor's shell | Process step 8 uses `printf` instead — if still failing, check for special characters |

### Manual Recovery
If consolidation is broken, run these commands on the agent VM:
```bash
# 1. Reset MEMORY.md
sudo bash -c 'printf "# MEMORY (DevOps)\n\n## Current Focus\n\n## Active Context\n\n## Open Items\n- None\n" > /opt/corekit/workspace/MEMORY.md'

# 2. Verify
wc -c /opt/corekit/workspace/MEMORY.md  # Should be < 500 chars

# 3. Seed important facts to core memory
/opt/corekit/bin/core-memory-write --fact "description of fact" --category operations --tags "tag1,tag2"

# 4. Trigger consolidation manually
# Send via GChat: "@Stan execute p-memory-consolidate"
```

Reference: `corekit/config/processes/p-memory-consolidate.json`, `corekit/config/responsibilities.json`
