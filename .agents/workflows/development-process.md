---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Architect Prime — Development Process

## Project Context

Architect Prime is a **multi-agent GCP VM bootstrap system** built on [OpenClaw](https://github.com/openclaw/openclaw). It uses a public "CoreKit" repo as the single source of truth for agent configuration, workspace personas, and bootstrap scripts. The system deploys a GCP VM running an OpenClaw container with three agent personas: Main (orchestrator), Engineer, and DevOps.

### Key Architecture Constraints
- **No secrets in repo** — all secrets injected at runtime via env vars or GCP Secret Manager
- **Manifest-driven installs** — `manifest.txt` maps repo paths to destination paths on the target VM
- **Checkpoint versioning** — only tagged checkpoints (`v0.1.0`, `cp00X-*`) are considered stable
- **Idempotent** — every script must be safely re-runnable
- **Public repo** — everything here is curl-installable from `raw.githubusercontent.com`

---

## Development Workflow

### 1. Planning a Change (PLAN)
1. Identify the goal and map it to a checkpoint ID (e.g., `cp005-install-script`)
2. Determine which files/components are affected:
   - **Bootstrap scripts** (`bootstrap/`) — infra provisioning
   - **Bundle files** (`bundle/`) — agent config, workspace personas, corekit
   - **Manifest** (`manifest.txt`) — if adding/removing installed files
   - **CI checks** (`workflows/checks.yml`, `bootstrap/checks/`) — safety gates
3. Write a plan with: Goal, Steps, VERIFY commands, ROLLBACK commands
4. If the change is risky (IAM, networking, cost), flag for explicit user approval

### 2. Implementing a Change (BUILD)
1. Create a feature branch: `git checkout -b <feature-name>`
2. Make changes following these rules:
   - New bundle files → add corresponding entry to `manifest.txt`
   - Removed bundle files → remove from `manifest.txt`
   - All shell scripts → must pass `shellcheck` and `forbid-secrets` checks
   - Config templates → use `${VARIABLE}` placeholders (never hardcode secrets/project IDs)
3. Test locally where possible (shellcheck, forbid-secrets)
4. Commit with descriptive messages

### 3. Verifying a Change (VERIFY)

// turbo
```bash
# Run CI checks locally
bash bootstrap/checks/forbid-secrets.sh
bash bootstrap/checks/shellcheck.sh
```

For bootstrap changes, verify by running the one-shot bootstrap against a test GCP project:
```bash
export CORE_REF="<branch-or-sha>"
export PROJECT_ID="<test-project>"
curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/oneshot-cloudshell.sh" | bash
```

### 4. Tagging a Checkpoint
Only after VERIFY passes:
```bash
git tag -a v<X.Y.Z> -m "Checkpoint: <description>"
git push origin v<X.Y.Z>
```

---

## File Layout Reference

```
architect-prime/
├── bootstrap/                    # Human-run infra scripts (NOT in manifest)
│   ├── oneshot-cloudshell.sh     #   Single-command bootstrap
│   ├── phase1-cloudshell.sh      #   SA + VM creation (Cloud Shell)
│   ├── phase2-vm.sh              #   CoreKit install + OpenClaw start (on VM)
│   ├── env.example               #   Template env vars
│   ├── checks/                   #   CI safety checks
│   │   ├── forbid-secrets.sh     #     Grep for secret patterns
│   │   └── shellcheck.sh         #     Lint shell scripts
│   └── README.md
├── bundle/                       # Files installed on VM via manifest
│   ├── corekit/                  #   Core config + tooling
│   │   ├── config/openclaw-bootstrap.json5.tmpl  # OpenClaw config template
│   │   ├── bin/oc                #   CLI wrapper
│   │   ├── bin/bootstrap_smoke.sh #  Smoke test
│   │   ├── exec-approvals.json   #   Non-interactive exec config
│   │   └── README.md
│   ├── openclaw/                 #   Agent runtime files
│   │   └── agents/main/agent/    #     Auth profiles, sessions
│   └── workspaces/               #   Agent persona files
│       ├── main/                 #     Main orchestrator (SOUL, IDENTITY, AGENTS, TOOLS, etc.)
│       ├── engineer/             #     Engineer persona
│       └── devops/               #     DevOps persona
├── manifest.txt                  # Source → destination file mapping
├── workflows/checks.yml          # GitHub Actions CI
├── README.md                     # Project governance & design doc
└── LICENSE
```

---

## Commit & Branch Discipline

- `main` may move forward but is **not guaranteed stable**
- Only checkpoint tags are stable install targets
- Never push directly to main for risky changes — use PRs
- Never modify tags retroactively
- Run `forbid-secrets.sh` before every commit

---

## Agent Model Reference

| Agent | Role | Model | Workspace |
|-------|------|-------|-----------|
| Main | Orchestrator, planning, routing | gemini-2.5-flash | `~/.openclaw/workspace` |
| Engineer | Code, scripts, skills, tests | gemini-3.1-pro-preview | `~/.openclaw/workspace-engineer` |
| DevOps | GCP ops, IAM, deploys, reliability | gemini-3.1-pro-preview | `~/.openclaw/workspace-devops` |

---

## Forbidden Patterns (enforced by CI)

- `BEGIN PRIVATE KEY`, `private_key_id`
- `AIza*` (API keys), `xox*-` (Slack tokens), `sk-*` (OpenAI keys)
- `gcloud iam service-accounts keys create`
- Any `.env` files with real values
