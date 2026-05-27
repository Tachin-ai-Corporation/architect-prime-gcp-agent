# TOOLS (Fleet Agent)

- Workspace: `~/.openclaw/workspace`
- Canonical CLI: `oc <cmd>` (never call `pnpm openclaw ...`)
- ADC: metadata server tokens available on GCE

## Web Search & Research (via temporal-research sub-agent)
When you need current, real-time information from the web, dispatch to your
`temporal-research` sub-agent. Do NOT call `web-search` or `agent-ask` directly
— they are denied. All web research goes through the sub-agent, which has:
- `agent-ask` — Vertex AI grounded search (Google Search) for finding information
- `web-fetch` — Fetch and extract content from specific URLs (text or HTML)

## Workspace Skills
Workspace skills are loaded per agent type. Check your SOUL.md and IDENTITY.md
for available tools and their brain-agent assignments.

### Drive Tools (if enabled)
If your agent type includes `workspace-drive`, these tools are available:
- ALL Drive tools (motor): `drive-ls`, `drive-search`, `drive-download`,
  `drive-upload`, `drive-mkdir`, `drive-rename`, `drive-delete`, `drive-move`, `drive-share`

See `skills/workspace-drive/SKILL.md` for full usage.
