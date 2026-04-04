---
name: brain-architecture
description: Use when working on the brain agent system — creating/editing agent workspace files, updating agent-types.json, modifying bootstrap config agent definitions, or OpenClaw gateway configuration. Also for agent routing and intent classification.
---
# Brain Architecture Implementation

## Current State (v2.0)
Single main agent per VM using OpenClaw's native agent loop. No sub-agents yet.

## Key files
- `bundle/corekit/config/openclaw-bootstrap.json5.tmpl` — Prime OpenClaw config
- `bundle/corekit/config/openclaw-fleet.json5.tmpl` — Fleet agent OpenClaw config
- `bundle/corekit/config/agent-types.json` — Available agent specialties
- `bundle/workspaces/main/` — Prime agent workspace (SOUL, IDENTITY, TOOLS, MEMORY)
- `bundle/workspaces/fleet/` — Fleet agent workspace template

## Future: Full brain model (7 agents)
Documented in `docs/architecture/BRAIN_ARCHITECTURE_v2.md` — NOT YET IMPLEMENTED.
Will be layered on top of single-agent foundation after v2.0 is stable.

## OpenClaw integration points
- Gateway API: `POST http://localhost:18789/api/message`
- `control-daemon` bridges Firestore → OpenClaw gateway (Prime)
- `inbox-daemon` bridges Google Chat → OpenClaw gateway (fleet)
- Fleet tools (`fleet-deploy`, etc.) available via OpenClaw exec tool on PATH
