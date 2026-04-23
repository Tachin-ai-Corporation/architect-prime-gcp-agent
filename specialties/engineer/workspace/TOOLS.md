# TOOLS (Engineer)

- Workspace: `~/.openclaw/workspace-engineer`
- Canonical CLI: `oc <cmd>` (never call `pnpm openclaw ...`)
- Shared skills: `~/.openclaw/skills`

## Web Search (Google Search Grounding)
When you need current, real-time information from the web, use the `web-search` tool:

```
web-search "your search query here"
```

This tool uses Vertex AI with Google Search grounding to retrieve current information with source citations. Use it for:
- Current software versions, pricing, release notes
- Recent news and announcements
- Live documentation and API references
- Any question requiring up-to-date information

**Always use web-search** when asked about current events, latest versions, or anything that could be stale in your training data.
