# Coding Standards — Architect Prime

## Shell scripts (CoreKit bin/)
- Always start with `#!/usr/bin/env bash` and `set -euo pipefail`
- Include a header comment block: name, purpose, usage, environment vars
- Use `curl -sf -H 'Metadata-Flavor: Google'` for GCE metadata
- Get auth tokens from metadata server, never hardcode
- Use python3 inline for JSON parsing (not jq — may not be installed)
- All scripts must be idempotent and re-runnable
- Include VERIFY + ROLLBACK sections in comments

## Workspace files (bundle/workspaces/)
- SOUL.md = core truths, boundaries, vibe (character, not process)
- IDENTITY.md = who the agent is, 1-2 paragraphs
- TOOLS.md = available tools and policies
- MEMORY.md = curated long-term (< 5KB)
- Keep all workspace files under 1500 chars each (truncation limit)

## Firestore conventions
- Collection paths: `/primes/{primeId}/fleet/`, `/primes/{primeId}/messages/`, `/config/`
- Timestamps: ISO 8601 UTC (`2026-04-04T21:00:00Z`)
- Status enums: lowercase (`online`, `offline`, `deploying`, `error`)
- IDs: lowercase, kebab-case

## OpenClaw configuration
- Bootstrap config is JSON5 (`.json5.tmpl` files with `${VAR}` template vars)
- Agent workspaces at `~/.openclaw/workspace` (main) or `~/.openclaw/workspace-fleet` (fleet)
- Canonical CLI wrapper: always use `oc` (never `pnpm openclaw ...` directly)
- Gateway API: `POST http://localhost:18789/api/message` with Bearer token auth
- Single main agent per VM (no sub-agents in v2.0)

## General
- No secrets in repo — runtime injection via env vars and GCE metadata
- Prefer ADC + REST/SDK over `gcloud` CLI where possible
- Least-privilege IAM — never grant more than needed
- All installs, deploys, and upgrades must be idempotent
