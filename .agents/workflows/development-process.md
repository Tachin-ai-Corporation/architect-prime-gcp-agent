---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Development Process

## Constraints
- **No secrets in repo** — runtime injection via env vars or GCP metadata
- **Manifest-driven** — `infra/manifests/` maps repo paths to VM destinations
- **contracts.json** — single source of truth for cross-cutting values
- **Idempotent** — every script safely re-runnable
- **Public repo** — curl-installable from `raw.githubusercontent.com`

## Project Layout

```
architect-prime/
├── app/              # Cloud Run dashboard (Next.js)
├── infra/            # Bootstrap scripts, manifests, contracts.json
├── corekit/          # Runtime tools (brain, fleet, gateway, chat, dashboard, memory)
├── brain/            # Agent workspace files (SOUL.md, TOOLS.md, BRAIN_CARD.md)
├── specialties/      # Fleet agent specialty configs
├── skills/           # OpenClaw skill manifests
└── docs/             # Architecture docs
```

## Workflow

1. **Edit** — Make changes in the appropriate module
2. **Manifest** — If adding/removing installed files, update `infra/manifests/`
3. **Contracts** — If changing cross-cutting values, update `contracts.json`
4. **Push** — `/update-git`
5. **Deploy** — Dashboard upgrade button
6. **Debug** — `/ssh-vm-access` if something breaks
7. **Verify** — `/firestore-query` to check state

## Key Paths on VM
- OpenClaw root: `/opt/openclaw`
- Config: `/opt/openclaw/.openclaw/openclaw.json`
- CoreKit tools: `/opt/openclaw/.openclaw/bin/`
- Workspace: `/opt/openclaw/.openclaw/workspace/`
- Gateway token: `/root/.openclaw/.gateway-token`

## Cloud Run deploy (app/ changes only)
```bash
cd app; gcloud builds submit --tag us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --project=architect-prime-beta
gcloud run deploy architect-prime --image=us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --region=us-central1 --project=architect-prime-beta --allow-unauthenticated
```
