# Architect Prime — CoreKit

> Generated from: `Tachin-ai-Corporation/architect-prime-gcp-agent@main`

## What this is
A manifest-driven "core kit" for Architect Prime that includes:

- Agent workspace files (`brain/prime/`, `brain/fleet/`, `specialties/`)
- CoreKit scripts (`corekit/{brain,fleet,chat,daemon,memory,dashboard,system}/`)
- Infrastructure contracts (`infra/contracts.json`)

## How you use it (manifest installer)
1. Install via `infra/install.sh --role prime` or `--role fleet --job devops`
2. The installer reads manifest fragments from `infra/manifests/` and downloads each file

### Expected environment variables
Set by the bootstrap script (not by the user):
- `GCP_PROJECT_ID`
- `MY_TOKEN` (gateway auth token)
- `AGENT_USER_EMAIL` (for fleet agents)

> `/opt/corekit/bin` is added to PATH via the bootstrap settings.
