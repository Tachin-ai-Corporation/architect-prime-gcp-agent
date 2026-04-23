---
name: implement-brain-agent
description: Step-by-step workflow to implement a new brain agent from scratch. FUTURE — not applicable until v2.0 single-agent foundation is stable.
---
# Brain Agent Implementation (FUTURE)

> **STATUS**: NOT YET APPLICABLE. The brain architecture (7 agents) will be layered on
> top of the v2.0 single-agent foundation. See `docs/architecture/BRAIN_ARCHITECTURE_v2.md`.

## When this becomes relevant
After v2.0 is stable (OpenClaw gateway running, single main agent working on all VMs),
sub-agents can be added to the bootstrap config.

## Steps (when ready)
1. Read docs/architecture/BRAIN_ARCHITECTURE_v2.md for the full agent spec
2. Create workspace directory bundle/workspaces/{agentId}/
3. Write SOUL.md and IDENTITY.md
4. Add agent to openclaw-bootstrap.json5.tmpl agents array
5. Update Cortex AGENTS.md dispatch contract
6. Test via OpenClaw gateway
