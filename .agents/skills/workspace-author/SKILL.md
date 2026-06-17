---
name: workspace-author
description: Use when creating/editing any agent workspace file — SOUL.md, IDENTITY.md, MEMORY.md for any agent.
---
# Workspace File Authoring

## File purposes
- **SOUL.md** = core identity, boundaries, personality, locked design rules (< 2000 chars)
- **IDENTITY.md** = who the agent is, 1-2 paragraphs (< 1500 chars)
- **MEMORY.md** = curated working memory, updated during turns (< 5KB)

## Workspace locations
- **Prime brain** (6 agents): `brain/prime/{cortex,temporal-research,temporal-memory,prefrontal,motor,cerebellum}/`
- **Fleet generic template**: `brain/fleet/_base/` (uses `{{AGENT_NAME}}`, `{{SPECIALTY}}` template vars)
- **Fleet brain sub-agents**: `brain/fleet/_brain/{prefrontal,motor,cerebellum,temporal-research,temporal-memory,cortex}/`
- **Specialty workspaces**: `specialties/<type>/workspace/` (assistant, data, devops, engineer, finance, pm, qa, security)

## Writing rules
- Bullet points, clear headers, actionable
- Direct and decisive — avoid excessive confirmation loops
- Prime brain files use HARDCODED identity (not template vars) — see brain/prime/cortex/SOUL.md
- Fleet brain files use `{{AGENT_NAME}}` and `{{SPECIALTY}}` template variables (substituted at install time)
- For fleet specialty workspace: include specialty-aware identity and capabilities

## How workspaces are loaded
The neural gateway reads workspace files natively from the mounted workspace directory.
System prompt = SOUL.md only. Skill documentation is accessed on-demand via `readFile /opt/corekit/skills/<name>/SKILL.md`.
`assemble-persona` appends specialty-specific SOUL sections during bootstrap.
