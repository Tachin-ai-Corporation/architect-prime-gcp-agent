# Architect Prime — Mission Plan

> **Living document.** Updated at each checkpoint. Tracks completed milestones, current status, and the roadmap forward.

---

## Vision

Architect Prime is a **self-bootstrapping agent factory** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

**Current Status:** OpenClaw integration complete. Prime deploys as a Docker-containerized OpenClaw instance with a full AI brain, managed via a Cloud Run dashboard. Fleet lifecycle (hire/fire) is functional through OpenClaw exec tools. End-to-end message flow (Dashboard → Firestore → control-daemon → OpenClaw → response) is operational.

---

## Completed Checkpoints

### v0.1.0 — CI Foundation
> *Tagged: 2026-03-01*

- [x] GitHub Actions CI (`checks.yml`)
- [x] `forbid-secrets.sh` — blocks commits containing keys, tokens, or credentials
- [x] `shellcheck.sh` — lints all shell scripts
- [x] Public repo discipline established (no secrets, ever)

---

### v0.2.0 — Manifest Installer + Integrity Tracking
> *Tagged: 2026-03-01*

- [x] `install.sh` — idempotent manifest-driven installer
- [x] `manifest.txt` — maps repo paths → VM destination paths
- [x] `STATE.json` — provenance + SHA-256 file hashes after install
- [x] `--check` mode (drift detection) and `--upgrade <ref>` mode
- [x] `test-checkpoint.ps1` — GCP E2E test harness
- [x] Portable SHA-256 (sha256sum → shasum → openssl fallback)

---

### v0.3.0 — Self-Upgrade + Drift Detection
> *Tagged: 2026-03-01*

- [x] `upgrade-corekit` script — in-place upgrade to a new checkpoint ref
- [x] Drift detection (`install.sh --check`) compares live files against STATE.json
- [x] Upgrade path: `install.sh --upgrade v0.X.0` re-installs from new ref
- [x] Agent can detect and fix its own file drift

---

### v0.4.0 — Google Chat Integration
> *Tagged: 2026-03-02*

- [x] `chat-send` — sends text and card messages via Chat API using ADC
- [x] Auto-announce on boot ("Architect Prime is online")
- [x] Chat space ID resolution from env var or `chat-config.json`
- [x] Card message support (`--card <title> <body>`)

---

### v0.5.1 — Chat Command Loop + Inbox Daemon
> *Tagged: 2026-03-02*

- [x] Cloud Function `chat-handler` — receives Chat webhooks, writes to GCS inbox
- [x] `inbox-daemon` — systemd service, polls GCS, processes messages one-at-a-time
- [x] Built-in commands: `help`, `status`, `whoami`, `fleet`
- [x] Message lifecycle: pending → processing → done (GCS folders)
- [x] Full message loop closed: human → Chat → GCS → daemon → response → Chat

---

### v0.6.0 — Fleet Agent Template (Multi-Project)
> *Tagged: 2026-03-03*

- [x] `fleet-deploy` — creates an entire GCP project for each fleet agent
- [x] `fleet-teardown` — deletes the fleet agent's entire GCP project
- [x] `fleet-registry.json` — Prime tracks all fleet agents
- [x] Fleet agents self-install CoreKit via `install.sh` on boot
- [x] Dynamic identity: agent name, specialty injected via VM metadata

---

### v0.7.0 — Agent-Ask: The Fundamental Skill
> *Tagged: 2026-03-11*

- [x] `agent-ask` — core LLM skill using Vertex AI Gemini + Google Search grounding
- [x] `build-system-prompt` — assembles system prompt from workspace files (SOUL, MEMORY, IDENTITY)
- [x] Non-command Chat messages auto-routed to LLM for intelligent answers
- [x] Fleet agents inherit `agent-ask` via shared CoreKit install

---

### v0.7.1 — DWD Chat Migration + Bootstrap Hardening
> *Tagged: 2026-03-22*

- [x] **DWD Migration** — replaced Cloud Functions + GCS inbox with Domain-Wide Delegation
  - `dwd-token` — keyless DWD via VM metadata `signJwt`
  - `chat-send` — rewritten for DWD impersonation
  - `chat-read` — new script: reads messages via DWD
  - `inbox-daemon` — polls Chat API directly
- [x] **Interactive bootstrap** — guided `bootstrap.sh` with env var prompts
- [x] **Phase 2 hardening** — deterministic gateway readiness poll loop

---

### v0.8.0–v0.9.3 — Cloud Run Control Plane + Dashboard
> *Tagged: 2026-03-29 – 2026-04-01*

- [x] **Next.js Cloud Run control plane** — dashboard UI with chat, fleet, and setup tabs
- [x] **Firestore state management** — primes, messages, fleet records, DWD config
- [x] **Dashboard → Prime chat** — real-time messages via Firestore polling
- [x] **Fleet hire/fire from dashboard** — wizard modal, API routes, Firestore records
- [x] **DWD setup wizard** — guided setup with test button
- [x] **Fleet agent logs** — real-time log streaming from VM serial ports
- [x] **Version display + upgrade button** — dashboard footer

---

### v2.0.0 — OpenClaw Pivot (Current)
> *In progress: 2026-04-01 – present*

- [x] **OpenClaw integration** — each Prime VM runs a Docker-containerized OpenClaw gateway
- [x] **Boot stub pattern** — startup script is a standalone `.sh` file on GitHub, not embedded in JS
- [x] **Docker-based bootstrap** — `get.docker.com` → `DOCKER_BUILDKIT=1` image build → `--network host` container
- [x] **RPC config apply** — bootstrap config applied via `docker exec ... config.apply` with retry + baseHash
- [x] **control-daemon** — Firestore message bridge (polls Firestore → routes to OpenClaw gateway API)
- [x] **Machine upgrade** — e2-medium (4GB) for Docker build memory requirements
- [x] **Workspace files** — SOUL.md, TOOLS.md, MEMORY.md deployed via CoreKit manifest
- [x] **Vertex AI ADC authentication** — GCE metadata-based ADC working via model-auth-env patch
- [x] **E2E verification** — dashboard → Firestore → control-daemon → OpenClaw → Vertex AI → response displayed in dashboard
- [x] **Fleet hire through OpenClaw** — "hire a devops agent named testbot" → exec fleet-deploy → VM created in GCP
- [x] **Fleet agents on OpenClaw** — fleet-bootstrap.sh deploys full OpenClaw + ADC fix + inbox-daemon on fleet VMs

---

## What Works Today

| Component | Status | Notes |
|-----------|--------|-------|
| Cloud Run dashboard | ✅ Online | Chat, fleet, setup tabs |
| Prime VM bootstrap | ✅ Working | Boot stub → `prime-bootstrap.sh` from GitHub |
| OpenClaw container | ✅ Running | Docker, `--network host`, port 18789 |
| Vertex AI ADC auth | ✅ Working | GCE metadata → OAuth2 tokens, patched model-auth-env |
| control-daemon | ✅ Running | systemd service, polls Firestore every 5s |
| Bootstrap config | ✅ Applied | RPC config.apply with retry/baseHash |
| CoreKit tools | ✅ Installed | fleet-deploy, fleet-teardown, etc. on VM |
| Dashboard → Firestore messaging | ✅ Working | Messages written to Firestore |
| OpenClaw → Vertex AI (direct) | ✅ Working | Tested: "pong" response from gemini-2.5-flash |
| Firestore → OpenClaw routing | ✅ Working | control-daemon bridges messages successfully |
| Dashboard E2E chat | ✅ Working | Full round-trip verified: intelligent responses in dashboard |
| Fleet hire via OpenClaw exec | ✅ Working | "hire testbot" → fleet-deploy → VM created + Firestore record |
| Fleet agents on OpenClaw | ✅ Working | fleet-echo running OpenClaw: "pong" from Vertex AI |

---

## Next Steps (v2.0 Completion)

### Checkpoint 2: End-to-End Message Verification
> *Goal: Dashboard message → OpenClaw → intelligent response displayed in dashboard*

1. Send a test message from the dashboard
2. Verify control-daemon picks it up from Firestore
3. Verify OpenClaw gateway processes it (LLM + workspace context)
4. Verify response is written back to Firestore
5. Verify response appears in dashboard chat

### Checkpoint 3: Fleet Hire/Fire Through OpenClaw
> *Goal: User says "hire a devops agent named stan" → Prime uses exec tool to call fleet-deploy*

1. Verify OpenClaw has `exec` tool enabled and `~/.openclaw/bin` on PATH
2. Test fleet-deploy from within the OpenClaw session
3. Verify fleet record appears in Firestore
4. Verify fleet agent VM boots successfully

### Checkpoint 4: Fleet Agents on OpenClaw
> *Goal: Fleet agent VMs also run full OpenClaw instances*

1. Update fleet-deploy to use the Docker-based OpenClaw bootstrap
2. Each fleet agent gets its own OpenClaw config (different SOUL, specialty workspace)
3. Fleet agents run inbox-daemon for Google Chat polling (DWD)
4. Verify fleet agent responds to Chat messages

### Checkpoint 5: GChat Verification
> *Goal: Fleet agents communicate via Google Chat with DWD*

1. Verify inbox-daemon polls Chat via DWD
2. Verify fleet agent responds to @-mentions in Chat

---

## Post-v2.0 — Future Capabilities

- **Brain sub-agents** — OpenClaw multi-agent system (Cortex, Prefrontal, Hippocampus, etc.)
- **Checkpoint queue** — R/C/M framework (Responsibilities, Checkpoints, Missions)
- **Agent memory system** — persistent memory across sessions
- **Google Workspace skills** — Docs, Sheets, Calendar, Gmail integration
- **Agent cell templates** — pre-built team configurations
- **Inter-agent delegation** — agents @-mention other agents to delegate
- **Cost governance** — per-agent spend tracking, auto-hibernate idle agents
- **Self-evolution** — Prime proposes its own improvements via PR

---

## Architecture Summary

```
Dashboard (Cloud Run)
    │
    ├─ POST /api/primes/{id}/deploy  → Creates GCE VM with boot stub
    ├─ POST /api/primes/{id}/messages → Writes to Firestore
    └─ GET  /api/primes/{id}/fleet   → Reads fleet from Firestore
         │
         ▼
    Firestore (state store)
         │
         ▼
    Prime VM (e2-medium)
    ├── control-daemon (systemd)
    │   └── Polls Firestore messages → POST to OpenClaw gateway
    │
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── Main agent (Gemini 2.5 Flash)
    │   ├── Workspace: SOUL.md, TOOLS.md, MEMORY.md
    │   ├── Tools: exec (fleet-deploy, fleet-teardown, etc.)
    │   └── Session memory + context pruning
    │
    └── CoreKit (manifest-installed)
        ├── fleet-deploy / fleet-teardown
        ├── agent-ask, build-system-prompt
        ├── inbox-daemon, chat-send, chat-read
        └── dwd-token, upgrade-corekit
```

---

## Principles

1. **No secrets in repo** — all secrets injected at runtime via ADC, DWD signJwt, or GCP metadata
2. **Manifest-driven** — `manifest.txt` is the single source of truth for installed files
3. **Boot stub pattern** — startup scripts live as real `.sh` files on GitHub, not in JS template literals
4. **OpenClaw-native** — leverage the framework's agent loop, tools, memory, and session management
5. **Idempotent** — every script safely re-runnable
6. **Self-upgradable** — drift detection + in-place upgrade
7. **Human-auditable** — all communication logged in Firestore
