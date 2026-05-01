# Architect Prime — Mission Plan

> **Format rules for this document:**
> - **CURRENT STATE only.** Document how things work *right now*. Do not include changelogs, historical checkpoints, or previous implementations. Git tags and commit history serve that purpose.
> - **No stale references.** If an approach has been replaced, remove all mention of the old approach. An AI agent reading this document should never be confused about which implementation is active.
> - **Update on every checkpoint.** When completing a checkpoint, update all sections to reflect the new reality. Move the completed checkpoint goal into the current state, and write the next checkpoint goal.
> - **Current version:** `v2026.05.01.3.0`

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
    ├── message-daemon (systemd)
    │   └── start-message-daemon → docker exec Node.js (message-daemon.mjs, CHANNEL=dashboard)
    │       ├── Polls Firestore messages every 5s via GCE metadata tokens
    │       ├── Non-streaming gateway dispatch (stream: false)
    │       ├── Anti-spam: message dedup (60s), immediate markProcessed, single-flight watchdog
    │       ├── Async path: 15s ACK timer → watchdog monitors for delivery
    │       ├── Conversation history (4 turns) + think-block stripping
    │       └── Unified daemon — same code as Fleet (only channel adapter differs)
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
    │   ├── Two-Phase Turn Protocol (v5.2):
    │   │   ├── PreTurn hook injects BRAIN_CARD.md (agent table + classification rules)
    │   │   ├── Phase 1: Cortex classifies + writes PLAN.md (mandatory before dispatch)
    │   │   ├── Phase 2: Cortex executes dispatch plan via brain-exec
    │   │   └── PostTurn hook validates compliance (PLAN.md vs actual dispatches)
    │   ├── Cortex dispatches sub-agents via: exec brain-exec <agent-id> "<task>"
    │   ├── Each agent has its own workspace: SOUL.md, IDENTITY.md, BRAIN_CARD.md
    │   ├── Tools: exec (fleet-*, agent-ask, core-memory-*, dashboard-respond)
    │   └── Session memory + context pruning + hybrid search
    │
    └── CoreKit (manifest-installed from GitHub — grouped by domain)
        ├── contracts.json           → Single source of truth for cross-cutting values
        ├── validate-contracts       → Pre-flight contract validation (repo/runtime/file)
        ├── fleet/: fleet-deploy, fleet-teardown, fleet-hire, fleet-fire, fleet-status,
        │          fleet-verify, fleet-upgrade, fleet-monitor, fleet-health-check
        ├── gateway/: render-config, discover-models, upgrade-openclaw, oc, smoke test
        ├── chat/: chat-send, chat-read, dwd-token, channel-respond
        ├── daemon/: message-daemon.mjs (unified), start-message-daemon (wrapper)
        ├── brain/: brain-exec, build-system-prompt, agent-ask, assemble-tools,
        │          brain-telemetry-write, brain-telemetry-read, check-plan-compliance
        ├── memory/: core-memory-read, core-memory-write, update-deep-truths
        ├── dashboard/: command-runner, dashboard-respond
        ├── system/: upgrade-corekit, validate-contracts, web-search
        └── config/: agent-types.json, fleet-registry.json, openclaw-bootstrap.json5.tmpl

    Fleet Agent VMs (e2-medium, Ubuntu 22.04, one per agent)
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── GOOGLE_CLOUD_LOCATION=global (same as Prime)
    │   ├── Default agent: cortex (Gemini 3.1 Pro Preview via Vertex AI ADC)
    │   ├── Brain sub-agents: same 6-agent architecture as Prime
    │   ├── SOUL.md loaded automatically from workspace (no systemPrompt injection)
    │   ├── timeoutSeconds: 600 (safety ceiling; real timeout is heartbeat-based)
    │   └── ADC fix: model-auth-env patched for GCE metadata fallback
    │
    ├── message-daemon (systemd)
    │   └── start-message-daemon → docker exec Node.js (message-daemon.mjs, CHANNEL=gchat)
    │       └── Same code as Prime — built-in DWD, polls Chat API, delivers via Chat API
    │
    └── CoreKit (manifest-installed from same repo)
```

---

## How Things Work

### Prime VM Bootstrap

1. Dashboard creates a GCE VM with a **boot stub** startup script
2. Boot stub curls `infra/bootstrap/prime-bootstrap.sh` from GitHub (`raw.githubusercontent.com`)
3. `prime-bootstrap.sh` installs Docker, CoreKit via `infra/install.sh --role prime`, builds the OpenClaw Docker image, writes config, starts the container, applies the ADC auth patch, and starts `message-daemon`
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
   - Creates a GCE VM with boot stub → `infra/bootstrap/fleet-bootstrap.sh`
   - Passes all config (agent name, specialty, email, dashboard URL, prime ID) via VM metadata
4. `fleet-monitor` runs on Prime in background: polls serial console for milestones, SSH-checks gateway health, writes deploy progress to Firestore
5. `fleet-bootstrap.sh` on fleet VM:
    - Installs Docker, CoreKit via `infra/install.sh --role fleet --job {specialty}` (base + fleet + job manifests)
    - Reads cross-cutting values from `contracts.json` (location, OpenClaw pin, gateway port/route)
    - Deploys specialty workspace (clears Prime files first)
    - Renders fleet config from `openclaw-fleet-bootstrap.json5.tmpl` (strips JSON5 comments, substitutes template vars)
    - Runs `validate-contracts --file` on rendered config (catches schema violations pre-start)
    - SOUL.md is loaded automatically by OpenClaw from workspace — no `systemPrompt` injection
    - Starts container with `GOOGLE_CLOUD_LOCATION` from contracts, applies ADC patch (wildcard across all agent dirs), restarts gateway
    - Runs Vertex AI smoke test (3 attempts with backoff, 60s timeout, contract-driven port/route)
    - Starts `message-daemon` (reads gateway route from `contracts.json`)
    - Self-reports `status: online` to Firestore via Prime's `update-status` API endpoint
    - Prints `FLEET AGENT SETUP COMPLETE` marker for fleet-monitor

**Fire flow:**
1. User clicks "Fire" → API calls `fleet-fire` → `fleet-teardown`
2. `fleet-teardown` deletes the VM and disk only
3. **Service account is preserved** — IAM bindings persist across fire/re-hire cycles
4. SA is free; VM+disk are the only cost items

**Re-hire flow:** Same as hire, but `fleet-deploy` detects the existing SA, skips creation, and IAM bindings are already active. No propagation delay.

### Chat Pipeline (Non-Streaming + Async Watchdog)

Both Prime and Fleet agents use the same async-first pattern. The daemon submits work to the gateway via a non-streaming call and delivers results directly or monitors for async delivery.

**Dashboard → Prime (message-daemon.mjs — Node.js, non-streaming):**
1. User types in dashboard → API writes to Firestore `messages` collection
2. `start-message-daemon` wrapper runs `message-daemon.mjs` inside Docker container (CHANNEL=dashboard auto-detected from `prime-config.json`)
3. Node.js daemon polls Firestore every 5s with GCE metadata access token
4. New message → **Immediate `markProcessed`** (prevents re-pickup on next poll cycle) → **Write TASK.json** to workspace
5. **Anti-spam at intake:**
   - Deduplication: same text within 60s is collapsed (one `recentMessages` Map entry per unique text)
   - Immediate `markProcessed`: message flagged in Firestore before the gateway call blocks (10-60s)
6. **Gateway dispatch (stream: false):** POST to local gateway, blocks until model completes full turn
7. **15s ACK timer:** If gateway hasn't responded in 15s, write "🔄 Processing..." ack to Firestore
8. **Response routing by mode:**
   - `complete` → Model returned full response. Write to Firestore directly.
   - `dispatched-async` → Yield detected (sub-agent running). Fire watchdog.
   - `error` → Gateway/model error. Write error message to Firestore.
9. **Watchdog (async path — single-flight):**
   - Only ONE watchdog runs at a time (`activeWatchdogTaskId` guard)
   - Path 1: Poll Firestore for `sender: 'prime'` messages after dispatch timestamp (channel-respond delivered)
   - Path 2: Parse `/tmp/openclaw/openclaw-YYYY-MM-DD.log` for synthesis text in LLM think blocks
   - Log offset tracking: `lastLogOffset` ensures only NEW log entries are scanned
   - `extractSynthesisFromThinking()` navigates think blocks to extract user-facing response
   - Timeout: 5 minutes → writes fallback error message
10. Conversation history: last 4 turns for context (Cortex only needs recent context for classification)
11. HTTP ceiling: 600s (research dispatches take 60-120s)
12. Structured JSON logging with mode, taskId, elapsed_ms, delivery method (agent/watchdog-log)

**Google Chat → Fleet Agent (GChatChannel adapter in message-daemon.mjs):**
The fleet chat pipeline is identical to Prime's — same daemon, same code path, same features. The only difference is the channel adapter:
1. `GChatChannel.poll()` queries Google Chat API via built-in DWD token (Node.js, no bash/python)
2. Only processes messages containing the agent's `@FirstName LastName` mention
3. Strips @-mention → marks consumed (high-water mark + seen map) → writes TASK.json
4. Steps 4-12 are identical to Prime (same `routeMessage()`, `watchdogCheck()`, ACK timer, dedup, history)
5. Fleet watchdog uses Path 2 only (log parse) since fleet has no Firestore
6. Space discovery cached for 5 minutes
7. Built-in DWD: IAM `signJwt` API from inside Docker (no key files, `--network host`)

**Unified daemon architecture (v5.3.0):** A single `message-daemon.mjs` (683 lines, Node.js) runs on both Prime and Fleet via `docker exec`. The `CHANNEL` env var (`dashboard` or `gchat`) selects the channel adapter — all shared logic (gateway client, ACK timer, dedup, conversation history, think-block stripping, watchdog, status check) is guaranteed identical. The `start-message-daemon` wrapper reads `chat-config.json` for agent-specific values and launches the daemon inside the Docker container.

**Channel abstraction (agent side):** Both channel adapters write `TASK.json` with channel metadata. Agents use `exec channel-respond "text"` which reads TASK.json and routes to the correct backend (`dashboard-respond` for Firestore, `chat-send` for Google Chat). This makes Prime and Fleet brains architecturally identical.

### Vertex AI Authentication (ADC)

Fleet and Prime VMs use **Application Default Credentials** via GCE metadata. OpenClaw's `model-auth-env` module is patched at bootstrap time to fall back to `{ apiKey: "<gce-adc>", source: "gce metadata" }` when no explicit API key is configured. This patch is applied by `sed` inside the container, then the container is restarted. The `upgrade-openclaw` script automatically re-applies this patch after every container recreation.

### Vertex AI Location

`GOOGLE_CLOUD_LOCATION` is set to `global` (not a specific region like `us-central1`). This is required because Gemini 3.1+ preview models only resolve via the global Vertex AI endpoint (`aiplatform.googleapis.com/locations/global`). GA models (Gemini 2.5, 2.0) also work via the global endpoint. The `@google/genai` SDK natively supports `location=global`.

### Contract Enforcement

`infra/contracts.json` is the **single source of truth** for all cross-cutting values. It defines:
- **OpenClaw pin** — commit hash and label for the pinned OpenClaw version
- **Vertex AI** — location (`global`), primary model (`gemini-3.1-pro-preview`), sub-agent model (`gemini-2.5-flash`)
- **Agent IDs** — default agent (`cortex`), gateway route (`openclaw/cortex`), sub-agent list
- **Gateway** — port (`18789`), timeout (`120s`), bind mode (`loopback`)
- **Environment** — `GOOGLE_GENAI_USE_VERTEXAI`, `GCE_METADATA_HOST`

The manifest installs `contracts.json` to `/opt/openclaw/.openclaw/corekit/contracts.json` on every VM. Scripts read from it at runtime instead of hardcoding values.

**`validate-contracts`** is the enforcement tool. Three modes:
- **Repo mode** (`validate-contracts`) — checks source files: both bootstraps, message-daemon.mjs, config templates. Verifies location, model route, agent ID, OpenClaw pin, no `systemPrompt` key.
- **Runtime mode** (`validate-contracts --runtime`) — checks a live VM: .env on disk, container running, gateway healthy, ADC patch applied, auth-profiles emptied, message-daemon route, message-daemon service active.
- **File mode** (`validate-contracts --file <config.json>`) — checks a rendered config: valid JSON, no systemPrompt, correct default agent ID.

**When it runs:**
- `fleet-bootstrap.sh` calls `--file` after config rendering, before container start
- `upgrade-corekit --apply` calls `--runtime` after upgrade completes
- `test-fleet-bootstrap.sh` calls repo mode as part of dry-run validation

**Why this exists:** The Gemini 3.1 migration broke stan because 5 cross-cutting values were hardcoded in 7 different files. Changing one file required synchronized edits to 6 others, and 4 were missed. Contracts make it impossible to introduce this class of bug — change one value in `contracts.json`, and validation catches every stale reference.

### Modular Manifest Install

`infra/install.sh` uses **chained manifest fragments** instead of a flat file:

```
infra/install.sh --role prime               → base.txt + role-prime.txt
infra/install.sh --role fleet --job devops  → base.txt + role-fleet.txt + job-devops.txt
infra/install.sh --role fleet --job engineer → base.txt + role-fleet.txt + job-engineer.txt
```

| Fragment | Contents | Scope |
|----------|----------|-------|
| `infra/manifests/base.txt` | contracts, gateway tools, chat tools, brain tools, config templates, agent skeleton | Every agent |
| `infra/manifests/role-prime.txt` | fleet lifecycle, dashboard bridge, memory, skills, brain workspaces (cortex + 5 sub-agents) | Prime only |
| `infra/manifests/role-fleet.txt` | fleet brain sub-agent workspaces, fleet template workspace | Fleet agents |
| `infra/manifests/job-devops.txt` | devops specialty workspace (8 files) | DevOps agents |
| `infra/manifests/job-engineer.txt` | engineer specialty workspace (8 files) | Engineer agents |

**STATE.json v2** records `role` and `job` alongside ref, file hashes, and timestamps. On upgrade (`install.sh --upgrade <ref>`), role/job are read from existing STATE.json so the correct fragments are re-installed automatically.

**Manifest source paths** reference the modular repo structure: `corekit/fleet/fleet-deploy`, `brain/prime/cortex/SOUL.md`, `specialties/devops/workspace/SOUL.md`, etc. Destination paths on VMs are unchanged.

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
- **Structured dispatch protocol:** `brain-exec` validates agent IDs against `contracts.json` `subagentIds` before launching `openclaw agent`. Unknown IDs are rejected with a clear error and a telemetry event.
- `brain-exec` wraps `openclaw agent` and strips gateway infrastructure warnings
- **Dispatch telemetry:** Every invocation records a telemetry event to Firestore (`/primes/{id}/brain/dispatch-log/{docId}`) via fire-and-forget backgrounded call to `brain-telemetry-write`. Events include: agent ID, task (truncated to 200 chars), start time, duration (ms), output bytes, exit code, success boolean, and error type.
- Synchronous — Cortex blocks until the sub-agent returns
- The CLI connects via gateway WebSocket when tokens are synced, falls back to embedded mode otherwise
- `render-config` ensures gateway token sync by reading `OPENCLAW_GATEWAY_TOKEN` env var
- `upgrade-corekit` auto-calls `render-config` after every deployment
- Cortex MUST wait for results before responding to the user
- Cortex runs on gemini-3.1-pro-preview; sub-agents on gemini-2.5-flash
- **Warm-up probe:** Both bootstrap scripts fire a lightweight request through the full cortex route after ADC setup, pre-warming tokens before the first real user message. Saves 10-20s on first interaction.
- **Telemetry retention:** 7-day rolling window. Old events are pruned by nightly memory consolidation.

**Brain workflow (every message):**
1. Simple questions / identity → Cortex answers directly, no dispatch
2. Fleet operations → Cortex runs fleet-* exec commands directly
3. Web search needed → Cortex dispatches `temporal-research`
4. Memory recall needed → Cortex dispatches `temporal-memory`
5. Complex tasks → Cortex chains: research → prefrontal → motor → cerebellum

**Brain workspace files** (in `brain/prime/` for Prime, `brain/fleet/` for fleet):
- `brain/prime/cortex/` → SOUL.md (dispatch + Deep Truths), IDENTITY.md, TOOLS.md, MEMORY.md (working memory)
- `brain/prime/temporal-research/` → SOUL.md (web search via agent-ask), IDENTITY.md
- `brain/prime/temporal-memory/` → SOUL.md (recall + nightly consolidation), IDENTITY.md
- `brain/prime/prefrontal/` → SOUL.md (planning methodology), IDENTITY.md
- `brain/prime/motor/` → SOUL.md (execution rules), IDENTITY.md
- `brain/prime/cerebellum/` → SOUL.md (verification criteria), IDENTITY.md

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

Each fleet agent type has a workspace directory in `specialties/`:
- `specialties/devops/workspace/` → DevOps specialty
- `specialties/engineer/workspace/` → Engineer specialty
- `brain/fleet/_base/` → Generic fleet template (fallback)

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
├── app/                              # MODULE 1: Control Plane (Cloud Run, Next.js)
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
│   ├── src/components/settings/      # Settings tabs (General, Models, System)
│   ├── src/lib/                      # Firestore, auth utilities
│   └── Dockerfile
├── infra/                            # MODULE 2: Infrastructure
│   ├── contracts.json                # Single source of truth (cross-cutting values)
│   ├── install.sh                    # Modular manifest-driven installer
│   ├── cloudbuild.yaml               # Dashboard Cloud Build config
│   ├── bootstrap/                    # VM startup scripts (curled from GitHub)
│   │   ├── prime-bootstrap.sh        # Prime VM setup
│   │   └── fleet-bootstrap.sh        # Fleet agent VM setup (contract-driven)
│   ├── manifests/                    # Modular manifest fragments
│   │   ├── base.txt                  # Tools every agent needs
│   │   ├── role-prime.txt            # Prime-only tools + workspaces
│   │   ├── role-fleet.txt            # Fleet workspaces + brain sub-agents
│   │   ├── job-devops.txt            # DevOps specialty workspace
│   │   └── job-engineer.txt          # Engineer specialty workspace
│   └── deploy/                       # Standalone install/uninstall scripts
├── corekit/                          # MODULE 3: CoreKit Runtime (VM-side scripts)
│   ├── fleet/                        # Fleet lifecycle (9 scripts)
│   ├── gateway/                      # OpenClaw gateway management (5 scripts)
│   ├── chat/                         # Google Chat / DWD integration (4 scripts)
│   ├── brain/                        # Brain execution layer (4 scripts)
│   ├── memory/                       # Memory subsystem (3 scripts)
│   ├── dashboard/                    # Dashboard bridge (4 scripts)
│   ├── system/                       # Cross-cutting utilities (3 scripts)
│   └── config/                       # Templates, service files, agent-types
├── brain/                            # MODULE 4: Agent Identity
│   ├── agents/main/                  # OpenClaw agent skeleton (auth, sessions)
│   ├── prime/                        # Prime brain workspaces
│   │   ├── cortex/                   # Orchestrator (default): SOUL, IDENTITY, TOOLS, MEMORY
│   │   ├── temporal-research/        # Web search: SOUL, IDENTITY
│   │   ├── temporal-memory/          # Memory recall: SOUL, IDENTITY
│   │   ├── prefrontal/               # Planning: SOUL, IDENTITY
│   │   ├── motor/                    # Execution: SOUL, IDENTITY
│   │   └── cerebellum/               # Verification: SOUL, IDENTITY
│   └── fleet/                        # Fleet brain workspaces
│       ├── _base/                    # Generic fleet template (fallback)
│       └── _brain/                   # Shared sub-agent workspaces for all fleet agents
├── specialties/                      # MODULE 5: Per-Agent-Type Bundles
│   ├── devops/workspace/             # DevOps specialty (8 files)
│   └── engineer/workspace/           # Engineer specialty (8 files)
├── skills/                           # MODULE 6: Skill Packages
│   ├── agent-ask/SKILL.md            # Vertex AI grounding web search
│   ├── fleet-hire/SKILL.md           # Deploy a new fleet agent
│   ├── fleet-fire/SKILL.md           # Remove a fleet agent
│   ├── fleet-status/SKILL.md         # Query fleet status
│   ├── fleet-verify/SKILL.md         # Verify agent health
│   ├── fleet-upgrade/SKILL.md        # Upgrade agent CoreKit
│   └── memory-consolidate/SKILL.md   # Nightly memory consolidation
├── docs/                             # Architecture documentation
│   └── architecture/                 # AGENT_DESIGN, BRAIN_ARCHITECTURE, R/C/M spec
├── MISSION_PLAN.md                   # This document
└── README.md
```

### CoreKit Tools (34 scripts, grouped by domain)

| Domain | Tool | Purpose |
|--------|------|---------|
| **fleet/** | `fleet-deploy` | Creates fleet agent VM + SA + IAM + boot stub |
| | `fleet-teardown` | Deletes fleet agent VM + disk (preserves SA) |
| | `fleet-monitor` | Polls serial console for bootstrap progress, writes to Firestore |
| | `fleet-hire` | Dashboard-facing wrapper: fleet-deploy + Firestore status |
| | `fleet-fire` | Dashboard-facing wrapper: fleet-teardown + Firestore status |
| | `fleet-status` | Reports fleet agent health summary |
| | `fleet-verify` | SSH-checks a fleet agent's gateway + DWD health |
| | `fleet-upgrade` | Upgrades a running fleet agent's CoreKit |
| | `fleet-health-check` | SSH-checks fleet agent gateway health, auto-recovers after 3 failures |
| **gateway/** | `render-config` | Renders JSON5 config template with string-aware comment stripping |
| | `discover-models` | Queries Vertex AI Model Garden, probes availability, outputs JSON catalog |
| | `upgrade-openclaw` | Rebuilds OpenClaw container from pinned commit |
| | `bootstrap_smoke.sh` | Vertex AI smoke test (3 attempts with backoff) |
| | `oc` | Thin wrapper for `docker exec openclaw-gateway openclaw` |
| **daemon/** | `message-daemon.mjs` | Unified Node.js daemon for both Prime (dashboard) and Fleet (gchat) |
| | `chat-send` | Sends messages to Google Chat via DWD |
| | `chat-read` | Reads messages from Google Chat via DWD |
| | `dwd-token` | Generates DWD OAuth2 tokens via GCE metadata signJwt |
| **brain/** | `brain-exec` | Dispatches sub-agents: validates agent ID → runs openclaw agent → strips warnings → writes telemetry → returns output |
| | `brain-telemetry-write` | Writes dispatch telemetry event to Firestore (fire-and-forget, called by brain-exec) |
| | `brain-telemetry-read` | Queries recent dispatch telemetry for debugging (table or JSON output) |
| | `build-system-prompt` | Assembles system prompt from workspace files |
| | `agent-ask` | Vertex AI grounding web search (used by temporal-research) |
| | `assemble-tools` | Builds TOOLS.md from skill definitions |
| **memory/** | `core-memory-read` | Queries Firestore Core Memory by category/tags |
| | `core-memory-write` | Writes durable facts to Firestore Core Memory |
| | `update-deep-truths` | Safely updates the Deep Truths section at end of Cortex SOUL.md |
| **dashboard/** | `command-runner` | Executes commands from Firestore, streams output |
| | `dashboard-respond` | Writes async responses to Firestore (for sub-agent results) |
| **system/** | `upgrade-corekit` | In-place CoreKit update from GitHub ref (validates contracts post-upgrade) |
| | `validate-contracts` | Pre-flight check: all cross-cutting values match contracts.json |
| | `web-search` | Google Search grounding for agent queries |

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
| `/opt/openclaw/.openclaw/corekit/contracts.json` | Installed contracts (from `infra/contracts.json`) |
| `/opt/openclaw/.openclaw/corekit/STATE.json` | Install provenance: ref, role, job, file hashes |
| `/opt/openclaw/.openclaw/skills/` | Skill definitions |
| `/root/.openclaw/.gateway-token` | Gateway auth token |
| `/var/log/fleet-agent-setup.log` | Bootstrap log (fleet VMs) |
| `/var/lib/message-daemon/` | message-daemon state (high-water mark) |

---

## Current Fleet

| Agent | Specialty | VM | Email | Status |
|-------|-----------|-----|-------|--------|
| stan | devops | fleet-stan | devops-agent-stan@tachin.ag | Online |

**Prime instance:** `chucknorris` — VM: `prime-chucknorris`, zone: `us-central1-a`, project: `architect-prime-beta`

---

## Design Principles

1. **No secrets in repo** — all secrets injected at runtime via ADC, DWD signJwt, or GCP metadata
2. **Contracts over documentation** — `contracts.json` is the single source of truth for cross-cutting values; `validate-contracts` enforces consistency at bootstrap and upgrade time
3. **Modular manifests** — `install.sh --role prime|fleet --job devops|engineer` chains base + role + job fragments; each module is independently iterable
4. **Boot stub pattern** — startup scripts live as `.sh` files on GitHub, not embedded in JS template literals
5. **OpenClaw-native** — leverage the framework's agent loop, tools, memory, and session management
6. **Idempotent** — every script safely re-runnable; upgrades overwrite manifest files, never delete non-manifest files
7. **Self-upgradable** — `upgrade-corekit` reads role/job from `STATE.json`, upgrades the correct fragment set, validates contracts
8. **Fail fast at bootstrap, not runtime** — `validate-contracts` runs before container start; config schema violations caught in seconds, not as crash-loops
9. **Preserve state across cycles** — service accounts and IAM bindings persist across fire/re-hire; STATE.json records role/job for idempotent upgrades
10. **Human-auditable** — all communication logged in Firestore; structured JSON logging with mode, latency, first-chunk timing
11. **Modular by module** — six top-level directories (`app/`, `infra/`, `corekit/`, `brain/`, `specialties/`, `skills/`) with minimal cross-dependencies; AI agents can focus on one module without understanding the whole repo

---

## Roadmap

### Completed: v2026.05.01.1.0 — Markdown Rendering + Dashboard Fixes
> *Formatted messages in both channels. Version detection fixed. Canonical versioning restored.*

1. **Dashboard markdown rendering** — Added `react-markdown` + `remark-gfm` via `MarkdownMessage.tsx` component. Agent messages render bold, italic, code blocks, lists, tables, headings, blockquotes, and links. User messages stay plain text.
2. **GChat markdown conversion** — `convertToGChatMarkdown()` in `GChatChannel.send()` converts `**bold**` → `*bold*` (GChat format). Preserves code blocks/inline code unchanged.
3. **Version detection fix** — `extractVersion()` in upgrade API now supports both canonical `v{YYYY}.{MM}.{DD}.{index}.{subindex}` and back-compat `vX.Y.Z` formats. Fixes "Latest Version: unknown" on System tab.
4. **CommandProgress staleness timeout** — Auto-dismisses upgrade banners stuck in pending/running for 5+ minutes.
5. **Version format protection** — `contracts.json` → `versioning` section documents the canonical forever format. `finalize-checkpoint` workflow includes verification step.
6. **Canonical versioning restored** — Returned to `v{YYYY}.{MM}.{DD}.{index}.{subindex}` as the forever format. The `vX.Y.Z` format (v5.0-v5.3) was a temporary deviation.

### Completed: v2026.05.01.2.0 — Fleet Upgrade UX + Enhanced GChat Formatting
> *Per-agent upgrade buttons, fleet-upgrade fixed, no-clobber manifest, rich GChat markdown.*

1. **Per-fleet-agent upgrade buttons** — Each fleet agent card in the Fleet tab has its own "⬆ Upgrade" button. "⬆ Upgrade All Fleet" button in fleet grid header for bulk upgrades. Prime upgrade no longer cascades to fleet.
2. **Fleet-upgrade fixed** — `fleet-upgrade` script now restarts `message-daemon` + `docker restart openclaw-gateway` (was referencing defunct `inbox-daemon`). Fleet registry populated with agent data.
3. **No-clobber manifest flag** — `install.sh` supports `?` suffix on manifest destinations: files marked with `?` are only installed if they don't already exist. Prevents `upgrade-corekit` from wiping live state files (e.g., `fleet-registry.json`).
4. **Enhanced GChat markdown** — `convertToGChatMarkdown()` now converts headers (→ bold with ◆/═/▸ prefix), blockquotes (→ ▎ prefix), horizontal rules (→ ─── separator), and markdown links (→ inline text + URL). All conversions skip code blocks.
5. **Agent coreRef visibility** — Fleet cards now show each agent's `coreRef` version badge.

### Completed: v2026.05.01.3.0 — Tech Debt Cleanup + Unified Daemon Deployment
> *Purged dead daemons, deployed message-daemon.service, fixed validate-contracts, aligned all documentation.*

1. **Dead code purge** — Deleted `inbox-daemon` (script + service), `control-daemon` (wrapper + .mjs). Removed all manifest entries. −1,613 lines of dead code.
2. **message-daemon.service deployed** — Created generic systemd service file in `corekit/config/`. `upgrade-corekit` now auto-installs, enables, and restarts the service on every upgrade.
3. **start-message-daemon auto-detection** — Wrapper reads `GCP_PROJECT_ID`, `PRIME_ID`, and `AGENT_ID` from `prime-config.json` (Prime) or VM metadata (Fleet). No hardcoded Environment= lines needed.
4. **validate-contracts fixed** — Repo mode checks `message-daemon.mjs` at correct path. Runtime mode checks daemon service is active. Removed ghost checks against nonexistent `bundle/` directory.
5. **Documentation alignment** — Updated all references across MISSION_PLAN, README, BOOTSTRAP, CHAT_SETUP, BRAIN_ARCHITECTURE, RCM doc, fleet scripts, bootstrap scripts, app code (25 files total).

### Current: v2026.05.01.4.0 — Watchdog Reliability + Model Flexibility
> *Goal: Eliminate false watchdog timeouts, enable per-agent model overrides.*

1. **Watchdog Firestore detection** — Fix the composite query or timestamp comparison so the watchdog detects `channel-respond` delivery and exits cleanly.
2. **Model flexibility** — Allow per-agent model override in `contracts.json` (some sub-agents may benefit from Gemini 3.1 Flash Lite instead of 2.5 Flash). `brain-exec` and `openclaw-bootstrap.json5.tmpl` read override from contract.
3. **Memory consolidation reliability** — Replace fragile nightly cron with retry-capable consolidation. Implement 7-day telemetry log pruning as part of the consolidation pass.
4. **Auto-generated Brain Card** — Generate BRAIN_CARD.md from contracts.json + workspace SOUL.md files instead of manual authoring.
5. **GChat Cards v2** — Explore structured card messages for richer formatting (headers, sections, icons, buttons) instead of plain text conversion.

### Future: v6.0 — R/C/M Framework
- Responsibilities engine — RESPONSIBILITY.toml manifests + registration
- Checkpoint queue — Firestore data model + queue-worker
- Human review gates — dashboard integration
- Inter-agent delegation — agents @-mention other agents to delegate tasks

### Future: v7.0 — RSI Engine
- Git-ops skill — branch, commit, push, PR
- Code-write / code-test skills
- Test harness: deploy from branch → validate → report
- RSI mission template — plan → implement → test → promote
- Two mandatory human gates (plan approval + merge approval)

### Future: v8.0+ — Workspace Integration
- Google Workspace skills — Docs, Sheets, Calendar, Gmail
- Agent cell templates — pre-built team configurations
- Self-evolution — Prime proposes its own improvements via PR
- Multi-project federation — fleet agents across different GCP projects

