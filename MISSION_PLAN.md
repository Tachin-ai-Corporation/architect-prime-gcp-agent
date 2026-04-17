# Architect Prime â€” Mission Plan

> **Living document.** Updated at each checkpoint. Tracks completed milestones, current status, and the roadmap forward.

---

## Vision

Architect Prime is a **self-bootstrapping agent factory** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

**Current Status:** v2.0 fleet lifecycle hardened. Checkpoint 6 complete â€” full hire/fire/re-hire verified for both `stan` (DevOps) and `anora` (PM). Fleet-bootstrap rewritten with retry logic, Prime API status relay, and IAM permission fix. Next milestone: Checkpoint 7 â€” richer agent specialties + fleet health monitoring.

---

## Completed Checkpoints

### v0.1.0 â€” CI Foundation
> *Tagged: 2026-03-01*

- [x] GitHub Actions CI (`checks.yml`)
- [x] `forbid-secrets.sh` â€” blocks commits containing keys, tokens, or credentials
- [x] `shellcheck.sh` â€” lints all shell scripts
- [x] Public repo discipline established (no secrets, ever)

---

### v0.2.0 â€” Manifest Installer + Integrity Tracking
> *Tagged: 2026-03-01*

- [x] `install.sh` â€” idempotent manifest-driven installer
- [x] `manifest.txt` â€” maps repo paths â†’ VM destination paths
- [x] `STATE.json` â€” provenance + SHA-256 file hashes after install
- [x] `--check` mode (drift detection) and `--upgrade <ref>` mode
- [x] `test-checkpoint.ps1` â€” GCP E2E test harness
- [x] Portable SHA-256 (sha256sum â†’ shasum â†’ openssl fallback)

---

### v0.3.0 â€” Self-Upgrade + Drift Detection
> *Tagged: 2026-03-01*

- [x] `upgrade-corekit` script â€” in-place upgrade to a new checkpoint ref
- [x] Drift detection (`install.sh --check`) compares live files against STATE.json
- [x] Upgrade path: `install.sh --upgrade v0.X.0` re-installs from new ref
- [x] Agent can detect and fix its own file drift

---

### v0.4.0 â€” Google Chat Integration
> *Tagged: 2026-03-02*

- [x] `chat-send` â€” sends text and card messages via Chat API using ADC
- [x] Auto-announce on boot ("Architect Prime is online")
- [x] Chat space ID resolution from env var or `chat-config.json`
- [x] Card message support (`--card <title> <body>`)

---

### v0.5.1 â€” Chat Command Loop + Inbox Daemon
> *Tagged: 2026-03-02*

- [x] Cloud Function `chat-handler` â€” receives Chat webhooks, writes to GCS inbox
- [x] `inbox-daemon` â€” systemd service, polls GCS, processes messages one-at-a-time
- [x] Built-in commands: `help`, `status`, `whoami`, `fleet`
- [x] Message lifecycle: pending â†’ processing â†’ done (GCS folders)
- [x] Full message loop closed: human â†’ Chat â†’ GCS â†’ daemon â†’ response â†’ Chat

---

### v0.6.0 â€” Fleet Agent Template (Multi-Project)
> *Tagged: 2026-03-03*

- [x] `fleet-deploy` â€” creates an entire GCP project for each fleet agent
- [x] `fleet-teardown` â€” deletes the fleet agent's entire GCP project
- [x] `fleet-registry.json` â€” Prime tracks all fleet agents
- [x] Fleet agents self-install CoreKit via `install.sh` on boot
- [x] Dynamic identity: agent name, specialty injected via VM metadata

---

### v0.7.0 â€” Agent-Ask: The Fundamental Skill
> *Tagged: 2026-03-11*

- [x] `agent-ask` â€” core LLM skill using Vertex AI Gemini + Google Search grounding
- [x] `build-system-prompt` â€” assembles system prompt from workspace files (SOUL, MEMORY, IDENTITY)
- [x] Non-command Chat messages auto-routed to LLM for intelligent answers
- [x] Fleet agents inherit `agent-ask` via shared CoreKit install

---

### v0.7.1 â€” DWD Chat Migration + Bootstrap Hardening
> *Tagged: 2026-03-22*

- [x] **DWD Migration** â€” replaced Cloud Functions + GCS inbox with Domain-Wide Delegation
  - `dwd-token` â€” keyless DWD via VM metadata `signJwt`
  - `chat-send` â€” rewritten for DWD impersonation
  - `chat-read` â€” new script: reads messages via DWD
  - `inbox-daemon` â€” polls Chat API directly
- [x] **Interactive bootstrap** â€” guided `bootstrap.sh` with env var prompts
- [x] **Phase 2 hardening** â€” deterministic gateway readiness poll loop

---

### v0.8.0â€“v0.9.3 â€” Cloud Run Control Plane + Dashboard
> *Tagged: 2026-03-29 â€“ 2026-04-01*

- [x] **Next.js Cloud Run control plane** â€” dashboard UI with chat, fleet, and setup tabs
- [x] **Firestore state management** â€” primes, messages, fleet records, DWD config
- [x] **Dashboard â†’ Prime chat** â€” real-time messages via Firestore polling
- [x] **Fleet hire/fire from dashboard** â€” wizard modal, API routes, Firestore records
- [x] **DWD setup wizard** â€” guided setup with test button
- [x] **Fleet agent logs** â€” real-time log streaming from VM serial ports
- [x] **Version display + upgrade button** â€” dashboard footer

---

### v2.0.0 â€” OpenClaw Pivot
> *Completed: 2026-04-11*

- [x] **OpenClaw integration** â€” each Prime VM runs a Docker-containerized OpenClaw gateway
- [x] **Boot stub pattern** â€” startup script is a standalone `.sh` file on GitHub, not embedded in JS
- [x] **Docker-based bootstrap** â€” `get.docker.com` â†’ `DOCKER_BUILDKIT=1` image build â†’ `--network host` container
- [x] **RPC config apply** â€” bootstrap config applied via `docker exec ... config.apply` with retry + baseHash
- [x] **control-daemon** â€” Firestore message bridge (polls Firestore â†’ routes to OpenClaw gateway API)
- [x] **Machine upgrade** â€” e2-medium (4GB) for Docker build memory requirements
- [x] **Workspace files** â€” SOUL.md, TOOLS.md, MEMORY.md deployed via CoreKit manifest
- [x] **Vertex AI ADC authentication** â€” GCE metadata-based ADC working via model-auth-env patch
- [x] **E2E verification** â€” dashboard â†’ Firestore â†’ control-daemon â†’ OpenClaw â†’ Vertex AI â†’ response displayed in dashboard
- [x] **Fleet hire through OpenClaw** â€” "hire a devops agent named testbot" â†’ exec fleet-deploy â†’ VM created in GCP
- [x] **Fleet agents on OpenClaw** â€” fleet-bootstrap.sh deploys full OpenClaw + ADC fix + inbox-daemon on fleet VMs

---

### Checkpoint 5: DWD Google Chat Verification â€” HARDENED
> *Completed: 2026-04-07*

- [x] **inbox-daemon rewrite** â€” complete from-scratch rewrite for robustness
  - High-water-mark dedup (monotonic timestamp, replaces fragile time-window cutoff)
  - Atomic `check_and_mark` before processing (not after) â€” prevents duplicate responses
  - Collects messages to file, iterates with `< file` (not pipe subshell) â€” no shell-level race
  - Never sends error/empty responses to Chat â€” logs only
  - Removed built-in commands (help/status/whoami) â€” OpenClaw handles everything
  - State in `/var/lib/inbox-daemon/` (survives reboots, not in /tmp)
  - Poll interval: 15s, space discovery: 5min cache
- [x] **inbox-daemon â†’ OpenClaw gateway** â€” routes Chat messages to `/v1/chat/completions` instead of legacy `agent-ask`
- [x] **@-mention filtering** â€” deterministic message filtering using agent's Workspace First/Last name
- [x] **OpenClaw heartbeat disabled** â€” config + `openclaw system heartbeat disable` at process level
- [x] **Fleet agent identity fix** â€” DevOps SOUL.md/IDENTITY.md with strong identity + template vars
- [x] **Fleet agent `stan` deployed** â€” `devops-agent-stan@tachin.ai` on `fleet-stan` VM
- [x] **E2E Chat verified** â€” single response, correct DevOps identity, no spam, no self-replies
- [x] **Admin setup instructions** â€” fleet-deploy outputs exact First Name, Last Name, Email

> **Issues found & fixed (9 total):**
> 1. OpenClaw heartbeat spams Chat every 10s â†’ disabled via config + process-level disable
> 2. Old inbox-daemon sent 3 duplicates per message â†’ rewrote with atomic dedup + high-water mark
> 3. Fleet agents inherit Prime's identity â†’ workspace clearing + strong DevOps SOUL
> 4. `fleet-deploy: command not found` â†’ must use full path
> 5. inbox-daemon error messages sent to Chat â†’ new daemon never sends errors
> 6. Self-reply feedback loop: DWD messages have empty sender.email â†’ @-mention filter
> 7. Heartbeat feedback loop: inbox-daemon processed own HEARTBEAT_OK â†’ @-mention filter
> 8. @-mention stripping only removed first word â†’ strips full `@FirstName LastName`
> 9. upgrade-corekit overwrites fleet workspace â†’ auto-restores specialty workspace after install

---

### Checkpoint 5.1: inbox-daemon Hotfix
> *Completed: 2026-04-11*

- [x] **Heredoc stdin bug** â€” `call_openclaw()` used `python3 << 'PYEOF'` which steals stdin from the pipe
  - `sys.stdin.read()` always returned empty â†’ `sys.exit(1)` â†’ crash
  - Root cause: bash heredocs redirect fd 0, so `echo "$text" | python3 << 'PYEOF'` loses the pipe
  - Fix: pass message text via `OC_MSG_TEXT` environment variable instead of stdin
- [x] **Crash resilience** â€” `set -eo pipefail` made `call_openclaw` failures fatal to the entire daemon
  - Any non-zero exit killed the systemd service, triggering a restart loop
  - Fix: wrap `call_openclaw` in `if` block, log warnings on failure instead of crashing
- [x] **Error diagnostics** â€” added stderr capture for OpenClaw errors
- [x] **Deployed to fleet-stan** â€” verified: message processed in ~17s, 1305 char reply sent via DWD
- [x] **Committed & pushed** â€” `b390706b` on `main`, all future fleet agents inherit the fix

---

### Checkpoint 6: Fleet Lifecycle Hardening
> *Completed: 2026-04-17*

Full hire â†’ fire â†’ re-hire lifecycle verified for multiple agents (`stan`, `anora`). Root cause analysis of persistent 403 PERMISSION_DENIED errors led to a multi-layer fix across fleet-deploy, fleet-teardown, fleet-bootstrap, and Prime VM IAM configuration.

#### Root Cause Analysis

The 403 errors had **three compounding causes**, each masking the next:

1. **SA deletion on teardown** â€” `fleet-teardown` deleted the service account on every fire. Re-hiring created a new SA with a different UID, but IAM bindings were still attached to the old (deleted) UID.
2. **IAM grants silently failed** â€” `fleet-deploy` swallowed IAM grant errors (`> /dev/null 2>&1`), so failures were invisible.
3. **Prime VM lacks IAM admin permission** â€” The true root cause discovered last: Prime's compute SA (`92079628910-compute@developer.gserviceaccount.com`) did not have `roles/resourcemanager.projectIamAdmin`. **Every `gcloud projects add-iam-policy-binding` in fleet-deploy had silently failed from day one.** All prior successful IAM grants were manual interventions.

#### Fixes Applied

- [x] **fleet-teardown** â€” stop deleting SA on fire. Only delete VM + disk (the cost items). SA is free and preserves IAM bindings across fire/re-hire cycles.
- [x] **fleet-deploy** â€” hardened IAM grant logic:
  - 30s SA propagation wait before granting
  - Verify SA exists before granting roles
  - Log IAM grant errors (no more silent swallowing)
  - Post-grant verification via `get-iam-policy`
  - Auto-retry on verification failure
  - Resolve Cloud Run URL for fleet-bootstrap status relay
  - Pass `dashboard_url` as VM metadata
- [x] **fleet-bootstrap.sh** â€” complete rewrite:
  - Extracted `wait_gateway()` function (was duplicated twice)
  - Smoke test retries 3x with backoff (was `curl -sf` silently failing)
  - Status self-report via Prime's API (`update-status` endpoint) â€” no fleet SA Datastore permission needed
  - Uses original `MY_TOKEN` variable (was re-reading from config file)
  - 15s settling delay after gateway restart before smoke test
- [x] **fleet-monitor** â€” increased timeout from 20min â†’ 30min (bootstrap takes ~25min with added safety steps)
- [x] **Prime VM IAM** â€” granted `roles/resourcemanager.projectIamAdmin` to compute SA
- [x] **New API endpoint** â€” `POST /api/primes/[id]/fleet/update-status` â€” relay endpoint for fleet VMs to report status through Prime's Firestore credentials

#### Verification

- [x] Stan: hire â†’ chat â†’ fire â†’ re-hire â†’ chat âœ…
- [x] Anora: hire â†’ chat â†’ fire â†’ re-hire â†’ chat âœ…
- [x] Dashboard shows correct status without manual intervention âœ…
- [x] Smoke test passes on fresh deploy âœ…
- [x] IAM grants verified from Prime VM (not local machine) âœ…

> **Issues found & fixed (6 total):**
> 1. SA deleted on teardown â†’ IAM bindings lost on re-hire â†’ preserved SA
> 2. IAM grant errors silently swallowed â†’ logged + verified + retried
> 3. Prime VM can't grant IAM roles â†’ granted `projectIamAdmin` to compute SA
> 4. Fleet-bootstrap Firestore write â†’ 403 (no `datastore.user`) â†’ relay through Prime API
> 5. Smoke test `curl -sf` silently fails â†’ `curl -s --max-time 30` + retry 3x
> 6. Fleet-monitor 20min timeout too short â†’ increased to 30min

---

## What Works Today

| Component | Status | Notes |
|-----------|--------|-------|
| Cloud Run dashboard | âœ… Online | Chat, fleet, setup tabs |
| Prime VM bootstrap | âœ… Working | Boot stub â†’ `prime-bootstrap.sh` from GitHub |
| OpenClaw container | âœ… Running | Docker, `--network host`, port 18789 |
| Vertex AI ADC auth | âœ… Working | GCE metadata â†’ OAuth2, patched model-auth-env |
| control-daemon | âœ… Running | systemd, polls Firestore every 5s |
| inbox-daemon (fleet) | âœ… Hardened | @-mention filter, dedup, env var text passing, crash resilience |
| Bootstrap config | âœ… Applied | RPC config.apply with retry/baseHash |
| CoreKit tools | âœ… Installed | fleet-deploy, fleet-teardown, upgrade-corekit |
| Dashboard E2E chat | âœ… Working | Full round-trip verified |
| Fleet hire via dashboard | âœ… Hardened | Wizard â†’ fleet-deploy â†’ VM + IAM + Firestore |
| Fleet fire/re-hire | âœ… Hardened | SA preserved, IAM persists, status self-reports |
| Fleet DWD Chat | âœ… Hardened | @-mention â†’ inbox-daemon â†’ OpenClaw â†’ single reply |
| Fleet agent identity | âœ… Correct | Strong specialty SOUL, survives CoreKit upgrades |
| Fleet IAM grants | âœ… Verified | Prime VM now has projectIamAdmin, grants verified |
| Fleet status self-report | âœ… Working | Bootstrap â†’ Prime API â†’ Firestore (no fleet SA needed) |

---

## Next Steps

### Checkpoint 7: Agent Specialties + Fleet Health
> *Goal: Richer agent capabilities and automated fleet monitoring*

1. **Richer specialty workspaces** â€” expanded SOUL.md, TOOLS.md, and MEMORY.md per specialty (DevOps, PM, etc.)
2. **Fleet health monitoring** â€” Prime periodically checks fleet agent health via fleet-verify
3. **Auto-recovery** â€” detect and restart failed fleet agents
4. **Cost governance** â€” per-agent spend tracking, auto-hibernate idle agents
5. **Fleet upgrade** â€” `fleet-upgrade` command to update a running agent's CoreKit without rebuilding

---

## Post-v2.0 â€” Future Capabilities

### Mid-term (v3.0)
- **Brain sub-agents** â€” OpenClaw multi-agent system (Cortex, Prefrontal, Hippocampus)
- **Checkpoint queue** â€” R/C/M framework (Responsibilities, Checkpoints, Missions)
- **Agent memory system** â€” persistent memory across sessions
- **Inter-agent delegation** â€” agents @-mention other agents to delegate tasks

### Long-term (v4.0+)
- **Google Workspace skills** â€” Docs, Sheets, Calendar, Gmail integration
- **Agent cell templates** â€” pre-built team configurations
- **Self-evolution** â€” Prime proposes its own improvements via PR
- **Multi-project federation** â€” fleet agents across different GCP projects

---

## Architecture Summary

```
Dashboard (Cloud Run)
    â”‚
    â”œâ”€ POST /api/primes/{id}/deploy  â†’ Creates GCE VM with boot stub
    â”œâ”€ POST /api/primes/{id}/messages â†’ Writes to Firestore
    â”œâ”€ POST /api/primes/{id}/fleet/update-status â†’ Fleet VM status relay
    â””â”€ GET  /api/primes/{id}/fleet   â†’ Reads fleet from Firestore
         â”‚
         â–¼
    Firestore (state store)
         â”‚
         â–¼
    Prime VM (e2-medium)
    â”œâ”€â”€ control-daemon (systemd)
    â”‚   â””â”€â”€ Polls Firestore messages â†’ POST to OpenClaw gateway
    â”‚
    â”œâ”€â”€ openclaw-gateway (Docker, --network host, port 18789)
    â”‚   â”œâ”€â”€ Main agent (Gemini 2.5 Flash via ADC)
    â”‚   â”œâ”€â”€ Workspace: SOUL.md, TOOLS.md, MEMORY.md
    â”‚   â”œâ”€â”€ Tools: exec (fleet-deploy, fleet-teardown, etc.)
    â”‚   â””â”€â”€ Session memory + context pruning
    â”‚
    â””â”€â”€ CoreKit (manifest-installed)
        â”œâ”€â”€ fleet-deploy / fleet-teardown / fleet-monitor
        â”œâ”€â”€ agent-ask, build-system-prompt
        â”œâ”€â”€ inbox-daemon, chat-send, chat-read
        â””â”€â”€ dwd-token, upgrade-corekit

    Fleet Agent VMs (e2-medium, one per agent)
    â”œâ”€â”€ openclaw-gateway (Docker, --network host, port 18789)
    â”‚   â”œâ”€â”€ Specialty agent (Gemini 2.5 Flash via ADC)
    â”‚   â”œâ”€â”€ Workspace: specialty SOUL.md, TOOLS.md
    â”‚   â””â”€â”€ ADC fix (same model-auth-env patch as Prime)
    â”‚
    â”œâ”€â”€ inbox-daemon (systemd)
    â”‚   â””â”€â”€ Polls Google Chat via DWD â†’ POST to OpenClaw gateway
    â”‚
    â””â”€â”€ CoreKit (manifest-installed from same repo)
        â””â”€â”€ Status self-reports to Prime API on bootstrap completion
```

---

## Principles

1. **No secrets in repo** â€” all secrets injected at runtime via ADC, DWD signJwt, or GCP metadata
2. **Manifest-driven** â€” `manifest.txt` is the single source of truth for installed files
3. **Boot stub pattern** â€” startup scripts live as real `.sh` files on GitHub, not in JS template literals
4. **OpenClaw-native** â€” leverage the framework's agent loop, tools, memory, and session management
5. **Idempotent** â€” every script safely re-runnable
6. **Self-upgradable** â€” drift detection + in-place upgrade
7. **Human-auditable** â€” all communication logged in Firestore
8. **Fail loud** â€” IAM grants, smoke tests, and status writes log errors visibly (never silently swallow)

