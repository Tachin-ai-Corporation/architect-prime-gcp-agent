# TOOLS & ENVIRONMENT (Facts)

This file is factual. Behavior rules are in SOUL.md and AGENTS.md.

## Canonical OpenClaw CLI wrapper
- ALWAYS use: `oc <cmd>`
- Diagnostic command: `oc doctor --non-interactive`
- NEVER use: `openclaw <cmd>` or `pnpm openclaw <cmd>` directly.

Wrapper location:
- `~/.openclaw/bin/oc`

## Exec surface
`exec` runs on the **gateway host** (not a sandbox) in this deployment.
This avoids the “missing /app, missing pnpm” regression.

## OpenClaw repo
- `/app` (contains package.json)
- The wrapper `oc` will `cd /app` automatically.

## Workspaces
- Main: `~/.openclaw/workspace`
- Engineer: `~/.openclaw/workspace-engineer`
- DevOps: `~/.openclaw/workspace-devops`

Shared, cross-agent coordination folder (recommended):
- `~/.openclaw/shared`

## Google auth (ADC)
This environment uses Google Application Default Credentials (ADC) via the VM attached service account.
Metadata token example:
`curl -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`

## Web-search policy
- `web-search` tool is disabled (deny).
