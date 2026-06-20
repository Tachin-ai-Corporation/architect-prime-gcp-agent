# Skill: Memory Recall

## When to Use
When Cortex dispatches temporal-memory for recall. The brain daemon pre-fetches
data from all memory layers and passes it to temporal-memory for synthesis.

## Architecture
Temporal-memory runs with `maxSteps=1` and no tool access — it is a pure
synthesizer. The brain daemon's `recallMemory()` function handles data fetching:

1. **MEMORY.md** — Read from `/opt/corekit/workspace/MEMORY.md`
2. **Core Memory** — `core-memory-read --status active --limit 15`
3. **Session Summaries** — `session-summary --hours 24`

All data is injected into temporal-memory's prompt as `PRE-LOADED MEMORY DATA`.

## Temporal-Memory's Role
When you receive a recall request with pre-loaded data:
1. **Parse the query** — Understand what facts are being asked for
2. **Extract relevant context** from each memory layer
3. **Prioritize** — recent context > targeted hits > context fill
4. **Compile** — Merge into a single structured response

## Key Principles
- **Always include MEMORY.md content** — Working memory is the most current context.
- **Never fabricate** — If nothing matches, say so. Don't invent memories.
- **Stay in your lane** — Do not search the web (temporal-research's job). Do not call external APIs (motor's job).
- **Prioritize recency** — Recent context outweighs old archived facts.
- **Structure your response** — Use clear sections (Working Memory, Core Memory, Sessions).
