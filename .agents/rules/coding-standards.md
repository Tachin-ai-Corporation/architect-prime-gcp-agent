# Coding Standards — Architect Prime

## Shell scripts (corekit/)
- Always start with `#!/usr/bin/env bash` and `set -euo pipefail`
- Include a header comment block: name, purpose, usage, environment vars
- Use `curl -sf -H 'Metadata-Flavor: Google'` for GCE metadata
- Get auth tokens from metadata server, never hardcode
- Use python3 inline for JSON parsing (not jq — may not be installed)
- All scripts must be idempotent and re-runnable
- Never fail fatally on telemetry/logging writes — exit 0

## Workspace files (brain/)
- SOUL.md = identity + turn protocol + decision rules
- IDENTITY.md = who the agent is, 1-2 paragraphs
- MEMORY.md = working memory, curated, < 2000 chars
- Keep workspace files focused — no overlap between files

## Firestore conventions
- Collection paths: `/primes/{id}/`, `/primes/{id}/messages/`, `/primes/{id}/fleet/`, `/primes/{id}/tasks/`, `/primes/{id}/dispatch-log/`, `/primes/{id}/fleet/{agent}/tasks/`
- Timestamps: ISO 8601 UTC (`2026-04-04T21:00:00Z`)
- Status enums: lowercase (`online`, `offline`, `deploying`, `executing`, `complete`, `failed`)
- IDs: lowercase, kebab-case
- Even segment counts only (collection/document pairs) — odd segments cause 400 errors

## Neural Gateway configuration
- Config: `/opt/corekit/corekit/config.json`
- Agent workspaces at `/opt/corekit/workspace` (cortex) or `/opt/corekit/workspace-{agent}` (sub-agents)
- Gateway API: `POST http://localhost:18789/v1/chat/completions` with Bearer token auth

## PowerShell (local dev)
- SSH one-liners: `echo y | gcloud compute ssh {VM} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="..."`
- PowerShell doesn't support `&&` — use `;` to chain commands
- Use `--command=` flag, not `-- "command"` (Plink parsing issues)

## General
- No secrets in repo — runtime injection via env vars and GCE metadata
- Prefer ADC + REST/SDK over `gcloud` CLI where possible
- Least-privilege IAM — never grant more than needed
- All installs, deploys, and upgrades must be idempotent
- Commit messages: `v2026.04.28.1.0: description` — always prefixed with target date-version
