# TOOLS (Fleet Agent)

- Workspace: `/opt/corekit/workspace`
- CoreKit tools: available directly in PATH (e.g., `web-search`, `agent-status`)
- ADC: metadata server tokens available on GCE

## Secrets
- `secret-read --name <secret-id>` — Read a granted secret value from Secret Manager
- Use via command substitution only: `TOKEN=$(secret-read --name my-key)`
- ⚠️ Never echo, log, write to files, MEMORY.md, Drive artifacts, or chat responses
- Access is IAM-controlled — request grants via the dashboard

## Web Search & Research (via temporal-research sub-agent)
When you need current, real-time information from the web, dispatch to your
`temporal-research` sub-agent. Do NOT call `web-search` directly
— they are denied. All web research goes through the sub-agent, which has:
- `web-search` — Vertex AI grounded search (Google Search) for finding information
- `web-fetch` — Fetch and extract content from specific URLs (text or HTML)

## Workspace Skills
Workspace skills are loaded per agent type. Check your SOUL.md and IDENTITY.md
for available tools and their brain-agent assignments.

### Drive Tools (if enabled)
If your agent type includes `workspace-drive`, these tools are available:
- ALL Drive tools (motor): `drive-ls`, `drive-search`, `drive-download`,
  `drive-upload`, `drive-mkdir`, `drive-rename`, `drive-delete`, `drive-move`, `drive-share`

See `skills/workspace-drive/SKILL.md` for full usage.
