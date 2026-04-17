---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Architect Prime — Development Process

## Project Context

Architect Prime is an **AI agent fleet management system** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP. Each Prime VM runs a Docker-containerized OpenClaw gateway with a single main agent. The Cloud Run dashboard manages state via Firestore, and the `control-daemon` bridges Firestore messages to the OpenClaw gateway API.

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

**Bootstrap / CoreKit / Workspace changes** (no Cloud Run rebuild needed):
```bash
git add -A && git commit -m "description" && git push origin main
# Delete VM + redeploy from dashboard — boot stub curls latest prime-bootstrap.sh from GitHub
```

**Dashboard / API route changes** (requires Cloud Run rebuild):
```bash
cd app && gcloud builds submit --tag us-docker.pkg.dev/$PROJECT_ID/architect-prime/control-plane:latest --project=$PROJECT_ID
gcloud run deploy architect-prime --image=us-docker.pkg.dev/$PROJECT_ID/architect-prime/control-plane:latest --region=us-central1 --project=$PROJECT_ID --allow-unauthenticated
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
│   ├── prime-bootstrap.sh       # Standalone bash (curled by boot stub)
│   └── fleet-bootstrap.sh      # Fleet agent bootstrap (curled by fleet-deploy boot stub)
├── docs/                         # Project documentation
├── manifest.txt                  # Source → destination file mapping
└── README.md
```

---

## Current Agent Model (v2.0)

| VM | Agent | Model | Workspace | Gateway |
|----|-------|-------|-----------|--------|
| Prime | main | gemini-2.5-flash | `~/.openclaw/workspace` | Docker (port 18789) |
| Fleet | {specialty} | gemini-2.5-flash | `~/.openclaw/workspace-fleet` | TBD |

### Key Paths on VM
- OpenClaw root: `/opt/openclaw`
- Config: `/opt/openclaw/.openclaw/openclaw.json`
- CoreKit tools: `/opt/openclaw/.openclaw/bin/`
- Workspace: `/opt/openclaw/.openclaw/workspace/`
- Gateway token: `/root/.openclaw/.gateway-token`

---

## Commit Discipline

- `main` may move forward but is **not guaranteed stable**
- Only tagged versions are stable install targets
- Run build check before every push
- Never push secrets
