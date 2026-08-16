# Architect Prime — CoreKit

> Generated from: `YOUR_GITHUB_ORG/architect-prime-gcp-agent@main`

## What this is
A manifest-driven "core kit" for Architect Prime that includes:

- Agent workspace files (`platform/organ-firmware/prime/`, `platform/organ-firmware/fleet/`, `specialties/`)
- The VM runtime (`platform/{contracts,security,persistence,providers,context,control-plane,work,deployment,runtime}/`)
- CoreKit scripts (`corekit/{brain,fleet,chat,memory,dashboard,system}/`)
- Infrastructure contracts (`infra/contracts.json`)

Every module installs at the path it occupies in the repo, so an import resolves
the same in a checkout and on a VM. Nothing resolves through a symlink.

## How you use it (manifest installer)
1. Install via `infra/install.sh --role prime` or `--role fleet --job devops`
2. The installer reads manifest fragments from `infra/manifests/` and downloads each file

### Expected environment variables
Set by the bootstrap script (not by the user):
- `GCP_PROJECT_ID`
- `MY_TOKEN` (gateway auth token)
- `AGENT_USER_EMAIL` (for fleet agents)

> `/opt/corekit/bin` is added to PATH via the bootstrap settings.
