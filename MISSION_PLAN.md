# Architect Prime — Mission Plan

> **Format rules for this document:**
> - **CURRENT STATE only.** Document how things work *right now*. Do not include changelogs, historical checkpoints, or previous implementations. Git tags and commit history serve that purpose.
> - **No stale references.** If an approach has been replaced, remove all mention of the old approach. An AI agent reading this document should never be confused about which implementation is active.
> - **Update on every checkpoint.** When completing a checkpoint, update all sections to reflect the new reality. Move the completed checkpoint goal into the current state, and write the next checkpoint goal.
> - **Current version tag:** `v3.7.1`

---

## Vision

Architect Prime is a **self-bootstrapping agent factory** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

---

## Architecture

```
Dashboard (Cloud Run — Next.js)
    │
    ├─ POST /api/primes/{id}/deploy           → Creates Prime GCE VM
    ├─ POST /api/primes/{id}/messages          → Writes chat to Firestore
    ├─ POST /api/primes/{id}/fleet/hire        → Triggers fleet-deploy on Prime VM
    ├─ POST /api/primes/{id}/fleet/fire        → Triggers fleet-teardown on Prime VM
    ├─ POST /api/primes/{id}/fleet/update-status → Fleet VM self-reports completion
    ├─ POST /api/primes/{id}/fleet/confirm-setup → Clears admin action card
    ├─ GET  /api/primes/{id}/fleet             → Reads fleet from Firestore
    ├─ GET  /api/primes/{id}/fleet/[agent]/logs → Agent detail + health + activity
    ├─ GET  /api/setup                         → Project config (DWD, email domain)
    ├─ POST /api/setup                         → Save settings (agent email domain)
    ├─ GET  /api/upgrade                       → Current + latest version info
    └─ POST /api/upgrade                       → Trigger Cloud Build self-upgrade
         │
         ▼
    Firestore (state store)
    ├── primes/{id}                   → Prime instance metadata
    ├── primes/{id}/messages/{msg}    → Dashboard ↔ Prime chat messages
    ├── primes/{id}/fleet/{agent}     → Fleet agent status, deploy steps, health
    ├── config/settings               → Agent defaults (email domain)
    └── config/dwd                    → DWD configuration
         │
         ▼
    Prime VM (e2-medium, Ubuntu 22.04)
    ├── control-daemon (systemd)
    │   └── Bash wrapper → docker exec Node.js daemon (control-daemon.mjs)
    │       ├── Polls Firestore messages every 5s via GCE metadata tokens
    │       ├── Hybrid gateway dispatch: SSE streaming → non-stream fallback
    │       └── Conversation history (20 turns) + structured JSON logging
    │
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── GOOGLE_CLOUD_LOCATION=global (required for Gemini 3.1+ preview models)
    │   ├── Brain agents (6 OpenClaw agents, multi-agent dispatch)
    │   │   ├── cortex (DEFAULT) — Gemini 3.1 Pro Preview — orchestrator + synthesizer
    │   │   ├── temporal-research — Gemini 2.5 Flash — web search (Vertex AI grounding)
    │   │   ├── temporal-memory — Gemini 2.5 Flash — memory/context recall
    │   │   ├── prefrontal — Gemini 2.5 Flash — strategic planning
    │   │   ├── motor — Gemini 2.5 Flash — execution (code + commands)
    │   │   └── cerebellum — Gemini 2.5 Flash — verification + QA
    │   ├── Cortex dispatches sub-agents via: exec brain-exec <agent-id> "<task>"
    │   ├── Each agent has its own workspace: SOUL.md, IDENTITY.md
    │   ├── Tools: exec (fleet-*, agent-ask, core-memory-*, dashboard-respond)
    │   └── Session memory + context pruning + hybrid search
    │
    └── CoreKit (manifest-installed from GitHub)
        ├── Fleet lifecycle: fleet-deploy, fleet-teardown, fleet-monitor
        ├── Fleet orchestration: fleet-hire, fleet-fire, fleet-status, fleet-verify, fleet-upgrade
        ├── Chat: inbox-daemon, chat-send, chat-read, dwd-token
        ├── Agent: agent-ask (Vertex AI grounding), brain-exec, build-system-prompt
        ├── Memory: core-memory-read, core-memory-write (Firestore)
        ├── System: upgrade-corekit, command-runner, render-config, assemble-tools
        ├── Daemon: control-daemon (bash wrapper), control-daemon.mjs (Node.js)
        ├── Async: dashboard-respond (Firestore push)
        └── Config: agent-types.json, fleet-registry.json, openclaw-bootstrap.json5.tmpl

    Fleet Agent VMs (e2-medium, Ubuntu 22.04, one per agent)
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── GOOGLE_CLOUD_LOCATION=global (same as Prime)
    │   ├── Default agent: cortex (Gemini 3.1 Pro Preview via Vertex AI ADC)
    │   ├── SOUL.md loaded automatically from workspace (no systemPrompt injection)
    │   ├── timeoutSeconds: 120 (ADC cold-start tolerance)
    │   └── ADC fix: model-auth-env patched for GCE metadata fallback
    │
    ├── inbox-daemon (systemd)
    │   └── Polls Google Chat via DWD → POST to openclaw/cortex on local gateway
    │
    └── CoreKit (manifest-installed from same repo)
```

---

## How Things Work

### Prime VM Bootstrap

1. Dashboard creates a GCE VM with a **boot stub** startup script
2. Boot stub curls `bootstrap/prime-bootstrap.sh` from GitHub (`raw.githubusercontent.com`)
3. `prime-bootstrap.sh` installs Docker, CoreKit, builds the OpenClaw Docker image, writes config, starts the container, applies the ADC auth patch, and starts `control-daemon`
4. The OpenClaw image is pinned to commit `041266a6` (v2026.4.15) for stability

### Fleet Agent Lifecycle

**Hire flow:**
1. User clicks "Hire Agent" in dashboard → API calls `fleet-hire` on Prime VM via `command-runner`
2. `fleet-hire` wraps `fleet-deploy` with Firestore status updates
3. `fleet-deploy` on Prime VM:
   - Creates (or reuses) a service account: `fleet-{name}@{project}.iam.gserviceaccount.com`
   - Grants IAM roles: `aiplatform.user`, `serviceAccountTokenCreator`, `datastore.user`
   - Verifies IAM bindings are active (retry on failure)
   - Resolves Cloud Run URL for status relay
   - Creates a GCE VM with boot stub → `fleet-bootstrap.sh`
   - Passes all config (agent name, specialty, email, dashboard URL, prime ID) via VM metadata
4. `fleet-monitor` runs on Prime in background: polls serial console for milestones, SSH-checks gateway health, writes deploy progress to Firestore
5. `fleet-bootstrap.sh` on fleet VM:
    - Installs Docker, CoreKit, builds OpenClaw image
    - Deploys specialty workspace (clears Prime files first)
    - Renders fleet config from `openclaw-fleet-bootstrap.json5.tmpl` (strips JSON5 comments, substitutes template vars)
    - SOUL.md is loaded automatically by OpenClaw from workspace — no `systemPrompt` injection
    - Starts container with `GOOGLE_CLOUD_LOCATION=global`, applies ADC patch (wildcard across all agent dirs), restarts gateway
    - Runs Vertex AI smoke test (3 attempts with backoff)
    - Starts `inbox-daemon` (routes to `openclaw/cortex`)
    - Self-reports `status: online` to Firestore via Prime's `update-status` API endpoint
    - Prints `FLEET AGENT SETUP COMPLETE` marker for fleet-monitor

**Fire flow:**
1. User clicks "Fire" → API calls `fleet-fire` → `fleet-teardown`
2. `fleet-teardown` deletes the VM and disk only
3. **Service account is preserved** — IAM bindings persist across fire/re-hire cycles
4. SA is free; VM+disk are the only cost items

**Re-hire flow:** Same as hire, but `fleet-deploy` detects the existing SA, skips creation, and IAM bindings are already active. No propagation delay.

### Chat Pipeline

**Dashboard → Prime (control-daemon.mjs — Node.js, hybrid SSE):**
1. User types in dashboard → API writes to Firestore `messages` collection
2. `control-daemon` bash wrapper detects `.mjs` → `docker exec` runs Node.js version inside container
3. Node.js daemon polls Firestore every 5s with GCE metadata access token
4. New message → **Hybrid dispatch to gateway `/v1/chat/completions`:**
   - **Step 1:** Try SSE streaming (`stream: true`). Keeps connection alive during long research dispatches (3-5 min).
   - **Step 2:** If response ≤5 chars (thinking marker from exec tool), retry non-streaming. Non-streaming waits for the full turn including tool results.
5. Response written back to Firestore → dashboard displays it
6. HTTP timeout: 600s hard ceiling
7. Conversation history: last 20 turns for context
8. Structured JSON logging with mode (streaming/non-streaming-fallback), latency, first-chunk timing

**Google Chat → Fleet Agent (inbox-daemon):**
1. `inbox-daemon` polls Google Chat API via DWD impersonation every 15s
2. Only processes messages containing the agent's `@FirstName LastName` mention
3. Strips @-mention, sends text to local OpenClaw gateway
4. Response sent back to Google Chat via DWD `chat-send`
5. High-water-mark dedup prevents duplicate processing
6. Space discovery cached for 5 minutes

### Vertex AI Authentication (ADC)

Fleet and Prime VMs use **Application Default Credentials** via GCE metadata. OpenClaw's `model-auth-env` module is patched at bootstrap time to fall back to `{ apiKey: "<gce-adc>", source: "gce metadata" }` when no explicit API key is configured. This patch is applied by `sed` inside the container, then the container is restarted. The `upgrade-openclaw` script automatically re-applies this patch after every container recreation.

### Vertex AI Location

`GOOGLE_CLOUD_LOCATION` is set to `global` (not a specific region like `us-central1`). This is required because Gemini 3.1+ preview models only resolve via the global Vertex AI endpoint (`aiplatform.googleapis.com/locations/global`). GA models (Gemini 2.5, 2.0) also work via the global endpoint. The `@google/genai` SDK natively supports `location=global`.

### Dynamic Model Discovery

The model catalog is built at runtime by `discover-models`, replacing a static JSON file. The flow:

1. **Dashboard** → user clicks "Scan for Models" → `POST /api/primes/{id}/models/scan`
2. **API** writes `discover_models` command to Firestore commands collection
3. **command-runner** picks up command, runs `discover-models --probe-only`, writes JSON to temp file
4. **discover-models**:
   - Queries `gcloud ai model-garden models list` (~600 models)
   - Filters: MaaS-only, text generation, excludes image/video/TTS/embed
   - Generates display names: `claude-opus-4-7` → `Claude Opus 4.7`
   - Removes discontinued models (e.g., `gemini-3-pro-preview` — shut down March 2026)
   - Probes each model: regional endpoint first, then **global fallback** for preview tier
   - Returns JSON with `models[]`, `currentModel`, `bestAvailable`
5. **command-runner** → Python transforms JSON to Firestore `mapValue`/`arrayValue` structures → PATCH to `primes/{id}/config/settings`
6. **Dashboard** reads `modelCatalog` array from Firestore → renders model cards with status badges

**Current catalog** (14 models, 6 available as of April 2026):

| Model | Provider | Status |
|-------|----------|--------|
| Gemini 3.1 Pro Preview | Google | ✅ Available (global) |
| Gemini 3.1 Flash Lite Preview | Google | ✅ Available (global) |
| Gemini 2.5 Pro | Google | ✅ Available |
| Gemini 2.5 Flash | Google | ✅ Available |
| Gemini 2.0 Flash 001 | Google | ✅ Available |
| Gemini 2.0 Flash Lite 001 | Google | ✅ Available |
| Claude Opus/Sonnet/Haiku (6 models) | Anthropic | ❌ Needs MaaS enablement |
| Chirp 2 | Google | ❌ Audio model (not text) |

### Domain-Wide Delegation (DWD)

Fleet agents impersonate their Workspace user (e.g., `devops-agent-stan@tachin.ai`) using DWD. The `dwd-token` script generates JWT tokens via the GCE metadata `signJwt` endpoint — no service account key files needed. The DWD signer SA is passed as VM metadata (`dwd_signer_sa`).

### Brain Architecture (Prime)

Prime uses 6 OpenClaw agents in a multi-agent configuration. Cortex is the default
(user-facing) agent; the other 5 are sub-agents dispatched synchronously via
`exec brain-exec <agent-id> "<task>"`. This runs the sub-agent, strips infrastructure
warnings, returns its output to Cortex, and Cortex synthesizes the final response.

| Agent | Model | Role | Workspace | Tools |
|-------|-------|------|-----------|-------|
| **cortex** | gemini-3.1-pro-preview | Orchestrator + synthesizer (DEFAULT) | `~/.openclaw/workspace` | read, write, edit, exec |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `~/.openclaw/workspace-temporal-research` | exec (agent-ask only) |
| **temporal-memory** | gemini-2.5-flash | Memory/context recall | `~/.openclaw/workspace-temporal-memory` | read, exec |
| **prefrontal** | gemini-2.5-flash | Strategic planning | `~/.openclaw/workspace-prefrontal` | read only |
| **motor** | gemini-2.5-flash | Execution (code + commands) | `~/.openclaw/workspace-motor` | read, write, edit, exec |
| **cerebellum** | gemini-2.5-flash | Verification + QA | `~/.openclaw/workspace-cerebellum` | read, exec |

**Dispatch mechanism:** `exec brain-exec <agent-id> "<task>" [timeout]`
- `brain-exec` wraps `openclaw agent` and strips gateway infrastructure warnings
- Synchronous — Cortex blocks until the sub-agent returns
- The CLI connects via gateway WebSocket when tokens are synced, falls back to embedded mode otherwise
- `render-config` ensures gateway token sync by reading `OPENCLAW_GATEWAY_TOKEN` env var
- `upgrade-corekit` auto-calls `render-config` after every deployment
- Cortex MUST wait for results before responding to the user
- Cortex runs on gemini-3.1-pro-preview; sub-agents on gemini-2.5-flash

**Brain workflow (every message):**
1. Simple questions / identity → Cortex answers directly, no dispatch
2. Fleet operations → Cortex runs fleet-* exec commands directly
3. Web search needed → Cortex dispatches `temporal-research`
4. Memory recall needed → Cortex dispatches `temporal-memory`
5. Complex tasks → Cortex chains: research → prefrontal → motor → cerebellum

**Brain workspace files** (in `bundle/workspaces/`):
- `cortex/` → SOUL.md (dispatch + Deep Truths), IDENTITY.md, TOOLS.md, MEMORY.md (working memory)
- `temporal-research/` → SOUL.md (web search via agent-ask), IDENTITY.md
- `temporal-memory/` → SOUL.md (recall + nightly consolidation), IDENTITY.md
- `prefrontal/` → SOUL.md (planning methodology), IDENTITY.md
- `motor/` → SOUL.md (execution rules), IDENTITY.md
- `cerebellum/` → SOUL.md (verification criteria), IDENTITY.md

**Workspace efficiency:** Sub-agents are stateless. Only Cortex has MEMORY.md and TOOLS.md.
Sub-agents get task context from `brain-exec` args, not workspace files.

**Two-tier memory model:**
- **Tier 1 (Working Memory):** `MEMORY.md` in Cortex workspace. Updated during turns.
  Sections: Current Mission, Current Focus, Active Decisions, Notes. Max ~2KB.
- **Tier 2 (Core Memory):** Firestore `/primes/{id}/memory/core/`. Durable facts.
  Written by temporal-memory during nightly consolidation (2 AM cron via `memory-consolidate` skill).
  Read by temporal-memory on recall dispatch from Cortex.
- **Deep Truths:** End of Cortex SOUL.md has a mutable `## Deep Truths` section.
  Updated nightly by temporal-memory via `exec update-deep-truths`. Everything above is immutable.

**Locked-in design decisions:**
- 🔒 Web search = `exec agent-ask` (Vertex AI grounding). NEVER native web-search tool.
- 🔒 `temporal-research` is the ONLY agent capable of web search.
- 🔒 Cortex on gemini-3.1-pro-preview. Sub-agents on gemini-2.5-flash.
- 🔒 Dispatch via `exec brain-exec`, NOT `sessions_spawn` or raw `openclaw agent`.
- 🔒 `brain-dispatch` script eliminated permanently.
- 🔒 SOUL.md above `## Deep Truths` is IMMUTABLE. Only `update-deep-truths` script may modify Deep Truths.
- 🔒 Core Memory writes happen via nightly consolidation, NOT during conversation turns.

### Dashboard Self-Upgrade

The dashboard can upgrade itself via Cloud Build. The pipeline:
1. `POST /api/upgrade` triggers Cloud Build with 4 steps:
   - `git clone --branch {latest-tag}` from GitHub (public repo)
   - `docker build` the Next.js app
   - `docker push` to Artifact Registry
   - `gcloud run deploy` with `--update-env-vars APP_VERSION={tag}`
2. Build runs async (~3 minutes). Dashboard shows latest/current version on Setup tab.
3. First deploy was manual (bootstrap); after that the button is self-sustaining.
4. `APP_VERSION` env var auto-detected from `git describe --tags` during install.

### Agent Defaults

The Setup tab stores configurable defaults in Firestore `config/settings`:
- **Agent Email Domain** — when set (e.g., `tachin.ai`), the Hire modal auto-fills
  agent email as `{specialty}-agent-{name}@{domain}`. Saves via `POST /api/setup`.

### Fleet Health Monitoring

`fleet-health-check` script (deployed via CoreKit, runs every 15 minutes via systemd timer):
1. SSHs into each fleet agent VM and curls `localhost:18789/health`
2. Records: status (healthy/unhealthy), latency, HTTP code, consecutive failures
3. Writes health data to Firestore at `primes/{id}/fleet/{agent}.health`
4. Auto-recovery: after 3 consecutive failures, restarts `openclaw-gateway` container
5. Dashboard Fleet tab shows health data in a "Gateway Health" column per agent

### Fleet Agent Workspaces

Each fleet agent type has a workspace directory:
- `bundle/workspaces/devops/` → DevOps specialty
- `bundle/workspaces/engineer/` → Engineer specialty
- `bundle/workspaces/fleet/` → Generic fleet template (fallback)

At bootstrap, `fleet-bootstrap.sh`:
1. Clears the workspace directory (removes any inherited Prime files)
2. Copies specialty files (e.g., `workspace-devops/`) if they exist, else falls back to `workspace-fleet/`
3. Applies template variables: `{{AGENT_NAME}}`, `{{SPECIALTY}}`, `{{PROJECT_ID}}`, `{{DEPLOY_TIMESTAMP}}`

`upgrade-corekit` also restores specialty workspace files after a CoreKit update to prevent identity regression.

### Naming Convention

- Agent name: lowercase alphanumeric with hyphens (e.g., `stan`, `anora`)
- VM name: `fleet-{name}` (e.g., `fleet-stan`)
- Service account: `fleet-{name}@{project}.iam.gserviceaccount.com`
- Workspace email: `{specialty}-agent-{name}@tachin.ai` (e.g., `devops-agent-stan@tachin.ai`)
- GChat @-mention: `{FirstName} {LastName}` (e.g., `Devops-Agent Stan`)
- The @-mention MUST match the Workspace account's First Name + Last Name exactly

---

## GCP IAM Model

**Control-plane SA** (`architect-prime-cp@{project}.iam.gserviceaccount.com`):
- `roles/datastore.user` — Firestore read/write
- `roles/compute.admin` — Create/delete VMs for Prime + fleet
- `roles/iam.serviceAccountAdmin` — Create SAs for Prime + fleet
- `roles/iam.serviceAccountUser` — Attach SAs to VMs
- `roles/iam.serviceAccountTokenCreator` — Sign JWTs for DWD
- `roles/serviceusage.serviceUsageConsumer` — Enable APIs
- `roles/aiplatform.user` — Vertex AI access for agent LLM
- `roles/cloudbuild.builds.editor` — Trigger Cloud Build (dashboard self-upgrade)
- `roles/run.admin` — Update Cloud Run service

**Compute SA** (`{project-number}-compute@developer.gserviceaccount.com`):
- `roles/run.admin` — Cloud Build deploy step uses this SA
- `roles/iam.serviceAccountUser` on control-plane SA — act as the Cloud Run service identity
- `roles/resourcemanager.projectIamAdmin` — required for fleet-deploy to grant IAM roles to fleet SAs

**Cloud Build SA** (`{project-number}@cloudbuild.gserviceaccount.com`):
- `roles/run.admin` — Deploy to Cloud Run
- `roles/iam.serviceAccountUser` on control-plane SA — act as the Cloud Run service identity

**Fleet agent SAs** (`fleet-{name}@{project}.iam.gserviceaccount.com`):
- `roles/aiplatform.user` — Vertex AI model inference
- `roles/iam.serviceAccountTokenCreator` — DWD token signing
- `roles/datastore.user` — Firestore access (granted but not currently used by fleet-bootstrap; status relay goes through Prime API instead)

**Key constraint:** IAM bindings take up to 60s to propagate after SA creation. `fleet-deploy` waits 30s, then verifies bindings before proceeding.

---

## File Layout

```
architect-prime/
├── app/                              # Cloud Run control plane (Next.js)
│   ├── src/app/page.tsx              # Dashboard UI (single-page)
│   ├── src/app/api/primes/[id]/      # REST API routes
│   │   ├── messages/                 # Dashboard ↔ Prime chat
│   │   ├── commands/                 # Command execution bridge
│   │   ├── deploy/                   # Prime VM creation
│   │   └── fleet/                    # Fleet lifecycle
│   │       ├── hire/                 # POST — trigger fleet-deploy
│   │       ├── fire/                 # POST — trigger fleet-teardown
│   │       ├── update-status/        # POST — fleet VM self-report (relay)
│   │       ├── confirm-setup/        # POST — clear admin action card
│   │       ├── dismiss/              # POST — dismiss agent from dashboard
│   │       └── [agent]/              # GET — agent detail + logs
│   ├── src/lib/                      # Firestore, auth utilities
│   └── Dockerfile
├── bundle/                           # Files installed on VM via manifest
│   ├── corekit/                      # Core config + CLI tools
│   │   ├── config/                   # Templates, agent-types, registry
│   │   └── bin/                      # 23 CLI tools (see CoreKit Tools below)
│   ├── openclaw/                     # Agent runtime files (auth profiles, sessions)
│   ├── skills/                       # Self-describing SKILL.md per skill
│   └── workspaces/                   # Agent persona files
│       ├── cortex/                   # Prime brain: orchestrator (default)
│       ├── temporal-research/        # Prime brain: web search (Vertex AI)
│       ├── temporal-memory/          # Prime brain: memory/context recall
│       ├── prefrontal/               # Prime brain: strategic planning
│       ├── motor/                    # Prime brain: execution
│       ├── cerebellum/               # Prime brain: verification
│       ├── _brain/                   # Fleet: Shared brain sub-agent workspaces
│       │   ├── temporal-research/    # Web search (templated SOUL/IDENTITY)
│       │   ├── temporal-memory/      # Memory recall (templated)
│       │   ├── prefrontal/           # Planning (templated)
│       │   ├── motor/                # Execution (templated)
│       │   └── cerebellum/           # Verification (templated)
│       ├── devops/                   # Fleet: DevOps specialty cortex
│       ├── engineer/                 # Fleet: Engineer specialty cortex
│       └── fleet/                    # Fleet: Generic template (fallback)
├── bootstrap/                        # VM startup scripts (curled from GitHub)
│   ├── prime-bootstrap.sh            # Prime VM setup
│   └── fleet-bootstrap.sh            # Fleet agent VM setup
├── deploy/                           # Installation scripts
│   └── install.sh                    # Manifest-driven installer
├── docs/                             # Project documentation
├── manifest.txt                      # Source → destination file mapping
├── MISSION_PLAN.md                   # This document
└── README.md
```

### CoreKit Tools (bundle/corekit/bin/) — 30 files

| Tool | Purpose |
|------|---------|
| `fleet-deploy` | Creates fleet agent VM + SA + IAM + boot stub |
| `fleet-teardown` | Deletes fleet agent VM + disk (preserves SA) |
| `fleet-monitor` | Polls serial console for bootstrap progress, writes to Firestore |
| `fleet-hire` | Dashboard-facing wrapper: fleet-deploy + Firestore status |
| `fleet-fire` | Dashboard-facing wrapper: fleet-teardown + Firestore status |
| `fleet-status` | Reports fleet agent health summary |
| `fleet-verify` | SSH-checks a fleet agent's gateway + DWD health |
| `fleet-upgrade` | Upgrades a running fleet agent's CoreKit |
| `fleet-health-check` | SSH-checks fleet agent gateway health, auto-recovers after 3 failures |
| `inbox-daemon` | Polls Google Chat via DWD, routes messages to OpenClaw |
| `control-daemon` | Bash wrapper — starts `control-daemon.mjs` inside container |
| `control-daemon.mjs` | Node.js daemon: Firestore polling, hybrid SSE dispatch, conversation history |
| `chat-send` | Sends messages to Google Chat via DWD |
| `chat-read` | Reads messages from Google Chat via DWD |
| `dwd-token` | Generates DWD OAuth2 tokens via GCE metadata signJwt |
| `agent-ask` | Vertex AI grounding web search (used by temporal-research) |
| `brain-exec` | Dispatches sub-agents, strips gateway warnings, returns output |
| `build-system-prompt` | Assembles system prompt from workspace files |
| `web-search` | Google Search grounding for agent queries |
| `upgrade-corekit` | In-place CoreKit update from GitHub ref |
| `command-runner` | Executes commands from Firestore, streams output |
| `discover-models` | Queries Vertex AI Model Garden, probes availability, outputs JSON catalog |
| `assemble-tools` | Builds TOOLS.md from skill definitions |
| `core-memory-read` | Queries Firestore Core Memory by category/tags |
| `core-memory-write` | Writes durable facts to Firestore Core Memory |
| `update-deep-truths` | Safely updates the Deep Truths section at end of Cortex SOUL.md |
| `render-config` | Renders JSON5 config template with string-aware comment stripping |
| `dashboard-respond` | Writes async responses to Firestore (for sub-agent results) |
| `bootstrap_smoke.sh` | Vertex AI smoke test (3 attempts with backoff) |
| `oc` | Thin wrapper for `docker exec openclaw-gateway openclaw` |

### Key Paths on VM

| Path | Purpose |
|------|---------|
| `/opt/openclaw` | OpenClaw root (`OC_HOST_ROOT`) |
| `/opt/openclaw/.openclaw/` | Config directory (bind-mounted into container) |
| `/opt/openclaw/.openclaw/openclaw.json` | Gateway configuration |
| `/opt/openclaw/.openclaw/workspace/` | Active workspace files |
| `/opt/openclaw/.openclaw/workspace-{specialty}/` | Specialty workspace (fleet only) |
| `/opt/openclaw/.openclaw/bin/` | CoreKit CLI tools |
| `/opt/openclaw/.openclaw/corekit/` | Config files, templates, registry |
| `/opt/openclaw/.openclaw/skills/` | Skill definitions |
| `/root/.openclaw/.gateway-token` | Gateway auth token |
| `/var/log/fleet-agent-setup.log` | Bootstrap log (fleet VMs) |
| `/var/lib/inbox-daemon/` | inbox-daemon state (high-water mark) |

---

## Current Fleet

| Agent | Specialty | VM | Email | Status |
|-------|-----------|-----|-------|--------|
| stan | devops | fleet-stan | devops-agent-stan@tachin.ag | Online |

**Prime instance:** `chucknorris` — VM: `prime-chucknorris`, zone: `us-central1-a`, project: `architect-prime-beta`

---

## Design Principles

1. **No secrets in repo** — all secrets injected at runtime via ADC, DWD signJwt, or GCP metadata
2. **Manifest-driven** — `manifest.txt` is the single source of truth for installed files
3. **Boot stub pattern** — startup scripts live as `.sh` files on GitHub, not embedded in JS template literals
4. **OpenClaw-native** — leverage the framework's agent loop, tools, memory, and session management
5. **Idempotent** — every script safely re-runnable
6. **Self-upgradable** — drift detection + in-place upgrade via `upgrade-corekit`
7. **Human-auditable** — all communication logged in Firestore
8. **Fail loud** — IAM grants, smoke tests, and status writes log errors visibly (never silently swallow)
9. **Preserve state across cycles** — service accounts and IAM bindings persist across fire/re-hire

---

## Roadmap

### Next: v4.0 — Modularization + Brain Model Upgrade
> *Goal: Decompose the monolith into isolated, independently iterable modules. Upgrade the brain model for reliability.*

**Modularization** — The project has grown organically and changes to one area (e.g., fleet bootstrap) can break others (e.g., fleet config, inbox-daemon, ADC auth). The codebase must be decomposed into self-contained modules with clear contracts:

| Module | What it owns | Versioned how |
|--------|-------------|---------------|
| **Dashboard / UI** | Cloud Run app, API routes, Firestore schema, setup/deploy UX | `app/` — independent deploy via Cloud Build |
| **Prime CoreKit** | Prime-specific tools (control-daemon, command-runner, fleet-*, brain-exec) | `bundle/corekit/` — manifest-installed, self-upgradable |
| **Universal Agent Brain** | Multi-agent config, SOUL/IDENTITY templates, brain-exec dispatch, model selection | `bundle/workspaces/` + config templates — shared across Prime and fleet |
| **Base Agent CoreKit** | Common tools every agent needs (inbox-daemon, chat-send, dwd-token, upgrade-corekit) | Subset of `bundle/corekit/bin/` — manifest filter |
| **Job-type Skillsets** | Per-specialty workspace files + skills (devops/, engineer/, etc.) | `bundle/workspaces/{specialty}/` + `bundle/skills/` |
| **Bootstrap Layer** | prime-bootstrap.sh, fleet-bootstrap.sh, install.sh, manifest.txt | `bootstrap/` — must be idempotent and independently testable |

**Brain Model Upgrade** — The brain architecture (cortex + 5 sub-agents) is critical to all agents' intelligence and reliability. Current pain points:
1. Cold-start timeout on ADC token acquisition (mitigated with timeoutSeconds: 120 but not solved)
2. No structured output validation — Cortex dispatch instructions are natural language, can hallucinate agent IDs
3. No dispatch telemetry — can't observe which brain agents ran, their latency, or failure modes
4. Sub-agent model pinning — all sub-agents on gemini-2.5-flash, no per-agent model override
5. Memory consolidation reliability — nightly cron is fragile, no retry mechanism

### Future: v5.0 — R/C/M Framework
- Responsibilities engine — RESPONSIBILITY.toml manifests + registration
- Checkpoint queue — Firestore data model + queue-worker
- Human review gates — dashboard integration
- Inter-agent delegation — agents @-mention other agents to delegate tasks

### Future: v6.0 — RSI Engine
- Git-ops skill — branch, commit, push, PR
- Code-write / code-test skills
- Test harness: deploy from branch → validate → report
- RSI mission template — plan → implement → test → promote
- Two mandatory human gates (plan approval + merge approval)

### Future: v7.0+ — Workspace Integration
- Google Workspace skills — Docs, Sheets, Calendar, Gmail
- Agent cell templates — pre-built team configurations
- Self-evolution — Prime proposes its own improvements via PR
- Multi-project federation — fleet agents across different GCP projects
