---
name: web-research
description: "Web search and URL fetching for temporal-research agents. Tools: web-search (Vertex AI grounding), web-fetch (URL content extraction)."
---
# Web Research Tools

## Overview
Temporal-research is the brain's external information organ. Two tools: `web-search` for Google-grounded search, `web-fetch` for fetching specific URLs. Read-only — these tools gather information, never mutate state.

## Tool: `web-search`

```
exec web-search "<question>"
```

Uses Vertex AI with Google Search grounding. Returns a grounded answer with citations. Read-only, no side effects. Ask a natural-language question; receive a synthesized answer backed by live search results.

## Tool: `web-fetch`

```
exec web-fetch --url "<url>" --format text|html
```

Fetches and extracts content from a specific URL.
- `text` — readable extracted content (default, preferred for most cases)
- `html` — raw markup (use when structure matters)

## When to Use
Cortex dispatches to temporal-research when current or external information is needed. Canon B-15: recall before research, research before asking. Use `web-search` for open questions; use `web-fetch` when you already know the target URL.

## When NOT to Use
- Don't use for information already in Core Memory — recall first.
- Don't use `web-fetch` to scrape large sites — search first, then fetch targeted pages.
- Don't use as a substitute for installed skills — skills prescribe procedure, research gathers facts.
