---
name: corekit-script
description: Use when creating/editing CoreKit scripts in corekit/{brain,fleet,chat,daemon,memory,dashboard,system}/ — web-search, agent-ears, agent-mouth, fleet-deploy, responsibility-manage, or any VM-side tool.
---
# CoreKit Script Development

## Directory Layout
Scripts live under `corekit/` grouped by domain:
- `corekit/brain/` — web-search, agent-status, assemble-tools, brain-telemetry-read, brain-telemetry-write, responsibility-manage, project-manage, task-log-read, task-log-write
- `corekit/fleet/` — fleet-deploy, fleet-teardown, fleet-hire, fleet-fire, fleet-verify, fleet-upgrade, fleet-monitor, fleet-status, fleet-health-check
- `corekit/chat/` — chat-send, chat-read, dwd-token
- `corekit/daemon/` — agent-ears.mjs, agent-mouth.mjs, agent-brain.mjs, agent-brain.service, start-agent-ears, start-agent-mouth, ears-health-check, mouth-health-check
- `corekit/memory/` — core-memory-read, core-memory-write, core-memory-retire, update-deep-truths
- `corekit/dashboard/` — command-runner
- `corekit/system/` — upgrade-corekit, validate-contracts, web-search

## Conventions
- Header: `#!/usr/bin/env bash` + `set -euo pipefail` + comment block
- GCE metadata: `curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/...`
- Auth: TOKEN from metadata server, never hardcode
- JSON: `python3` inline (not jq for complex operations)
- Firestore REST: `https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents`
- After adding a script: update the appropriate `infra/manifests/*.txt` file
- All scripts must be idempotent
- Read cross-cutting values from `contracts.json`, not hardcoded defaults

## Skill Governance (Canon B-16)
Every motor-facing tool MUST have a governing skill in `.agents/skills/` that documents its usage, syntax, and examples. Tools without skills force motor agents to read raw source code, which wastes tokens and causes failures. When creating or modifying a corekit script:
1. Check if a governing skill exists — update it with any new subcommands or syntax changes
2. If no skill exists, create one following the pattern in `project-management/SKILL.md`
3. The skill is the documentation; the script header comment is just a quick reference
