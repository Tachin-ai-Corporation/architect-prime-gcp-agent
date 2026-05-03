# Architect Prime — CoreKit

> Generated from: `Tachin-ai-Corporation/architect-prime-gcp-agent@main`
> Last verified: v2026.05.03.9.0

## What this is
A manifest-driven "core kit" for Architect Prime that includes:

- OpenClaw config templates (`corekit/config/openclaw-bootstrap.json5.tmpl`, `openclaw-fleet-bootstrap.json5.tmpl`)
- Agent workspace files (`brain/prime/`, `brain/fleet/`, `specialties/`)
- CoreKit scripts (`corekit/{brain,fleet,gateway,chat,daemon,memory,dashboard,system}/`)
- Canonical CLI wrapper `oc` (so the agent never regresses into `pnpm openclaw ...`)
- Infrastructure contracts (`infra/contracts.json`)

## How you use it (manifest installer)
1. Install via `infra/install.sh --role prime` or `--role fleet --job devops`
2. The installer reads manifest fragments from `infra/manifests/` and downloads each file

### Expected environment variables
Set by the bootstrap script (not by the user):
- `GCP_PROJECT_ID`
- `MY_TOKEN` (gateway auth token)
- `AGENT_USER_EMAIL` (for fleet agents)

Config rendering uses `corekit/gateway/render-config` → produces `openclaw.json`.

> Note: the agent should never call `pnpm openclaw ...` directly; always use `oc <cmd>`.
> `~/.openclaw/bin` is added to PATH via the bootstrap's `tools.exec.pathPrepend` setting.
