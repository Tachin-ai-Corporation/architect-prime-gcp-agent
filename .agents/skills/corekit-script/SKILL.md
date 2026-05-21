---
name: corekit-script
description: Use when creating/editing CoreKit scripts in corekit/{brain,fleet,gateway,chat,daemon,memory,dashboard,system}/ — agent-ask, agent-ears, agent-mouth, fleet-deploy, responsibility-manage, or any VM-side tool.
---
# CoreKit Script Development

## Directory Layout
Scripts live under `corekit/` grouped by domain:
- `corekit/brain/` — agent-ask, agent-status, assemble-tools, brain-telemetry-read, brain-telemetry-write, responsibility-manage, task-log-read, task-log-write
- `corekit/fleet/` — fleet-deploy, fleet-teardown, fleet-hire, fleet-fire, fleet-verify, fleet-upgrade, fleet-monitor, fleet-status, fleet-health-check
- `corekit/gateway/` — render-config, discover-models, upgrade-openclaw, bootstrap_smoke.sh, oc
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
