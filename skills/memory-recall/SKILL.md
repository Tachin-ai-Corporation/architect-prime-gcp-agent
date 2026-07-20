# Skill: Memory Recall

## When to Use
When Cortex dispatches temporal-memory for recall. The brain daemon pre-fetches
data from all memory layers and the work ledger, then passes it to
temporal-memory for synthesis.

## Architecture
Temporal-memory runs with `maxSteps=1` and no tool access — it is a pure
synthesizer. The brain daemon's `recallMemory()` function handles all data
retrieval:

### Pre-loaded Sources (always included)
1. **Working Memory** — `MEMORY.md` contents (most current operational state)
2. **Core Memory** — Firestore entries via `core-memory-read` (query-filtered + recent scan, deduped)
3. **Recent Work Digest** — Last 7 days of work across **all outcomes** (complete, failed, blocked, needs_input, cancelled) from the work ledger, grouped by day; each entry is marked with its outcome and a short why-blurb and cites its mission id. Failures are included on purpose — recent failures carry the most learning and are the context most often needed.

### Targeted Sources (included when cues match)
4. **Episodic Work Search** — Work envelopes matching extracted cues from the query (30-day window; 180 days on escalation). Includes failed/blocked missions, ranked below completed ones.

> **Granularity boundary.** Recall surfaces recent work at the **mission/outcome** level (holistic, bounded). For a deliberate, per-task post-mortem of one failed mission — its step-ledger attempts, tool errors, and per-attempt timing — that is an explicit investigation *task* the agent runs via the **work-management** skill (`work-log-read --self --mission <id>`), not something recall pre-loads. Keep recall lean (B-4); reach for the tool when depth is the goal.

All data is injected into temporal-memory's prompt as `PRE-LOADED MEMORY DATA`.

## Recall Scopes
The daemon determines scope automatically based on the query:

| Scope | Sources | When |
|-------|---------|------|
| **targeted** (default) | Layers 1–4 (30-day search window) | Most recall requests |
| **deep** | Layers 1–4 (180-day search window) | Escalation or caller-specified |

## Temporal-Memory's Role

### Pass-1: Assess and Construct
When you receive a recall request with pre-loaded data:
1. **Parse the query** — Understand what facts are being asked for
2. **Assess each candidate** — Is it genuinely relevant, or just keyword noise?
3. **Construct the package** — Merge relevant items into a focused response, citing work items by id and date
4. **OR Escalate** — If answering requires work history older or broader than the candidates, emit exactly:
   ```json
   {"recall_escalate": true, "cues": ["refined", "search", "terms"], "reason": "Need older deployment history"}
   ```
   Do NOT guess or fabricate — escalate and the daemon will fetch deeper history.

### Pass-2: Construct Only (after escalation)
You receive expanded candidates including deep history. Construct the final package. No further escalation.

## Key Principles
- **Surface relevant, not everything** — Recall makes context smaller, not larger (B-4)
- **Never fabricate** — If nothing matches, say so. Don't invent memories.
- **Cite work items** — Reference by envelope id and date when including episodic hits.
- **Stay in your lane** — No web search (temporal-research), no APIs (motor).
- **Escalation is bounded** — At most one escalation per recall. The daemon enforces this.
- **Prioritize recency** — Recent context > targeted hits > context fill.
- **Structure your response** — Use clear sections (Working Memory, Core Memory, Work History, Sessions).
