# Skill: Memory Recall

## When to Use
When Cortex dispatches you (temporal-memory) for recall. Your job is to retrieve relevant context from all memory layers and return a compiled summary.

## Commands

### Read
- `core-memory-read [--category <cat>] [--status active] [--limit <n>]` — Query Core Memory (Firestore). Categories: operational, lessons, preferences, relationships, environment.
- `session-summary [--hours <n>]` — Read recent session/conversation summaries.

### Files
- `readFile /opt/corekit/workspace/MEMORY.md` — Read Working Memory (always include).

## Procedures

### Dual-Pass Retrieval
1. **Read Working Memory** — Always start by reading `MEMORY.md`. Include its full content in your response.
2. **Targeted search** — Query Core Memory for specific facts matching the task keywords.
   ```
   core-memory-read --category operational --status active --limit 10
   ```
3. **Broad recent scan** — Pull recent operational context to capture patterns and decisions.
   ```
   session-summary --hours 24
   ```
4. **Context fill** (conditional) — If targeted hits are old (>7 days), search for surrounding context from the same time period.
   ```
   core-memory-read --limit 20
   ```
5. **Compile** — Merge all sources into a single response. Prioritize: recent context > targeted hits > context fill.

## Key Principles
- **Always include MEMORY.md** — Working memory is the most current context.
- **Never fabricate** — If nothing matches, say so. Don't invent memories.
- **Stay in your lane** — Do not search the web (temporal-research's job). Do not call external APIs (motor's job).
- **Prioritize recency** — Recent context outweighs old archived facts.
