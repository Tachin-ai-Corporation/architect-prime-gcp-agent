# Architect Prime — GCP Agent CoreKit

This repository defines the **public, curlable bootstrap contract** for
Architect Prime and its fleet of GCP VM agents.

It contains **no secrets** and is safe to be public.

It is designed to be:
- Installed via `install.sh` (fetches from raw.githubusercontent.com)
- Pinned to versioned checkpoint tags (e.g., `v0.4.0`)
- Self-upgradable by Architect Prime itself
- Used as the pattern for deploying fleet agents within the same GCP project

---

# 1. Purpose

This repo provides:

- Core OpenClaw bootstrap configuration
- Agent persona/workspace seed files
- A manifest-driven file layout (`manifest.txt`)
- A versioned checkpoint model (semver tags)
- A pattern Prime reuses to deploy fleet agents

This repo **does not** contain: service account keys, tokens, project IDs,
internal URLs, or any environment-specific values.

---

# 2. Versioning & Release Discipline

## Checkpoint Tags (Semver)

| Tag | Description |
|---|---|
| `v0.1.0` | CI foundation (forbid-secrets, shellcheck) |
| `v0.2.0` | install.sh + STATE.json + test automation |
| `v0.3.0` | Self-upgrade + drift detection |
| `v0.4.0` | Google Chat integration (chat-send) |
| `v0.5.1` | Chat command loop + inbox-daemon |
| `v0.6.0` | Fleet agent template (multi-project) |
| `v0.7.0` | Agent-ask: LLM + web search (fundamental skill) |

Tags are created after `test-checkpoint.ps1` passes GCP verification checks.

See [MISSION_PLAN.md](MISSION_PLAN.md) for the full roadmap to v1.0.

## Rule for `main`

`main` may move forward with commits, but only checkpoint tags are stable.
Pin to a tag: `CORE_REF=v0.7.0`

---

# 3. Installation Model

`install.sh` fetches `manifest.txt` from GitHub, downloads files, and records
hashes in `STATE.json`. Supports `--check` (drift detection) and
`--upgrade <ref>` (self-upgrade).

---

## Manifest Contract

`manifest.txt` defines file mappings.

Format: `<repo_path> <destination_path>`

Rules:
- Destination paths are relative to `$HOME`
- Installer creates directories if missing
- Installs are idempotent (overwrite safely, repeatable)

---

## Integrity Model

`~/.openclaw/corekit/STATE.json` records coreRef, file hashes, and
install timestamp. Prime can detect drift (`--check`), upgrade
(`--upgrade v0.5.0`), and verify integrity.

---

# 4. Security Model

This repository is public. It must NEVER contain:

- Service account JSON keys or access tokens
- Internal IPs, hostnames, or endpoints
- GCP project IDs or organization IDs
- Secret Manager references or .env files
- API keys (Gemini, xAI, etc.)

If Prime attempts to commit any of the above, it must abort.

## Runtime Secret Injection

Secrets are injected at runtime via environment variables, managed in
GCP Secret Manager, passed into Docker/VM environment, never stored in git.

---

# 5. Repository Structure

    bootstrap/                    # Phase 1 (GCP setup) + Phase 2 (VM startup)
    bundle/corekit/bin/           # oc, chat-send, upgrade-corekit, inbox-daemon
    bundle/corekit/config/        # OpenClaw + Chat config templates
    bundle/workspaces/            # Agent personas (main, engineer, devops)
    cloud-functions/chat-handler/ # Chat → GCS inbox relay
    docs/                         # CHAT_SETUP.md
    install.sh                    # Manifest installer + STATE.json
    manifest.txt                  # File mapping (36+ files)
    test-checkpoint.ps1           # GCP E2E test harness

---

# 6. Self-Maintenance Governance

Architect Prime is expected to:

1. Clone this repo in its GCP VM
2. Create feature branch
3. Modify bundle files
4. Run local validation
5. Open PR
6. Await human approval phrase
7. Merge
8. Create new checkpoint tag

Prime must never push directly to main, modify tags retroactively, or
commit secrets.

---

# 7. Bootstrap Quickstart

See [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) for complete instructions.

    export PROJECT_ID=your-gcp-project-id
    export BILLING_ACCOUNT=your-billing-account-id   # for fleet-deploy
    export GCP_ORG_ID=your-gcp-org-id                # for fleet-deploy
    bash bootstrap/phase1-cloudshell.sh
    # Phase 2 runs automatically on VM boot (~15-20 min)
    # Phase 1 output prints Chat setup instructions

---

# 8. Fleet Architecture (Multi-Project Model)

Each fleet agent runs in its own GCP project with its own Chat app:

    architect-prime-beta/          ← Prime's project
    ├── architect-prime (VM)       ← Fleet orchestrator
    ├── Cloud Function             ← Prime's Chat app
    └── GCS Inbox Bucket           ← Prime's message queue

    fleet-alpha/                   ← Fleet agent's own project
    ├── fleet-alpha (VM)           ← Fleet agent
    ├── Cloud Function             ← Fleet Alpha Chat app
    └── GCS Inbox Bucket           ← Fleet Alpha message queue

**Why multi-project:**
- Direct @-mentions per agent in Chat (`@Fleet Alpha`)
- Clean auth (each agent's SA owns its Chat app)
- Simple teardown (delete project = delete everything)
- Independent scaling and billing

**Deploy/Teardown:**

    # From Prime VM:
    fleet-deploy --name myagent --specialty "billing expert"
    fleet-teardown --name myagent   # deletes entire project

---

# 9. Design Principles

- Public, no secrets
- Deterministic, idempotent installs
- Self-upgradable (drift detection + upgrade)
- Agent-maintainable (PR → approve → merge → tag)
- Human-auditable (Chat relay, GCS audit trail)
- Multi-project fleet (independent projects, direct Chat @-mentions)

