# Architect Prime — Mission Plan

> **Format rules for this document:**
> - **CURRENT STATE only.** Document how things work *right now*. Do not include changelogs, historical checkpoints, or previous implementations. Git tags and commit history serve that purpose.
> - **No stale references.** If an approach has been replaced, remove all mention of the old approach. An AI agent reading this document should never be confused about which implementation is active.
> - **Update on every checkpoint.** When completing a checkpoint, update all sections to reflect the new reality. Move the completed checkpoint goal into the current state, and write the next checkpoint goal.
> - **Current version tag:** `v3.2.0`

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
    └─ GET  /api/primes/{id}/fleet/[agent]     → Agent detail + logs
         │
         ▼
    Firestore (state store)
    ├── primes/{id}                   → Prime instance metadata
    ├── primes/{id}/messages/{msg}    → Dashboard ↔ Prime chat messages
    └── primes/{id}/fleet/{agent}     → Fleet agent status, deploy steps
         │
         ▼
    Prime VM (e2-medium, Ubuntu 22.04)
    ├── control-daemon (systemd)
    │   └── Polls Firestore messages → POST to OpenClaw gateway
    │
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── Brain agents (6 OpenClaw agents, multi-agent dispatch)
    │   │   ├── cortex (DEFAULT) — Gemini 2.5 Flash — orchestrator + synthesizer
    │   │   ├── temporal-research — Gemini 2.5 Flash — web search (Vertex AI grounding)
    │   │   ├── temporal-memory — Gemini 2.5 Flash — memory/context recall
    │   │   ├── prefrontal — Gemini 2.5 Flash — strategic planning
    │   │   ├── motor — Gemini 2.5 Flash — execution (code + commands)
    │   │   └── cerebellum — Gemini 2.5 Flash — verification + QA
    │   ├── Cortex dispatches sub-agents via: exec openclaw agent --agent <id>
    │   ├── Each agent has its own workspace: SOUL.md, IDENTITY.md
    │   ├── Tools: exec (fleet-*, agent-ask, core-memory-*, dashboard-respond)
    │   └── Session memory + context pruning + hybrid search
    │
    └── CoreKit (manifest-installed from GitHub)
        ├── Fleet lifecycle: fleet-deploy, fleet-teardown, fleet-monitor
        ├── Fleet orchestration: fleet-hire, fleet-fire, fleet-status, fleet-verify, fleet-upgrade
        ├── Chat: inbox-daemon, chat-send, chat-read, dwd-token
        ├── Agent: agent-ask (Vertex AI grounding), build-system-prompt
        ├── Memory: core-memory-read, core-memory-write (Firestore)
        ├── System: upgrade-corekit, command-runner, render-config, assemble-tools
        ├── Async: dashboard-respond (Firestore push)
        └── Config: agent-types.json, fleet-registry.json, openclaw-bootstrap.json5.tmpl

    Fleet Agent VMs (e2-medium, Ubuntu 22.04, one per agent)
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── Specialty agent (Gemini 2.5 Flash via Vertex AI ADC)
    │   ├── Workspace: specialty-specific SOUL.md, IDENTITY.md, TOOLS.md
    │   └── ADC fix: model-auth-env patched for GCE metadata fallback
    │
    ├── inbox-daemon (systemd)
    │   └── Polls Google Chat via DWD → POST to local OpenClaw gateway
    │
    └── CoreKit (manifest-installed from same repo)
```

---

## How Things Work

### Prime VM Bootstrap

1. Dashboard creates a GCE VM with a **boot stub** startup script
2. Boot stub curls `bootstrap/prime-bootstrap.sh` from GitHub (`raw.githubusercontent.com`)
3. `prime-bootstrap.sh` installs Docker, CoreKit, builds the OpenClaw Docker image, writes config, starts the container, applies the ADC auth patch, and starts `control-daemon`
4. The OpenClaw image is pinned to commit `163c6f5e` for stability

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
   - Starts container, applies ADC patch, restarts gateway
   - Runs Vertex AI smoke test (3 attempts with backoff)
   - Starts `inbox-daemon`
   - Self-reports `status: online` to Firestore via Prime's `update-status` API endpoint (not direct Firestore write — fleet SA doesn't need `datastore.user`)
   - Prints `FLEET AGENT SETUP COMPLETE` marker for fleet-monitor

**Fire flow:**
1. User clicks "Fire" → API calls `fleet-fire` → `fleet-teardown`
2. `fleet-teardown` deletes the VM and disk only
3. **Service account is preserved** — IAM bindings persist across fire/re-hire cycles
4. SA is free; VM+disk are the only cost items

**Re-hire flow:** Same as hire, but `fleet-deploy` detects the existing SA, skips creation, and IAM bindings are already active. No propagation delay.

### Chat Pipeline

**Dashboard → Prime (control-daemon):**
1. User types in dashboard → API writes to Firestore `messages` collection
2. `control-daemon` (systemd) polls Firestore every 5s
3. New message → POST to OpenClaw gateway `/v1/chat/completions`
4. Response written back to Firestore → dashboard displays it

**Google Chat → Fleet Agent (inbox-daemon):**
1. `inbox-daemon` polls Google Chat API via DWD impersonation every 15s
2. Only processes messages containing the agent's `@FirstName LastName` mention
3. Strips @-mention, sends text to local OpenClaw gateway
4. Response sent back to Google Chat via DWD `chat-send`
5. High-water-mark dedup prevents duplicate processing
6. Space discovery cached for 5 minutes

### Vertex AI Authentication (ADC)

Fleet and Prime VMs use **Application Default Credentials** via GCE metadata. OpenClaw's `model-auth-env` module is patched at bootstrap time to fall back to `{ apiKey: "<gce-adc>", source: "gce metadata" }` when no explicit API key is configured. This patch is applied by `sed` inside the container, then the container is restarted.

### Domain-Wide Delegation (DWD)

Fleet agents impersonate their Workspace user (e.g., `devops-agent-stan@tachin.ai`) using DWD. The `dwd-token` script generates JWT tokens via the GCE metadata `signJwt` endpoint — no service account key files needed. The DWD signer SA is passed as VM metadata (`dwd_signer_sa`).

### Brain Architecture (Prime)

Prime uses 6 OpenClaw agents in a multi-agent configuration. Cortex is the default
(user-facing) agent; the other 5 are sub-agents dispatched synchronously via
`exec openclaw agent --agent <id> -m "<task>"`. This runs the sub-agent in embedded
mode, returns its output to Cortex, and Cortex synthesizes the final response.

| Agent | Model | Role | Workspace | Tools |
|-------|-------|------|-----------|-------|
| **cortex** | gemini-2.5-flash | Orchestrator + synthesizer (DEFAULT) | `~/.openclaw/workspace` | read, write, edit, exec |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `~/.openclaw/workspace-temporal-research` | exec (agent-ask only) |
| **temporal-memory** | gemini-2.5-flash | Memory/context recall | `~/.openclaw/workspace-temporal-memory` | read, exec |
| **prefrontal** | gemini-2.5-flash | Strategic planning | `~/.openclaw/workspace-prefrontal` | read only |
| **motor** | gemini-2.5-flash | Execution (code + commands) | `~/.openclaw/workspace-motor` | read, write, edit, exec |
| **cerebellum** | gemini-2.5-flash | Verification + QA | `~/.openclaw/workspace-cerebellum` | read, exec |

**Dispatch mechanism:** `exec openclaw agent --agent <id> -m "<task>" --timeout 60`
- Synchronous — Cortex blocks until the sub-agent returns
- The CLI falls back to embedded mode (bypasses gateway WebSocket auth)
- Cortex MUST wait for results before responding to the user
- All agents run on gemini-2.5-flash; Pro available via model override

**Brain workflow (every message):**
1. Simple questions / identity → Cortex answers directly, no dispatch
2. Fleet operations → Cortex runs fleet-* exec commands directly
3. Web search needed → Cortex dispatches `temporal-research`
4. Memory recall needed → Cortex dispatches `temporal-memory`
5. Complex tasks → Cortex chains: research → prefrontal → motor → cerebellum

**Brain workspace files** (in `bundle/workspaces/`):
- `cortex/` → SOUL.md (dispatch rules, decision tree), IDENTITY.md, TOOLS.md
- `temporal-research/` → SOUL.md (web search via agent-ask), IDENTITY.md
- `temporal-memory/` → SOUL.md (memory recall via core-memory-read), IDENTITY.md
- `prefrontal/` → SOUL.md (planning methodology), IDENTITY.md
- `motor/` → SOUL.md (execution rules), IDENTITY.md
- `cerebellum/` → SOUL.md (verification criteria), IDENTITY.md

**Locked-in design decisions:**
- 🔒 Web search = `exec agent-ask` (Vertex AI grounding). NEVER native web-search tool.
- 🔒 `temporal-research` is the ONLY agent capable of web search.
- 🔒 All agents on gemini-2.5-flash. Pro via model override only.
- 🔒 Dispatch via `exec openclaw agent`, NOT `sessions_spawn`.
- 🔒 `brain-dispatch` script eliminated permanently.

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

**Prime VM compute SA** (`{project-number}-compute@developer.gserviceaccount.com`):
- `roles/resourcemanager.projectIamAdmin` — required for fleet-deploy to grant IAM roles to fleet SAs
- Standard compute scopes (`cloud-platform`)

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
│       ├── devops/                   # Fleet: DevOps specialty
│       ├── engineer/                 # Fleet: Engineer specialty
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

### CoreKit Tools (bundle/corekit/bin/)

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
| `inbox-daemon` | Polls Google Chat via DWD, routes messages to OpenClaw |
| `control-daemon` | Polls Firestore messages, routes to OpenClaw gateway |
| `chat-send` | Sends messages to Google Chat via DWD |
| `chat-read` | Reads messages from Google Chat via DWD |
| `dwd-token` | Generates DWD OAuth2 tokens via GCE metadata signJwt |
| `agent-ask` | Vertex AI grounding web search (used by temporal-research) |
| `build-system-prompt` | Assembles system prompt from workspace files |
| `web-search` | Google Search grounding for agent queries |
| `upgrade-corekit` | In-place CoreKit update from GitHub ref |
| `command-runner` | Executes commands from Firestore, streams output |
| `assemble-tools` | Builds TOOLS.md from skill definitions |
| `core-memory-read` | Queries Firestore Core Memory by category/tags |
| `core-memory-write` | Writes durable facts to Firestore Core Memory |
| `render-config` | Renders JSON5 config template with string-aware comment stripping |
| `dashboard-respond` | Writes async responses to Firestore (for sub-agent results) |
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
| stan | devops | fleet-stan | devops-agent-stan@tachin.ai | Online |
| anora | pm | fleet-anora | pm-agent-anora@tachin.ai | Online |

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

### Next: Checkpoint 8 — Brain Hardening + WebSocket Upgrade
> *Goal: Robust multi-agent dispatch, control-daemon WebSocket, token management*

1. **Control-daemon WebSocket upgrade** — switch from HTTP chat/completions to persistent WebSocket connection. Enables native `sessions_spawn` for true async dispatch with announce-back.
2. **Gateway token management** — codify token auto-sync into bootstrap + upgrade scripts. The gateway auto-generates runtime tokens; `render-config` and `control-daemon` must handle this.
3. **Multi-agent E2E hardening** — test all 5 sub-agent dispatch paths (research, memory, planning, execution, verification) with real workloads.
4. **Error recovery** — Cortex gracefully handles sub-agent timeouts, fallback to direct response.
5. **Brain observability** — log which sub-agents were dispatched per turn, latency, success/failure.

### Future: v3.5 — Memory + Fleet Health
- Hippocampus nightly responsibility — consolidate daily notes → Core Memory
- Fleet health monitoring — Prime periodically checks fleet agent health
- Auto-recovery — detect and restart failed fleet agents
- Cost governance — per-agent spend tracking, auto-hibernate idle agents

### Future: v4.0 — R/C/M Framework
- Responsibilities engine — cron + Firestore registry
- Checkpoint queue — Firestore data model + queue-worker
- Human review gates — dashboard integration
- Inter-agent delegation — agents @-mention other agents to delegate tasks

### Future: v5.0 — RSI Engine
- Git-ops skill — branch, commit, push, PR
- Code-write / code-test skills
- Test harness: deploy from branch → validate → report
- RSI mission template — plan → implement → test → promote
- Two mandatory human gates (plan approval + merge approval)

### Future: v6.0+ — Workspace Integration
- Google Workspace skills — Docs, Sheets, Calendar, Gmail
- Agent cell templates — pre-built team configurations
- Self-evolution — Prime proposes its own improvements via PR
- Multi-project federation — fleet agents across different GCP projects
