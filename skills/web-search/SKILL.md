# Skill: web-search

## What this skill does
Answers questions using real-time knowledge from Google Search via Vertex AI grounding.
Also fetches and extracts content from specific URLs.
This is a read-only skill — it does not modify any state or infrastructure.

## When to use
Dispatch to the `temporal-research` sub-agent when you need current, real-time
information from the web. This is the ONLY sanctioned web-search path.

## Tools

### web-search
```
exec web-search "<question>"
```

Uses Vertex AI with Google Search grounding (model and region read from contracts.json).
**Do NOT call web-search directly from Cortex** — route web research through
the temporal-research pipeline step in your dispatch plan.

### web-fetch
Fetch and extract content from a specific URL.

```
exec web-fetch "<url>"
```

Returns the text content of the page. Useful for reading specific articles,
documentation pages, or API responses found via web-search.

## Behavior
- Answer accurately and concisely
- Use markdown formatting sparingly (bold, bullet points)
- Keep responses under 3800 characters (truncated to fit Chat limit)
- If you don't know something, say so honestly
- Include source citations when available from grounding
