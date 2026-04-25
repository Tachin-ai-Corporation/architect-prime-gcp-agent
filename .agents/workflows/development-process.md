---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Architect Prime — Development Process

## Project Context

Architect Prime is an **AI agent fleet management system** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP. Each Prime VM runs a Docker-containerized OpenClaw gateway with a multi-agent brain (cortex + 5 sub-agents). The Cloud Run dashboard manages state via Firestore, and the `control-daemon` bridges Firestore messages to the OpenClaw gateway API.

### Key Architecture Constraints
- **No secrets in repo** — all secrets injected at runtime via env vars or GCP metadata
- **Manifest-driven installs** — `infra/manifests/` maps repo paths to destination paths on target VMs
- **contracts.json** — single source of truth for cross-cutting values (model versions, OpenClaw pin, gateway config)
- **Idempotent** — every script must be safely re-runnable
- **Public repo** — everything here is curl-installable from `raw.githubusercontent.com`

---

## Project Layout (v5.2)

```
architect-prime/
├── app/                           # Cloud Run control plane (Next.js)
│   ├── src/app/page.tsx           # Dashboard UI
│   ├── src/app/api/               # REST API routes
│   └── Dockerfile
├── infra/                         # Infrastructure
│   ├── bootstrap/                 # VM startup scripts (prime-bootstrap.sh, fleet-bootstrap.sh)
│   ├── manifests/                 # File mapping fragments (base.txt, role-prime.txt, role-fleet.txt, job-*.txt)
│   ├── contracts.json             # Cross-cutting values (OpenClaw pin, Vertex AI config, agent IDs)
│   └── install.sh                 # Manifest installer (--role prime|fleet --job devops|swe)
├── corekit/                       # Runtime tools installed on VMs
│   ├── brain/                     # brain-exec, agent-ask, telemetry, compliance hooks
│   ├── fleet/                     # fleet-hire, fleet-fire, fleet-status, fleet-verify, fleet-upgrade
│   ├── gateway/                   # render-config, discover-models, upgrade-openclaw
│   ├── chat/                      # inbox-daemon, chat-send, chat-read, dwd-token
│   ├── memory/                    # core-memory-read, core-memory-write, update-deep-truths
│   ├── dashboard/                 # control-daemon, command-runner, dashboard-respond
│   ├── system/                    # upgrade-corekit, validate-contracts, web-search
│   └── config/                    # openclaw-bootstrap.json5.tmpl, agent-types.json
├── brain/                         # Agent workspace files
│   ├── prime/cortex/              # SOUL.md, IDENTITY.md, TOOLS.md, MEMORY.md, BRAIN_CARD.md
│   ├── prime/temporal-research/   # Sub-agent workspace
│   └── ...                        # Other sub-agents
├── specialties/                   # Fleet agent specialty configs
├── skills/                        # OpenClaw skill manifests (agent-ask, fleet-*)
└── docs/                          # Architecture docs
```

---

## Development Workflow

### 1. Plan
1. Identify the goal and map it to a version
2. Determine affected modules (corekit, brain, infra, app)
3. If adding/removing installed files → update manifests in `infra/manifests/`

### 2. Build
1. Edit files following these rules:
   - New CoreKit scripts → add to appropriate manifest (`role-prime.txt`, `base.txt`, etc.)
   - Config templates → use `${VARIABLE}` placeholders (never hardcode secrets/project IDs)
   - Brain workspace changes → update SOUL.md, TOOLS.md, BRAIN_CARD.md together
2. Cross-cutting values → edit `contracts.json` (never hardcode in scripts)

### 3. Deploy

Use the `/deploy-corekit` workflow for CoreKit/brain changes.
Use the Cloud Run rebuild commands for dashboard/API changes.

### 4. Verify

Use the `/brain-verification` workflow for brain dispatch testing.
Use the `/firestore-query` workflow for state inspection.

---

## Related Workflows
- `/ssh-vm-access` — SSH into Prime/Fleet VMs
- `/deploy-corekit` — Push + upgrade CoreKit on VMs
- `/firestore-query` — Debug Firestore state
- `/brain-verification` — Test brain dispatch end-to-end

---

## Commit Discipline
- `main` may move forward but is **not guaranteed stable**
- Only tagged versions are stable install targets
- Run build check before every push for app/ changes
- Never push secrets
