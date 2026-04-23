---
name: corekit-script
description: Use when creating/editing CoreKit bin scripts in bundle/corekit/bin/ — agent-ask, build-system-prompt, fleet-deploy, queue-worker, checkpoint-*, responsibility-*, mission-*, or any VM-side tool.
---
# CoreKit Script Development
## Header: #!/usr/bin/env bash + set -euo pipefail + comment block
## GCE metadata: curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/...
## Auth: TOKEN from metadata server, never hardcode
## JSON: python3 inline (not jq)
## Firestore REST: https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents
## After adding script: update manifest.txt
## All scripts must be idempotent
