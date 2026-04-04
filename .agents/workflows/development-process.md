---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Architect Prime — Development Process

## Project Context

Architect Prime is an **AI agent fleet management system** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP. It uses a public "CoreKit" repo as the single source of truth for agent configuration, workspace personas, and bootstrap scripts. Each VM runs an OpenClaw gateway with a single main agent.

### Key Architecture Constraints
- **No secrets in repo** — all secrets injected at runtime via env vars or GCP metadata
- **Manifest-driven installs** — `manifest.txt` maps repo paths to destination paths on the target VM
- **Checkpoint versioning** — only tagged checkpoints (`v1.x.x`, `v2.x.x`) are considered stable
- **Idempotent** — every script must be safely re-runnable
- **Public repo** — everything here is curl-installable from `raw.githubusercontent.com`

---

## Development Workflow

### 1. Planning a Change (PLAN)
1. Identify the goal and map it to a version or checkpoint
2. Determine which files/components are affected:
   - **Bundle files** (`bundle/`) — agent config, workspace personas, corekit
   - **Manifest** (`manifest.txt`) — if adding/removing installed files
   - **App** (`app/`) — dashboard UI, API routes
   - **Deploy** (`deploy/`) — installation scripts
3. Write a plan with: Goal, Steps, VERIFY commands, ROLLBACK commands
4. If the change is risky (IAM, networking, cost), flag for explicit user approval

### 2. Implementing a Change (BUILD)
1. Make changes following these rules:
   - New bundle files → add corresponding entry to `manifest.txt`
   - Removed bundle files → remove from `manifest.txt`
   - Config templates → use `${VARIABLE}` placeholders (never hardcode secrets/project IDs)
2. Test locally where possible (build check, lint)
3. Commit with descriptive messages

### 3. Verifying a Change (VERIFY)

// turbo
```bash
# Build check
cd app && npx next build
```

### 4. Deploying a Change
```bash
# Build + deploy Cloud Run
cd app && gcloud builds submit --tag us-docker.pkg.dev/$PROJECT_ID/architect-prime/control-plane:latest --project=$PROJECT_ID
gcloud run deploy architect-prime --image=us-docker.pkg.dev/$PROJECT_ID/architect-prime/control-plane:latest --region=us-central1 --project=$PROJECT_ID

# Push + update VMs (CoreKit changes)
git add -A && git commit -m "description" && git push origin main
# VMs re-install CoreKit on next deploy/upgrade
```

---

## File Layout Reference

```
architect-prime/
├── app/                          # Cloud Run control plane (Next.js)
│   ├── src/app/page.tsx          # Dashboard UI
│   ├── src/app/api/              # REST API routes
│   ├── src/lib/                  # Firestore, auth utilities
│   └── Dockerfile
├── bundle/                       # Files installed on VM via manifest
│   ├── corekit/                  # Core config + tooling
│   │   ├── config/               # OpenClaw bootstrap, agent-types, etc.
│   │   └── bin/                  # CLI tools (fleet-deploy, control-daemon, etc.)
│   ├── openclaw/                 # Agent runtime files (auth profiles, sessions)
│   └── workspaces/               # Agent persona files
│       ├── main/                 # Prime agent (SOUL, IDENTITY, TOOLS, MEMORY)
│       └── fleet/                # Fleet agent template
├── deploy/                       # Installation scripts
│   ├── install.sh
│   └── uninstall.sh
├── bootstrap/                    # VM startup scripts
├── docs/architecture/            # Future architecture specs
├── manifest.txt                  # Source → destination file mapping
└── README.md
```

---

## Current Agent Model (v2.0)

| VM | Agent | Model | Workspace |
|----|-------|-------|-----------|
| Prime | main | gemini-2.5-flash | `~/.openclaw/workspace` |
| Fleet | {specialty} | gemini-2.5-flash | `~/.openclaw/workspace-fleet` |

---

## Commit Discipline

- `main` may move forward but is **not guaranteed stable**
- Only tagged versions are stable install targets
- Run build check before every push
- Never push secrets
