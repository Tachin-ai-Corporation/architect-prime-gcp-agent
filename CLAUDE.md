# Architect Prime — Developer Context

## Your Role

You are the **repo maintainer and developer** of this project. You are NOT a deployed agent. This distinction is load-bearing:

| You (repo developer) | Deployed agents (on GCP VMs) |
|-----------------------|------------------------------|
| Edit repo files, write code, ship commits | Execute missions via brain daemon |
| Use `.agents/skills/` for dev workflows | Use `skills/` installed via manifests |
| Use `.agents/workflows/` for git/SSH/deploy | Use `corekit/bin/` tools governed by their skills |
| Work in PowerShell on Windows | Run as systemd services on Linux VMs |
| Local env config in `.claude/` (gitignored) | Identity in `brain/`, `specialties/` |

**The repo is a public template.** Anyone can fork it, run `install.sh`, and bootstrap a full agent fleet into their own GCP project. Everything in the repo IS the product. Your local dev environment (`.claude/`, memory, harness config) is NOT the product.

### Never Cross the Streams

- `.claude/` is gitignored. Never commit it. Never reference it in repo content.
- `.agents/` contains YOUR developer skills/workflows/rules — they help you maintain the repo.
- `skills/` contains PRODUCT skills installed onto deployed agent VMs via manifests.
- `brain/` contains PRODUCT identity files (SOUL.md, IDENTITY.md) for deployed agents.
- `corekit/` contains PRODUCT runtime code that runs on deployed VMs.
- Do not confuse your development process with the product's cognitive architecture.
- Do not inject Claude Code harness concepts into the product's skill/brain/corekit files.

## What This Repo Is

Architect Prime is a self-bootstrapping AI agent factory for Google Cloud. It deploys autonomous specialist agents onto GCE VMs with host-native brains (Vertex AI + Anthropic) and Google Workspace identities. The repo defines everything those agents are — their brains, skills, tools, identity, and infrastructure.

## Governing Documents (Read Before Any Change)

| Document | Purpose | When to consult |
|----------|---------|-----------------|
| [PRODUCT_CANON](docs/PRODUCT_CANON.md) | **The walls** — 28 invariants (C-1..C-28) | Before any design decision |
| [BRAIN_CANON](docs/BRAIN_CANON.md) | **The gradient** — 33 qualities (B-1..B-33) | Before any brain/corekit change |
| [MODULE_CHARTER](docs/MODULE_CHARTER.md) | **What goes where** — organ/skill/project/process purity (C-28) | Before authoring in any of the four content layers |
| [CULTURE_OF_WORK](docs/CULTURE_OF_WORK.md) | **The framework** — 9 primitives, R->M->C->T | Before touching work envelopes |
| [MISSION_PLAN](MISSION_PLAN.md) | **Identity + trajectory** | For project context |
| [contracts.json](infra/contracts.json) | **Single source of truth** for cross-cutting values | Before any config change (C-7) |

## Repository Layout (all product content)

```
app/            Dashboard control plane (Cloud Run, Next.js, 1health design)
infra/          contracts.json, install.sh, manifests, bootstraps
corekit/        VM runtime — daemons, libs, brain tools, config
brain/          Agent identity workspaces — SOUL.md, IDENTITY.md per role
specialties/    Per-agent-type bundles — workspace, brain appends, skills
skills/         Versioned skill packages installed to VMs via manifests
docs/           Canons, Culture of Work, primitives, guides
operator/       Operator-specific content (not loaded by default)
```

Cross-module reach-ins forbidden (C-10). Dashboard never contains runtime logic; runtime never reaches into dashboard.

## Development Discipline

### Versioning (C-23)
Every commit: `v{YYYY}.{MM}.{DD}.{index}.{subindex}: description`
Non-prefixed commits break the dashboard version display.

### Workflow (mandatory — read the workflow file before acting)
1. Edit -> update `infra/manifests/` if adding files -> update `contracts.json` if cross-cutting
2. `/update-git` — stage, commit with version prefix, push
3. Dashboard upgrade button — deploys to VM
4. `/ssh-vm-access` — debug if needed
5. `/firestore-query` — verify state
6. `/finalize-checkpoint` when stable

### Key Rules
- **No secrets in repo** — runtime injection only (C-8)
- **Manifest-driven installs** — files and manifest entries in same commit (C-9)
- **contracts.json** is the single source of truth (C-7) — no hardcoded config values
- **Idempotent everything** — every script safely re-runnable (C-18)
- **Host-native, no containers** — systemd services on bare VMs (C-12)
- **Template-clean** — no operator-specific values in platform files; use `YOUR_GITHUB_ORG`, `your-gcp-project`, `@example.com` placeholders

### Shell Scripts (corekit/)
- `#!/usr/bin/env bash` + `set -euo pipefail`
- GCE metadata auth: `curl -sf -H 'Metadata-Flavor: Google'`
- `python3` for JSON parsing (not jq)
- Values from `contracts.json`, never hardcoded

### PowerShell (local dev)
- SSH: `echo y | gcloud compute ssh {VM} --zone={ZONE} --project=your-gcp-project --tunnel-through-iap --command="..."`
- No `&&` — use `;` to chain commands
- Complex Firestore queries: use SCP script pattern (write script -> scp -> ssh run)

### Dashboard (app/)
- Next.js on Cloud Run, 1health design system (Graphite/Charcoal/Teal/Aqua)
- Deploy: dashboard upgrade button or `gcloud builds submit`
- Firestore conventions: ISO 8601 UTC, lowercase kebab-case IDs, even segment paths

## Canon Quick Reference

### Product Canon Essentials
- **C-1**: Prime is a factory, not an orchestrator
- **C-4**: Everything that can be deterministic IS deterministic
- **C-5**: LLMs think in structured JSON; daemons move the data
- **C-7**: contracts.json is the single source of truth
- **C-9**: Manifest discipline is absolute (file + manifest entry = same commit)
- **C-14**: Eight CoW primitives are a closed set (each an executable contract)
- **C-15**: R->M->C->T always, missions never nest
- **C-24**: Git is the artifact substrate; objects-before-refs
- **C-27**: The mouth is the sole outbound egress
- **C-28**: Layer purity — organ/skill/project/process each hold one purpose; organs are soft-locked ([MODULE_CHARTER](docs/MODULE_CHARTER.md))

### Brain Canon Essentials
- **B-1**: Deterministic machine that consults intelligence
- **B-3**: Each organ has exactly one job
- **B-4**: Context economy — every token earns its place
- **B-16**: Skills are codified procedure (tool syntax in skills, not SOUL files)
- **B-17**: Where a skill exists, skill use is enforced
- **B-18**: Thin orchestrator spine over single-purpose libraries
- **B-28**: Verification is re-derivation, not recognition
- **B-29**: Every claim carries its epistemic bin

## Self-Maintenance

After completing work that changes architecture, conventions, paths, or tooling:
1. Update `.agents/rules/project-context.md` and `coding-standards.md`
2. Update affected workflows in `.agents/workflows/`
3. Update `brain-architecture` skill if brain internals changed
4. These files are loaded every turn — stale context wastes time and causes errors
