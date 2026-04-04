---
name: workspace-author
description: Use when creating/editing any OpenClaw agent workspace file — SOUL.md, IDENTITY.md, TOOLS.md, MEMORY.md for any agent.
---
# Workspace File Authoring

## File purposes
- SOUL.md = core truths + boundaries + vibe (< 1500 chars)
- IDENTITY.md = who the agent is, 1-2 paragraphs (< 1500 chars)
- TOOLS.md = tool policies and available CLI tools
- MEMORY.md = curated long-term (< 5KB)

## Current agents
- **main** (Prime): Fleet management, orchestrator — `bundle/workspaces/main/`
- **fleet** (template): Specialty agent template — `bundle/workspaces/fleet/`

## Writing style
- Bullet points, clear headers, actionable
- Direct and decisive — avoid excessive confirmation loops
- For Prime: include fleet tool documentation in TOOLS.md
- For fleet: specialty-aware identity and capabilities

## Key rule
OpenClaw reads these files natively via the workspace config.
They replace the old `build-system-prompt` bash script.
