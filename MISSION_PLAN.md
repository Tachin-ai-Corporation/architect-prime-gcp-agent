# Architect Prime — Mission Plan

> **Format rules for this document:**
> - **CURRENT STATE only.** Document how things work *right now*. Do not include changelogs, historical checkpoints, or previous implementations. Git tags and commit history serve that purpose.
> - **No stale references.** If an approach has been replaced, remove all mention of the old approach. An AI agent reading this document should never be confused about which implementation is active.
> - **Update on every checkpoint.** When completing a checkpoint, update all sections to reflect the new reality. Move the completed checkpoint goal into the current state, and write the next checkpoint goal.
> - **Current version:** `v2026.05.26.10.0`

---

## Vision

Architect Prime is a **self-bootstrapping agent factory** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP.

Prime's role is **infrastructure, not orchestration**. Prime creates agents, upgrades them, monitors their health, manages costs, and tears them down. Humans assign work to agents directly, and agents may delegate to other agents. Prime is the factory that builds and maintains the fleet.

---

## Architecture

```
Dashboard (Cloud Run — Next.js, Living Agent Graph home, top-level Work/Brain/Skills pages)
    │
    ├─ POST /api/primes/{id}/deploy           → Creates Prime GCE VM
    ├─ POST /api/primes/{id}/messages          → Writes chat to Firestore
    ├─ GET  /api/primes/{id}/fleet/{agent}/messages → Fleet agent dashboard chat
    ├─ POST /api/primes/{id}/fleet/{agent}/messages → Send message to fleet agent via Firestore
    ├─ POST /api/primes/{id}/fleet/hire        → Triggers fleet-deploy on Prime VM
    ├─ POST /api/primes/{id}/fleet/fire        → Triggers fleet-teardown on Prime VM
    ├─ POST /api/primes/{id}/fleet/update-status → Fleet VM self-reports completion
    ├─ POST /api/primes/{id}/fleet/confirm-setup → Clears admin action card
    ├─ GET  /api/primes/{id}/fleet             → Reads fleet from Firestore
    ├─ GET  /api/primes/{id}/fleet/[agent]/logs → Agent detail + health + activity
    ├─ GET  /api/agent-types                   → Dynamic specialty list from repo (5m cache)
    ├─ GET  /api/setup                         → Project config (DWD, email domain, auth status)
    ├─ POST /api/setup                         → Save settings (agent email domain)
    ├─ GET  /api/upgrade                       → Current + latest version info
    ├─ POST /api/upgrade                       → Trigger Cloud Build self-upgrade
    ├─ GET  /api/upgrade/status                → Real-time Cloud Build status polling
    ├─ GET  /api/primes/{id}/work              → Work envelopes (last 7 days)
    ├─ POST /api/primes/{id}/work/{workId}/respond → Human-in-the-loop response
    └─ POST/GET /api/primes/{id}/fleet/{agent}/introspect → Agent VM introspection (Firestore bus)
         │
         ▼
    Firestore (state store)
    ├── primes/{id}                   → Prime instance metadata
    ├── primes/{id}/messages/{msg}    → Dashboard ↔ Prime chat messages
    ├── primes/{id}/fleet/{agent}     → Fleet agent status, deploy steps, health
    ├── primes/{id}/fleet/{agent}/messages/{msg} → Dashboard ↔ Fleet agent chat messages
    ├── primes/{id}/tasks/{taskId}    → Prime task lifecycle log
    ├── primes/{id}/fleet/{agent}/tasks/{taskId} → Fleet task lifecycle log
    ├── config/settings               → Agent defaults (email domain)
    ├── primes/{id}/work/{id}          → Work envelopes (R/C/M/T state machine)
    ├── primes/{id}/work/{id}/history/ → Status transition log
    ├── primes/{id}/intake/{id}        → Brain intake queue
    ├── primes/{id}/fleet/{agent}/introspect/{queryId} → Introspection query/result bus
    ├── primes/{id}/processes/{id}     → Stored reusable processes (step sequences)
    ├── primes/{id}/approvals/{id}     → Approval gate documents (pending/approved/rejected)
    ├── primes/{id}/projects/{id}/promotions/{id} → Context promotion candidates
    └── config/dwd                    → DWD configuration
         │
         ▼
    Prime VM (e2-medium, Ubuntu 22.04)
    ├── agent-ears (systemd) — Deterministic input processing
    │   └── Polls channels, deduplicates, rate-limits, fire-and-forget gateway POST
    │       ├── Zero LLM calls — 100% deterministic
    │       ├── Firestore poll (3s) or GChat poll (5s) via DWD
    │       ├── Dashboard Firestore poll (secondary, fleet only) — polls primes/{id}/fleet/{agent}/messages
    │       ├── Approval gate detection — intercepts approve/reject replies in GChat, updates Firestore approval docs
    │       └── Cooldown + dedup window (configurable)
    │
    ├── agent-brain (systemd) — Brain state machine orchestrator
    │   └── Polls Firestore intake, creates work envelopes, dispatches sub-agents
    │       ├── Cortex classify + decide loop (deterministic state machine)
    │       ├── M→C→T envelope hierarchy (Missions, Checkpoints, Tasks)
    │       ├── Memory recall + write via temporal-memory dispatch
    │       ├── Multi-step plan execution with retry + Cerebellum verification
    │       ├── Delegation handler (delegate action, waiting envelope resumption)
    │       ├── Shared workspace persistence (mission-scoped shared dirs for motor file continuity)
    │       ├── Semantic failure detection (Cerebellum FAIL + Motor tool failures)
    │       └── Escalation-style failure directives (concrete asks, not problem reports)
    │
    ├── agent-mouth (systemd) — JSONL-native output processing + delivery
    │   └── Tails JSONL session transcript, classifies, delivers to channel
    │       ├── JSONL tailer (byte-offset, session file resolution, seek-to-end on startup)
    │       ├── Turn state machine (IDLE → WORKING → ACKED → UPDATED → DONE)
    │       ├── Status updates (5s ack, 120s update) voiced by LLM with fallback
    │       ├── One LLM call per output (classify + format via Gemini Flash, JSON mode)
    │       ├── Speaks AS the agent (first person) — not a relay
    │       ├── Prompts loaded from external .md files (no inline prose)
    │       ├── Fire-and-forget task lifecycle write to Firestore on delivery/timeout
    │       ├── Brain envelope polling (delivery_status=pending primary query, 3-status fallback)
    │       └── Never drops messages — unknown classification → deliver raw
    │
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── GOOGLE_CLOUD_LOCATION=global (required for Gemini 3.1+ preview models)
    │   ├── Brain agents (6 OpenClaw agents, Cortex-first orchestration)
    │   │   ├── cortex (DEFAULT) — Gemini 3.1 Pro Preview — plan executor + synthesizer
    │   │   ├── temporal-research — Gemini 2.5 Flash — web search (Vertex AI grounding)
    │   │   ├── temporal-memory — Gemini 2.5 Flash — pure memory/context recall (NO external APIs)
    │   │   ├── prefrontal — Gemini 2.5 Flash — mandatory dispatch planner (two-mode: simple + advisory)
    │   │   ├── motor — Gemini 2.5 Flash — execution + ALL Google Workspace tools (read+write) + advisory mode
    │   │   └── cerebellum — Gemini 2.5 Flash — verification + validation-rule checking
    │   ├── Brain State Machine (agent-brain.mjs):
    │   │   ├── Cortex JSON classify & decide loop (deterministic orchestrator)
    │   │   ├── R/M/C/T Cognitive Hierarchy (Responsibilities, Missions, Checkpoints, Tasks)
    │   │   ├── Dual-Recall Memory Integration (ambient + enriched)
    │   │   ├── Cross-Agent Delegation & Resume (Prime ↔ Fleet)
    │   │   └── Dynamic generation parameter mapping per role
    │   ├── Each agent has its own workspace: SOUL.md, IDENTITY.md, TOOLS.md
    │   ├── TOOLS.md auto-generated by assemble-tools from skills (per agent type)
    │   └── Session memory + context pruning + hybrid search
    │
    └── CoreKit (manifest-installed from GitHub — grouped by domain)
        ├── contracts.json           → Single source of truth for cross-cutting values
        ├── validate-contracts       → Pre-flight contract validation (repo/runtime/file)
        ├── fleet/: fleet-deploy, fleet-teardown, fleet-hire, fleet-fire, fleet-status,
        │          fleet-verify, fleet-upgrade, fleet-monitor, fleet-health-check
        ├── gateway/: render-config, discover-models, upgrade-openclaw, oc, smoke test
        ├── chat/: chat-send, chat-read, dwd-token (identity-locked)
        ├── daemon/: agent-ears.mjs, agent-mouth.mjs, agent-introspect.mjs,
        │           mouth-classify-prompt.md, mouth-status-prompts.md,
        │           start-agent-ears, start-agent-mouth, start-agent-introspect,
        │           ears-health-check, mouth-health-check
        ├── brain/: agent-ask, assemble-tools, brain-telemetry-write/read,
        │          task-log-write, task-log-read
        ├── memory/: core-memory-read, core-memory-write, update-deep-truths
        ├── dashboard/: command-runner
        ├── system/: upgrade-corekit, validate-contracts
        └── config/: agent-registry.json, fleet-registry.json, openclaw-bootstrap.json5.tmpl

    Fleet Agent VMs (e2-medium, Ubuntu 22.04, one per agent)
    ├── .identity-lock              → DWD impersonation guard (chmod 444)
    ├── openclaw-gateway (Docker, --network host, port 18789)
    │   ├── GOOGLE_CLOUD_LOCATION=global (same as Prime)
    │   ├── Default agent: cortex (Gemini 3.1 Pro Preview via Vertex AI ADC)
    │   ├── Brain sub-agents: same 6-agent architecture as Prime
    │   ├── SOUL.md loaded automatically from workspace (no systemPrompt injection)
    │   ├── timeoutSeconds: 600 (safety ceiling; real timeout is heartbeat-based)
    │   └── ADC fix: model-auth-env patched for GCE metadata fallback
    │
    ├── agent-ears (systemd) — GChat polling via DWD + dashboard Firestore poll (deterministic, no ACK)
    ├── agent-mouth (systemd) — output classification + GChat delivery + Firestore delivery + task log
    │
    └── CoreKit (manifest-installed from same repo)
```

---

## How Things Work

### Prime VM Bootstrap

1. Dashboard creates a GCE VM with a **boot stub** startup script
2. Boot stub curls `infra/bootstrap/prime-bootstrap.sh` from GitHub (`raw.githubusercontent.com`)
3. `prime-bootstrap.sh` installs Docker, CoreKit via `infra/install.sh --role prime`, builds the OpenClaw Docker image, writes config, starts the container, applies the ADC auth patch, and starts `agent-ears` + `agent-mouth`
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
    - Starts `agent-ears` + `agent-mouth` (reads gateway route from `contracts.json`)
    - Self-reports `status: online` to Firestore via Prime's `update-status` API endpoint
    - Prints `FLEET AGENT SETUP COMPLETE` marker for fleet-monitor

**Fire flow:**
1. User clicks "Fire" → API calls `fleet-fire` → `fleet-teardown`
2. `fleet-teardown` deletes the VM and disk only
3. **Service account is preserved** — IAM bindings persist across fire/re-hire cycles
4. SA is free; VM+disk are the only cost items

**Re-hire flow:** Same as hire, but `fleet-deploy` detects the existing SA, skips creation, and IAM bindings are already active. No propagation delay.

### I/O Pipeline (Ears + Mouth Architecture)

Both Prime and Fleet agents use independent, fire-and-forget input/output services. OpenClaw "just thinks" — it never worries about delivery.

**Agent Ears — Deterministic Input Processing (`agent-ears.mjs`):**
1. Polls input channel every N seconds (Firestore for Prime, GChat API for Fleet via DWD)
2. **Dashboard Firestore poll** (fleet only) — secondary poll of `primes/{id}/fleet/{agent}/messages` for admin messages sent from the dashboard. Merged with GChat messages.
3. Deduplicates (60s sliding window, same-text collapse)
4. **GChat context window** — when an @mention is detected, ears includes the prior N messages from the space as context (configurable, default 5). Messages are formatted as `[Chat messages since your last reply - for context]` preamble with sender names, followed by `[Current message - respond to this]`.
5. **Approval gate detection** — after preprocessing, checks if the message matches approval patterns (`approve`, `yes`, `lgtm`, `go ahead`, `proceed`, `👍`) or rejection patterns (`reject`, `no`, `deny`, `stop`, `👎`). If matched, queries Firestore for the most recent pending approval doc and PATCHes it with the decision. Handled messages skip normal intake processing.
6. Writes `workspace/TASK.json` with channel metadata (channel type, taskId, sender info, source: dashboard|gchat)
7. Fires gateway POST (`fire-and-forget`) — does NOT wait for response
8. Gateway call completes asynchronously — ears is already free to poll the next message
9. Dashboard messages are marked `processed: true` in Firestore after consumption

**Agent Mouth — JSONL-Native Output Processing (`agent-mouth.mjs` v2):**
1. Tails the OpenClaw JSONL session transcript (`~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`)
2. **JSONL tailer**: resolves active session file from `sessions.json`, reads new bytes from byte offset, seeks to end on startup (prevents re-delivery of old output on restart)
3. **Turn state machine** (IDLE → WORKING → ACKED → UPDATED → DONE): structurally detects user messages (turn start), tool calls (intermediate), and final assistant text (candidate response)
4. **Status updates**: fires LLM-voiced ack at 5s, progress update at 120s (configurable via contracts). Deterministic fallback text if LLM fails.
5. **Final response detection**: candidate is the last assistant text block not followed by a toolCall/toolResult within one poll cycle (2s)
6. **LLM classify**: Gemini Flash in JSON mode — `{"action": "deliver"|"suppress", "text": "..."}`
7. **Delivery**: writes to Firestore (dashboard) or sends via GChat API (fleet). Fleet mouth also writes to `primes/{id}/fleet/{agent}/messages` for dashboard visibility.
8. **Safety**: unknown classification → deliver raw (never drops user messages). 10-minute timeout delivers warning.

**Prompt architecture (external files):**
- `mouth-classify-prompt.md` — classify/voice prompt (brain→mouth: mouth IS the agent, voices thoughts naturally)
- `mouth-status-prompts.md` — ack + two-minute update templates with `{variable}` placeholders
- Loaded at startup via `readFileSync`, simple `string.replace()` for templating (no handlebars)

**Architecture properties:**
- Ears and mouth are fully independent — crash/restart of one doesn't affect the other
- **JSONL-native** — mouth reads the authoritative session transcript, not log files. Structurally distinguishes final responses from intermediate tool output.
- `channel-respond` has been removed — OpenClaw agents never call delivery tools directly

### Vertex AI Authentication (ADC)

Fleet and Prime VMs use **Application Default Credentials** via GCE metadata. OpenClaw's `model-auth-env` module is patched at bootstrap time to fall back to `{ apiKey: "<gce-adc>", source: "gce metadata" }` when no explicit API key is configured. The patcher is a Python script written to the host via heredoc, then `docker cp`'d into the container to avoid shell-quoting issues with embedded Python inside `docker exec bash -c` blocks. The `upgrade-openclaw` script automatically re-applies this patch after every container recreation.

> **Pin note:** OpenClaw is pinned to v2026.4.15. The v2026.5.x branch removed `google-auth-library` GCE metadata support, breaking service account ADC on GCE VMs. Do not upgrade until upstream restores GCE support.

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
- **Repo mode** (`validate-contracts`) — checks source files: both bootstraps, agent-ears.mjs, config templates. Verifies location, model route, agent ID, OpenClaw pin, no `systemPrompt` key.
- **Runtime mode** (`validate-contracts --runtime`) — checks a live VM: .env on disk, container running, gateway healthy, ADC patch applied, auth-profiles emptied, agent-ears route, agent-ears + agent-mouth services active.
- **File mode** (`validate-contracts --file <config.json>`) — checks a rendered config: valid JSON, no systemPrompt, correct default agent ID.

**When it runs:**
- `fleet-bootstrap.sh` calls `--file` after config rendering, before container start
- `upgrade-corekit --apply` calls `--runtime` after upgrade completes

**Why this exists:** The Gemini 3.1 migration broke stan because 5 cross-cutting values were hardcoded in 7 different files. Changing one file required synchronized edits to 6 others, and 4 were missed. Contracts make it impossible to introduce this class of bug — change one value in `contracts.json`, and validation catches every stale reference.

### Modular Manifest Install

`infra/install.sh` uses **chained manifest fragments** instead of a flat file:

```
infra/install.sh --role prime                  → base.txt + role-prime.txt
infra/install.sh --role fleet --job devops     → base.txt + role-fleet.txt + job-devops.txt
infra/install.sh --role fleet --job assistant  → base.txt + role-fleet.txt + job-assistant.txt
infra/install.sh --role fleet --job pm         → base.txt + role-fleet.txt + job-pm.txt
```

| Fragment | Contents | Scope |
|----------|----------|-------|
| `infra/manifests/base.txt` | contracts, gateway tools, chat tools, brain tools, config templates, agent skeleton | Every agent |
| `infra/manifests/role-prime.txt` | fleet lifecycle, dashboard bridge, memory, skills, brain workspaces (cortex + 5 sub-agents) | Prime only |
| `infra/manifests/role-fleet.txt` | fleet brain sub-agent workspaces, fleet template workspace, 5 Workspace skill packages (Drive 9, Gmail 5, Calendar 5, Docs 6, Sheets 3 = 28 tools) | Fleet agents |
| `infra/manifests/job-devops.txt` | devops specialty workspace (3 files) | DevOps agents |
| `infra/manifests/job-swe.txt` | SWE specialty — maps to engineer workspace (3 files) | SWE agents |
| `infra/manifests/job-engineer.txt` | engineer specialty workspace (3 files) | Engineer agents |
| `infra/manifests/job-qa.txt` | QA specialty workspace (3 files) | QA agents |
| `infra/manifests/job-pm.txt` | PM specialty workspace (3 files) | PM agents |
| `infra/manifests/job-finance.txt` | finance specialty workspace (3 files) | Finance agents |
| `infra/manifests/job-data.txt` | data specialty workspace (3 files) | Data agents |
| `infra/manifests/job-security.txt` | security specialty workspace (3 files) | Security agents |
| `infra/manifests/job-assistant.txt` | assistant specialty workspace (3 files) | Assistant agents |

**STATE.json v2** records `role` and `job` alongside ref, file hashes, and timestamps. On upgrade (`install.sh --upgrade <ref>`), role/job are read from existing STATE.json so the correct fragments are re-installed automatically.

**Manifest source paths** reference the modular repo structure: `corekit/fleet/fleet-deploy`, `brain/prime/cortex/SOUL.md`, `specialties/devops/workspace/SOUL.md`, etc. Destination paths on VMs are unchanged.

### Dynamic Model Discovery

The model catalog is built at runtime by `POST /api/models/scan` (project-scoped, no Prime dependency), running entirely on Cloud Run.

**Architecture insight:** The Model Garden REST API (`publishers/*/models`) returns ~300 models but only Google models have `supportedActions` (like `openGenerationAiStudio`). Anthropic and xAI are MaaS-only partners — they appear in the Model Garden UI but are NOT in the REST API at all. Third-party models (Meta, DeepSeek, Mistral, Qwen) are in the API but have zero `supportedActions`.

**Hybrid discovery approach:**

1. **Dashboard** → user clicks "Scan for Models" → `POST /api/models/scan`
2. **API route** (Cloud Run) queries Model Garden REST API with pagination:
   - `GET https://{region}-aiplatform.googleapis.com/v1beta1/publishers/*/models?alt=json&filter=is_hf_wildcard(false)&listAllVersions=True`
   - Returns ~300 models from ~23 publishers (Google, Meta, DeepSeek, Mistral, Qwen, etc.)
3. **Filter** with provider-aware logic:
   - **Google**: require `openGenerationAiStudio` in `supportedActions` (avoids 100+ deploy-only models)
   - **Non-Google from API**: probe ALL text LLM candidates (no `supportedActions` filter — third-party models don't have it)
   - **MaaS-only partners** (Anthropic, xAI): added as `MAAS_ONLY_MODELS` since they’re not in the API
   - **Skip non-text publishers**: advimman, dandelin, stability-ai, etc.
   - Excludes: image, video, TTS, embed, vision, OCR, medical, etc. (~60 exclusion keywords)
4. **Probe** each candidate:
   - Google: `generateContent` (regional + global fallback for preview)
   - Anthropic: `rawPredict`
   - All others: OpenAI-compatible `/endpoints/openapi/chat/completions`
   - Batched 10 parallel, 10s timeout each
5. **Results** returned synchronously + written to Firestore `config/models` (project-level) + per-Prime for backward compat
6. **Brain page** reads the same `modelCatalog` → picker shows only `status=="available"` models as selectable
7. **Frontend** dynamically generates provider groups, colors, and labels for any provider slug

### Brain Architecture (Autonomous Multi-Agent Orchestrator)

Prime and fleet use 6 OpenClaw agents in a multi-agent configuration. The core design
principle: **LLMs think. Deterministic systems move data, enforce rules, and deliver output.**

| Agent | Model | Role | Workspace | Tools |
|-------|-------|------|-----------|-------|
| **cortex** | gemini-3.1-pro-preview | Plan executor + synthesizer (DEFAULT) | `~/.openclaw/workspace` | read, write, edit, exec |
| **temporal-research** | gemini-2.5-flash | Web search (Vertex AI grounding) | `~/.openclaw/workspace-temporal-research` | exec (agent-ask only) |
| **temporal-memory** | gemini-2.5-flash | Pure memory recall (NO external APIs) | `~/.openclaw/workspace-temporal-memory` | read, exec (core-memory-read only) |
| **prefrontal** | gemini-2.5-flash | Two-mode dispatch planner (simple + advisory) | `~/.openclaw/workspace-prefrontal` | read only |
| **motor** | gemini-2.5-flash | Execution + advisory mode + ALL Workspace tools | `~/.openclaw/workspace-motor` | read, write, edit, exec |
| **cerebellum** | gemini-2.5-flash | Validation-rule checking + QA | `~/.openclaw/workspace-cerebellum` | read, exec |

**Brain State Machine (agent-brain.mjs):**
The `agent-brain` daemon runs as a continuous systemd service on both Prime and all fleet VMs. It implements a fully robust, envelope-based pipeline.
1. **Intake Processing & Contextual Ack:** Ears claims an incoming request and writes it to the Firestore `intake/` collection. `agent-brain` picks it up, extracts the current message from the composite intake (parsing past the context preamble), generates a contextual LLM-voiced acknowledgment (personality-aware, references what the user actually asked, includes recent mission history and project context for continuity awareness), and starts the Cortex decide loop. The ACK is marked `[BRAIN-ORCHESTRATED]` to prevent double delivery by mouth's JSONL tailer.
2. **Cortex JSON Decide Loop:** Cortex classifies the intake and directs the progress of envelopes (representing work) by returning structured JSON decisions (`action: "classify"|"decide"|"short_circuit"|"dispatch"|"continue"|"synthesize"`). The `continue` action re-dispatches timed-out tasks with check-first context, avoiding redundant work.
3. **R/M/C/T Cognitive Hierarchy:** 
   - **Responsibilities (R):** Cron-scheduled recurring duties. Configured in `responsibilities-job.json` and hot-reloaded by a file watcher. Can link to stored processes via `processRef` for deterministic execution (skips Cortex decide step).
   - **Missions (M):** Multi-checkpoint, high-level objectives with clear definitions of done.
   - **Checkpoints (C):** Observable milestones with concrete completion criteria. Support 5 step types: `standard`, `delegation`, `spawn_responsibility`, `approval_gate`, `optional`.
   - **Tasks (T):** Specific, atomic execution steps.
4. **Context Assembly & Generation Parameters:** System prompt loads `SOUL.md` + `IDENTITY.md` + `MEMORY.md` + the full agent registry from `agent-registry.json` (~20K tokens). Generation parameters (max_tokens, temperature, top_p) are mapped per sub-agent dynamically. Motor is configured with 65536 max output tokens for rich artifact production.
5. **Envelope Context Accumulation:** Rolling 400K token budget is attached to the envelope history. Pruning keeps the first 10% (ambient context) and the last 90% (most recent activity) of the token window.
6. **Cross-Agent Delegation:** Envelopes can be delegated to other fleet agents (e.g. Prime to PM/Stan). `agent-brain` yields execution and resumes once the child envelope reports success.

**Tool ownership (strict boundaries — fleet agents):**
- Fleet Motor owns Workspace tools per job type: devops (Drive+Gmail), pm (Drive+Gmail+Docs+Sheets), assistant (Drive+Gmail+Calendar+Docs), etc.
- temporal-memory has ZERO external API tools — pure memory only
- cerebellum has read-only verification tools

**Prime tool ownership (infrastructure only):**
- Prime has ZERO Google Workspace tools — no Drive, Gmail, Calendar, Docs, or Sheets
- Prime Motor has fleet lifecycle tools: fleet-deploy, fleet-hire, fleet-fire, fleet-status, fleet-upgrade, fleet-verify
- Prime skills are focused on fleet management and will be progressively exposed through the dashboard for manual triggering

**Dynamic skill awareness:** `assemble-tools` generates `TOOLS.md` from the agent type's skill list (in `agent-registry.json`) and copies it to cortex, prefrontal, and motor workspaces. Prefrontal reads TOOLS.md to know which tools are available before planning.

**Three-layer memory model:**
- **Working Memory (`MEMORY.md`):** Loaded into every Cortex system prompt. Agent's RAM — accumulates freely during the day, pruned nightly to < 2,000 chars.
- **Core Memory (Firestore):** `core_memory` collection. Long-term durable facts. Actively pruned: stale entries retired via `core-memory-retire`, contradicted entries superseded, new facts promoted. Queried via time-windowed `core-memory-read --since`.
- **Deep Truths (`SOUL.md`):** Behavioral firmware in the `## Deep Truths` section. Changes only during nightly consolidation with evidence spanning 3+ sessions and 7+ day stability. Max 10 items, max 2 changes per run.
- **Dual-pass recall:** `temporal-memory` performs targeted archive search (all time) + broad recent scan (30 days) + context fill (follow-up on old hits).
- **Nightly consolidation:** 10-step responsibility-driven process (gather → triage → reconcile T2 → retire stale → promote → prune T1 → review Deep Truths → report). Max 5 T2 writes/retires + 2 Deep Truth changes per run.

**Locked-in design decisions:**
- 🔒 Web search = `exec agent-ask` (Vertex AI grounding). NEVER native web-search tool.
- 🔒 `temporal-research` is the ONLY agent capable of web search.
- 🔒 `temporal-memory` has ZERO external API tools — pure memory only.
- 🔒 Fleet Motor owns Google Workspace tools per job type (never globally). Prime Motor has ZERO Workspace tools.
- 🔒 Prime is infrastructure only — fleet management, visibility, hire/fire. Never a worker. No Workspace skills.
- 🔒 SOUL.md above `## Deep Truths` is IMMUTABLE.
- 🔒 Core Memory writes happen via nightly consolidation, NOT during conversation turns.
- 🔒 Deep Truths: max 10 items, single-line bullets, immutability enforced above `## Deep Truths` marker.



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
- `specialties/devops/workspace/` → DevOps specialty (identity + boundaries only)
- `specialties/engineer/workspace/` → Engineer specialty (identity + boundaries only)
- `brain/fleet/_base/` → Generic fleet template (fallback) + shared protocol block

**Dynamic SOUL.md composition:** Specialty SOULs contain only identity-specific content (Core Identity, What I Do, Boundaries). The shared "How I Work" protocol block lives in a single file: `brain/fleet/_base/SOUL_PROTOCOL.md`. At bootstrap, `fleet-bootstrap.sh` step 4c concatenates: specialty identity fragment + SOUL_PROTOCOL.md → final deployed SOUL.md.

At bootstrap, `fleet-bootstrap.sh`:
1. Clears the workspace directory (removes any inherited Prime files)
2. Copies specialty files (e.g., `workspace-devops/`) if they exist, else falls back to `workspace-fleet/`
3. Applies template variables: `{{AGENT_NAME}}`, `{{SPECIALTY}}`, `{{PROJECT_ID}}`, `{{DEPLOY_TIMESTAMP}}`
4. **Composes SOUL.md** by appending SOUL_PROTOCOL.md to the specialty identity fragment

`upgrade-corekit` also restores specialty workspace files after a CoreKit update to prevent identity regression.

### Naming Convention

- Agent name: lowercase alphanumeric with hyphens (e.g., `stan`, `anora`)
- VM name: `fleet-{name}` (e.g., `fleet-stan`)
- Service account: `fleet-{name}@{project}.iam.gserviceaccount.com`
- Workspace email: `{specialty}-agent-{name}@{workspace-domain}` (e.g., `devops-agent-stan@yourdomain.com`)
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
│   ├── src/app/page.tsx              # Home (Prime cards, deploy, onboarding)
│   ├── src/app/p/[id]/               # Prime hub + sub-pages
│   │   ├── page.tsx                  # Prime Hub (status strip + 6 nav cards)
│   │   ├── chat/                     # Prime Chat (operator ↔ Prime conversation)
│   │   ├── fleet/                    # Fleet (agent card wall, hire modal)
│   │   ├── work/                     # Fleet Work (real-time mission tree)
│   │   ├── projects/                 # Projects list + detail (real-time Firestore)
│   │   ├── models/                   # Prime Models (provider-grouped LLM config)
│   │   ├── settings/                 # Prime Settings (VM, upgrade, teardown)
│   │   └── a/[agent]/                # Per-agent pages
│   │       ├── page.tsx              # Agent Hub (status + 5 nav cards)
│   │       ├── chat/                 # Agent Chat (activity timeline + DM)
│   │       ├── work/                 # Agent Work (filtered timeline)
│   │       ├── brain/                # Agent Brain (6-slot LLM picker)
│   │       ├── skills/               # Agent Skills (installed kits)
│   │       └── settings/             # Agent Settings (identity, fire, upgrade)
│   ├── src/app/settings/             # Dashboard Settings (GCP, DWD, OAuth)
│   ├── src/app/skills/               # Skill Kit Library (global registry)
│   ├── src/app/api/primes/[id]/      # REST API routes (28 endpoints)
│   ├── src/app/api/skills/           # Skill Kit registry API
│   ├── src/components/               # Shell, Breadcrumb, NavCard, StatusStrip, AgentChip
│   ├── src/contexts/                 # PrimeContext (shared state)
│   ├── src/hooks/                    # useProjects (real-time Firestore)
│   ├── src/lib/                      # Firestore, auth, types, API utilities
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
│   │   ├── job-swe.txt               # SWE specialty (maps to engineer workspace)
│   │   ├── job-engineer.txt          # Engineer specialty workspace
│   │   ├── job-qa.txt                # QA specialty workspace
│   │   ├── job-pm.txt                # PM specialty workspace
│   │   ├── job-finance.txt           # Finance specialty workspace
│   │   ├── job-data.txt              # Data specialty workspace
│   │   ├── job-security.txt          # Security specialty workspace
│   │   └── job-assistant.txt         # Assistant specialty workspace
│   └── deploy/                       # Standalone install/uninstall scripts
├── corekit/                          # MODULE 3: CoreKit Runtime (59 VM-side scripts)
│   ├── fleet/                        # Fleet lifecycle (9 scripts)
│   ├── gateway/                      # OpenClaw gateway management (5 scripts)
│   ├── chat/                         # Google Chat / DWD integration (3 scripts)
│   ├── brain/                        # Brain execution layer (11 scripts)
│   ├── daemon/                       # Ears/Mouth I/O services (8 files)
│   ├── memory/                       # Memory subsystem (3 scripts)
│   ├── dashboard/                    # Dashboard bridge (1 script)
│   ├── system/                       # Cross-cutting utilities (2 scripts)
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
│   ├── devops/workspace/             # DevOps specialty (3 files)
│   ├── engineer/workspace/           # Engineer specialty (3 files)
│   ├── qa/workspace/                 # QA specialty (3 files)
│   ├── pm/workspace/                 # PM specialty (3 files)
│   ├── finance/workspace/            # Finance specialty (3 files)
│   ├── data/workspace/               # Data specialty (3 files)
│   ├── security/workspace/           # Security specialty (3 files)
│   └── assistant/workspace/          # Assistant specialty (3 files)
├── skills/                           # MODULE 6: Skill Packages
│   ├── agent-ask/                    # Vertex AI grounding web search
│   ├── workspace-drive/              # Google Drive (9 tools + ws-token)
│   ├── workspace-gmail/              # Gmail (5 tools)
│   ├── workspace-calendar/           # Calendar (5 tools)
│   ├── workspace-docs/               # Docs (6 tools)
│   ├── workspace-sheets/             # Sheets (3 tools)
│   ├── fleet-hire/                   # Deploy a new fleet agent
│   ├── fleet-fire/                   # Remove a fleet agent
│   ├── fleet-status/                 # Query fleet status
│   ├── fleet-verify/                 # Verify agent health
│   ├── fleet-upgrade/                # Upgrade agent CoreKit
│   └── memory-consolidate/           # Nightly memory consolidation
├── docs/                             # Architecture documentation
│   └── architecture/                 # AGENT_DESIGN, BRAIN_ARCHITECTURE, R/C/M spec
├── MISSION_PLAN.md                   # This document
└── README.md
```

### CoreKit Tools (40 scripts, grouped by domain)

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
| **chat/** | `chat-send` | Sends messages to Google Chat via DWD |
| | `chat-read` | Reads messages from Google Chat via DWD |
| | `dwd-token` | Generates DWD OAuth2 tokens via GCE metadata signJwt (identity-locked) |
| **daemon/** | `agent-ears.mjs` | Deterministic input processing (poll, dedup, rate-limit, context window, fire-and-forget) |
| | `agent-mouth.mjs` | JSONL-native output processing (tailer, turn state machine, status updates, classify, deliver) |
| | `mouth-classify-prompt.md` | LLM classify/voice prompt template (loaded at startup) |
| | `mouth-status-prompts.md` | Status update prompt templates: ack (5s) + two-minute (120s) |
| | `start-agent-ears` | Container bootstrap wrapper for ears |
| | `start-agent-mouth` | Container bootstrap wrapper for mouth |
| | `ears-health-check` | Ears service health check |
| | `mouth-health-check` | Mouth service health check |
| **brain/** | `brain-telemetry-write` | Writes dispatch telemetry event to Firestore (fire-and-forget) |
| | `brain-telemetry-read` | Queries recent dispatch telemetry for debugging (table or JSON) |
| | `agent-ask` | Vertex AI grounding web search (used by temporal-research) |
| | `agent-status` | Reads/writes agent STATUS.json |
| | `assemble-tools` | Builds TOOLS.md from skill definitions |
| | `task-log-write` | Writes structured task lifecycle record to Firestore |
| | `task-log-read` | Queries recent task records from Firestore |
| | `responsibility-manage` | CRUD for responsibilities-job.json (create/update/list/delete) + `--process-ref` linking |
| | `project-manage` | CRUD for project context/phases + `--processes` for standard process linking |
| **memory/** | `core-memory-read` | Queries Firestore Core Memory by category/tags |
| | `core-memory-write` | Writes durable facts to Firestore Core Memory |
| | `update-deep-truths` | Safely updates the Deep Truths section at end of Cortex SOUL.md |
| **dashboard/** | `command-runner` | Executes commands from Firestore, streams output |
| **system/** | `upgrade-corekit` | In-place CoreKit update from GitHub ref (validates contracts post-upgrade) |
| | `validate-contracts` | Pre-flight check: all cross-cutting values match contracts.json |

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
| `/var/log/agent-ears.log` | Ears service log |
| `/var/log/agent-mouth.log` | Mouth service log |

---

> **Note:** The fleet table below reflects the current operator deployment. Agents are operator-specific.

| Agent | Specialty | VM | Email | Status |
|-------|-----------|-----|-------|--------|
| stan | devops | fleet-stan | devops-agent-stan@{workspace-domain} | Online |

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

### Completed: v2026.05.01.4.0 — Watchdog & Delivery Reliability
> *Eliminated phantom timeout messages, fixed orphaned daemon processes, achieved 0 contract violations.*

1. **Root cause: orphaned daemon processes** — `docker exec` only kills the host-side process on `systemctl restart`; the Node.js process inside the container survives. Over multiple upgrades, 10+ orphaned daemons accumulated, each independently polling Firestore and running their own (outdated) watchdogs. `upgrade-corekit` now runs `pkill -f message-daemon.mjs` inside the container before restart.
2. **Watchdog TASK.json detection (Path 0)** — Added fastest delivery detection: polls `TASK.json` for `status: complete` (set by `channel-respond`). Catches delivery before the slower Firestore query or log parser.
3. **Faster watchdog timing** — Interval: 15s → 10s. Timeout: 5min → 3min.
4. **File-based daemon logging** — `docker exec` doesn't reliably forward stdout/stderr to systemd journal. Daemon now writes to `/tmp/message-daemon.log` inside the container via `appendFileSync` for guaranteed audit trail.
5. **`.env` location fix** — `upgrade-corekit` auto-adds `GOOGLE_CLOUD_LOCATION=global` to `/root/openclaw/.env` before validation. Eliminates the persistent 1-violation report.
6. **Bind-mount cache race fix** — `sync` + `sleep 1` before daemon restart ensures Docker sees the updated file.
7. **Version prefix discipline** — Development workflow documents that every commit on `main` must start with `vYYYY.MM.DD.X.Y:` to prevent "update unknown" in dashboard.

### Completed: v2026.05.03.5.0 — Multi-Step Brain + Drive Organization
> *Cortex plans and executes multi-step workflows using real Google Drive tools.*

1. **Brain hardening** — Fixed BRAIN_CARD.md / SOUL.md dispatch contradiction. All agents (Prime + fleet) now use `sessions_spawn` / `sessions_yield` instead of legacy `brain-exec` for sub-agent dispatch.
2. **Fleet brain parity** — Fleet agents now have BRAIN_CARD.md (PreTurn injection), plan-compliance (PostTurn validation), and `sessions_yield` in tool allow list.
3. **Stateful PLAN.md** — Cortex writes and updates `workspace/PLAN.md` with tracked step markers (`[ ]` → `[x]`) and result summaries. Multi-step chaining with context passing between sequential dispatches.
4. **Workspace-Drive skill** — 9 Drive tools (`ls`, `search`, `download`, `upload`, `mkdir`, `rename`, `delete`, `move`, `share`) deployed via `skills/workspace-drive/`. Auth via DWD with per-agent Workspace email isolation. 403 graceful handling returns actionable JSON.
5. **ws-token bug fix** — `ws-token` now explicitly passes `--user` to `dwd-token`, preventing silent wrong-identity impersonation.
6. **Watchdog timeout** — Bumped from 180s to 300s to accommodate multi-step dispatch chains.
7. **Drive API enabled** — Added `drive.googleapis.com` and `chat.googleapis.com` to project bootstrap (`install.sh`).

### Completed: v2026.05.03.6.0 — Brain Architecture v2 (Prefrontal-First Gate)
> *Decomposed brain monolith into deterministic services. LLMs think; deterministic systems move data.*

1. **Prefrontal-first gate** — Prefrontal is now the mandatory dispatch planner. Produces structured `DISPATCH_PLAN:` blocks with intent, pipeline, reasoning. Cortex stripped of ALL classification logic — executes plans mechanically.
2. **Tool reassignment** — Fleet Motor owns Workspace tools per job type (devops: Drive+Gmail, pm: Drive+Gmail+Docs+Sheets, etc.). Prime Motor has ZERO Workspace tools. temporal-memory stripped to pure memory (core-memory-read/write only, zero external API calls).
3. **Ears/Mouth decomposition** — `message-daemon.mjs` monolith decomposed into `agent-ears.mjs` (100% deterministic input) and `agent-mouth.mjs` (1 LLM classify call + deterministic delivery). Independent systemd services with health checks. Code complete, not yet active.
4. **Dynamic skill awareness** — `assemble-tools` now copies TOOLS.md to prefrontal and motor workspaces. Prefrontal reads TOOLS.md to know what skills are available before planning.
5. **brain-exec v2** — Rewritten with `--plan-exec` (execute pipeline step) and `--validate-plan` (deterministic invariant checking). Rejects temporal-memory/prefrontal in pipelines.
6. **Contracts extended** — Added `ears` and `mouth` config sections to contracts.json for service-level tuning.

### Completed: v2026.05.03.7.0 — Brain v2.1 (Gate Enforcement + Advisory Planning)
> *Enforced the prefrontal gate. PLAN.md write gate. Validation rules. Two-mode prefrontal. Multi-step Drive organization validated end-to-end.*

1. **BRAIN_CARD stripped** — Removed ALL routing intelligence, classification tables, and capability hints. BRAIN_CARD now contains only: agent names, spawn/yield syntax, and the mandatory rule "spawn prefrontal first, always."
2. **PLAN.md write gate** — Cortex MUST write `workspace/PLAN.md` with `PLAN_VALID` marker before executing any pipeline. Plan is copied verbatim from prefrontal, preserving all `→ VALIDATION:` lines.
3. **Validation rules** — Prefrontal produces `→ VALIDATION:` criteria for every motor step. Cerebellum reads PLAN.md and checks each rule against execution results.
4. **PostTurn compliance** — `check-plan-compliance` hardened: checks PLAN_VALID marker, 120s freshness window, counts validation rules, logs violations to telemetry.
5. **Two-mode prefrontal** — Mode 1 (Simple): immediate DISPATCH_PLAN for clear tasks. Mode 2 (Complex): returns PLANNING_ROUND_REQUIRED with task-specific advisory questions.
6. **Advisory round** — Each advisor is asked "how would you accomplish [their piece]?" Motor proposes execution approach from TOOLS.md. Prefrontal assembles all proposals into the final plan.
7. **Motor advisory mode** — Motor can now operate in advisory mode (propose approach, never execute) or execution mode (always execute, never describe).
8. **ws-token/dwd-token path fix** — All 10 Drive tools + ws-token + dwd-token now auto-detect container vs host paths. Fixed nested `OC_HOST_ROOT` resolution.
9. **Validated end-to-end** — Multi-step Drive organization: list files → create 3 sub-folders → move 5 files → upload readme → cerebellum verification. All components worked: prefrontal gate, PLAN.md gate, motor execution, cerebellum validation.

### Completed: v2026.05.03.9.0 — Identity Lockdown + Task Lifecycle
> *Deterministic agent identity, DWD impersonation guard, structured task logging, mouth voice fix.*

1. **Deterministic identity** — `{{AGENT_USER_EMAIL}}` injected into IDENTITY.md at bootstrap/upgrade. Agents know their own Workspace email.
2. **Identity lockdown** — `.identity-lock` file (chmod 444) written at bootstrap/upgrade. `dwd-token` refuses to impersonate any email that doesn't match.
3. **Task lifecycle logging** — `task-log-write` fires on every delivery/timeout. Structured records in Firestore (`primes/{primeId}/fleet/{agent}/tasks/{taskId}`).
4. **Task log reader** — `task-log-read` queries recent tasks from Firestore (by agent, by count, or by task ID).
5. **Mouth voice fix** — Classify prompt rewritten so mouth speaks AS the agent (first person), not as a relay.
6. **Byte-offset log fix** — Gateway log reading uses Buffer (byte offsets) instead of string (char offsets), fixing multi-byte UTF-8 character misalignment.
7. **Stray re-delivery fix** — Log offset initialized to current file size on startup, preventing re-delivery of old output on service restart.
8. **ACK removal** — Removed "Processing your request..." message from ears — mouth delivers fast enough.

### Completed: v2026.05.03.10.0 — Repo Hardening Audit (3-pass, 69 items)
> *Systematic audit fixing runtime bugs, dead code, stale docs, and architectural rot across the entire repository.*

1. **Contract validation fixed** — `validate-contracts` glob pointed at nonexistent `bundle/` directory; silently passing. Now uses correct `corekit/config/` path.
2. **agent-ask model/region fixed** — Was hardcoded to `gemini-2.0-flash` + `us-central1`. Now reads from `contracts.json` with global endpoint support.
3. **Identity lockdown extended** — ears/mouth had inline DWD that bypassed `.identity-lock`. Both now check lockfile at startup and refuse to start on mismatch.
4. **Calendar bug fixed** — `check-plan-compliance` PostTurn gate used date-based log path; silently disabled after midnight UTC. Now uses most-recent log file.
5. **fleet-monitor milestone fixed** — `"Gateway is ready"` never matched fleet-bootstrap's `"Gateway ready"` output. Deploy progress now tracks gateway startup.
6. **web-search bypass deleted** — CoreKit script provided exec side-channel around the `deny: ["web-search"]` policy. Removed script + manifest entry.
7. **model-catalog.json deleted** — Dead static config not installed by any manifest, not read by any script. Dashboard claim corrected to reference `discover-models`.
8. **brain-exec header fixed** — Documented nonexistent DEFAULT mode; removed dead `approval_needed` parser.
9. **Stale docs purged** — Deleted 10 obsolete specialty workspace files, 6 phantom Google Workspace skills, broken CI workflow, drifting resource copies (~3,700 lines removed).
10. **All agent-facing docs updated** — SKILL.md files for agent-ask, memory-consolidate, corekit-script, workspace-author, brain-architecture all rewritten to match production architecture.
11. **corekit/README rewritten** — Removed bundle/, pnpm, cp004-ok, static date. Now reflects manifest installer workflow.
12. **bundle/ sweep** — Replaced phantom `bundle/` paths in R/C/M spec, RESP_SPEC, AGENT_DESIGN, BRAIN_ARCH, coding-standards.
13. **hire API hardened** — Removed hardcoded `tachin.ai` email fallback; email is now a required parameter.

### Completed: v2026.05.03.11.0 — Final Audit + Agent Job Kits
> *Final audit pass + full agent fleet deployment readiness. All 7 agent types deployable.*

1. **validate-contracts repo mode fixed** — Root detection changed from `contracts.json` walk to `.git` marker; paths corrected to `infra/contracts.json` and `infra/bootstrap/`.
2. **7 agent types deployable** — Created 5 new specialty workspaces (qa, pm, finance, data, security) + 6 job manifests (swe, qa, pm, finance, data, security). All specialties use prefrontal-first brain pattern.
3. **Unified brain pattern** — All specialty SOULs (including existing devops + engineer) updated to prefrontal-first dispatch. Prime and fleet share the same brain architecture.
4. **Dashboard email field hardened** — Removed "(optional)" label; hire button disabled when email is empty.
5. **tachin.ai fallbacks eliminated** — `fleet-hire` and `command-runner` now error on missing email domain instead of silently injecting `@tachin.ai`.
6. **Dead code purged** — Removed `sendACK()` function (25 lines), phantom `web-search` from tools table, duplicate manifest entries, dead `install-cached.sh` reference.
7. **Documentation synchronized** — Script counts (41→40), tool counts (27→9 Drive), disk sizes (30→50GB), specialty file counts (8→3), bootstrap paths, version strings all corrected.
8. **SKILL_ARCHITECTURE.md deprecated** — Marked as historical reference; canonical architecture is in MISSION_PLAN.
9. **Google Workspace skill suite** — 4 new skill packages: Gmail (5 tools), Calendar (5 tools), Docs (6 tools), Sheets (3 tools). 19 new CoreKit bash scripts, all following the DWD ws-token pattern with 403 error handling.
10. **Assistant agent type** — New `assistant` specialty for scheduling, communications, admin. Full Workspace suite: Drive + Gmail + Calendar + Docs.
11. **DWD scope expansion** — CHAT_SETUP.md OAuth scopes updated to include Gmail, Calendar, Drive, Docs, Sheets, Contacts.
12. **Memory consolidation activated** — Uncommented nightly cron job in both Prime and fleet bootstrap configs (2am CT via temporal-memory).
13. **Agent-types.json hardened** — Fixed workspace field for qa/pm/finance/data/security (was "fleet", now points to their actual specialty). Added Workspace skill assignments per agent role.
14. **Motor SOUL expanded** — Both Prime and fleet motor SOULs now document all 28 Workspace tools (Drive 9, Gmail 5, Calendar 5, Docs 6, Sheets 3).

### Completed: v2026.05.05.12.0 — Fleet Auth Stabilization + Mouth Persona
> *Reverted OpenClaw regression, fixed bootstrap quoting, redesigned mouth as agent's voice.*

1. **OpenClaw pin reverted to v2026.4.15** — v2026.5.2 removed `google-auth-library` GCE metadata support, breaking service account ADC on all fleet VMs. Reverted `contracts.json` and `upgrade-openclaw` DEFAULT_PIN.
2. **fleet-bootstrap bash syntax fix** — Embedded Python ADC patcher caused `line 455: syntax error near unexpected token '('` due to nested quoting in `docker exec bash -c`. Restructured: auth-profiles in its own `docker exec` block, Python patcher written to host via `cat > /tmp/patch-adc.py << 'PYEOF'` heredoc, then `docker cp`'d into the container.
3. **ADC patcher false-positive fix** — The "already patched" check was `'gce metadata' in code`, which false-positived when a v2026.5.x fallthrough injection existed alongside an unpatched v2026.4.x sentinel. Now checks specifically for `<gce-adc>` AND that the sentinel `if (!envKey) return null;` is absent.
4. **Mouth brain→mouth architecture** — Redesigned classify prompt: mouth IS the agent's voice, raw brain output is the agent's own thoughts to be spoken naturally. Removed fact-injection approach (email, name stuffing). Agent name passed only for self-reference.
5. **Mouth human question context** — Classify LLM now receives the human's original question (from TASK.json) alongside the brain output, preventing misinterpretation of response direction.
6. **Mouth agent identity env vars** — `start-agent-mouth` reads `agentDisplayName` and `agentFirstName` from `chat-config.json`, passes as env vars to the mouth container.
7. **Removed google-workspace-skills** — Deleted stale reference folder (34 files, 1,449 lines). All skills now live in `skills/`.


### Completed: v2026.05.05.13.0 — Prefrontal Hard Gate + Validation Architecture
> *Enforced prefrontal gate, dynamic SOUL composition, cerebellum as test runner.*

1. **Prefrontal gate enforced** — BRAIN_CARD stripped to bare agent names + "spawn prefrontal first" (zero routing knowledge — no agent descriptions, no pipeline mechanics). SOUL.md teaches plan execution but not plan construction. Litmus test: cortex cannot route a Drive request without prefrontal.
2. **Dynamic SOUL.md composition** — Specialty SOULs reduced to identity-only fragments (~25 lines). Shared protocol block (`SOUL_PROTOCOL.md`) lives in one place. `fleet-bootstrap.sh` step 4c concatenates specialty + protocol at deploy time.
3. **PLAN_STATUS: APPROVED hard gate** — `check-plan-compliance` promoted from warning logger to hard gate. Violations write structured `PLAN_VIOLATION` to stdout → OpenClaw injects back into cortex's session. Checks: PLAN_VALID + PLAN_STATUS: APPROVED + 60s freshness.
4. **Validation mandatory for ALL steps** — Prefrontal must produce `→ VALIDATION:` for every pipeline step (not just motor). Operation-specific guidance (read/write/build/research). If criteria can't be articulated, refuse to plan.
5. **Cerebellum as test runner** — Converted from subjective reviewer to pure test runner. Structured verdicts: `ALL_PASS`, `FAIL (N of M)`, `NO_RULES`. No subjective quality review fallback.

### Completed: v2026.05.08.14.0 — Mouth v2 (JSONL-Native) + Ears Context Window
> *Eliminated double deliveries. Structural output detection. Status updates. Ambient chat context.*

1. **Mouth v2 — JSONL-native output processing** — Replaced fragile log-file scraping with deterministic tailing of OpenClaw's JSONL session transcripts. Structurally distinguishes final assistant responses from intermediate tool calls/results.
2. **Turn state machine** — IDLE → WORKING → ACKED → UPDATED → DONE. Tracks dispatched agents, candidate finals, and structural confirmation (2s settling window).
3. **Status updates** — LLM-voiced acknowledgment at 5s and progress update at 120s. Deterministic fallback text if LLM fails. Configurable via `contracts.json`.
4. **Prompt externalization** — All mouth prompts moved from inline JS to external `.md` files (`mouth-classify-prompt.md`, `mouth-status-prompts.md`). Simple `{variable}` replacement, no handlebars.
5. **LLM JSON mode** — Classify call uses `responseMimeType: 'application/json'` for reliable structured output.
6. **Ears context window** — When an @mention is detected in GChat, ears includes the prior N messages (default 5) from the space as context. Format: `[Chat messages since your last reply - for context]` + sender names + `[Current message - respond to this]`. Agent's own messages labeled as "You".
7. **Contracts extended** — Added `mouth.source: "jsonl"`, `mouth.status_updates` (enabled, ack_after_ms, update_after_ms), `ears.gchat_context_messages: 5`. `validate-contracts` updated to check mouth config fields.

### Completed: v2026.05.18.15.0 — Chat Input Hardening & LLM Preprocessor
> *Restored deterministic agent-to-drive communication by intercepting and repairing Chat-mangled text.*

1. **LLM Preprocessor in ears** — Added a Gemini 2.5 Flash preprocessing step in `agent-ears.mjs` to automatically repair markdown-mangled identifiers (like stripped underscores in Drive folder IDs) before dispatch to the OpenClaw brain.
2. **Preprocess Logging** — Added detailed audit logging to `/var/log/agent-ears-preprocess.log` to record original text, cleaned text, repairs made, and LLM confidence.
3. **Drive Skill Hardening** — Updated all workspace-drive tools (`upload`, `ls`, `search`, etc.) to include `supportsAllDrives=true` and `includeItemsFromAllDrives=true` to resolve 404s.
4. **Agent Identity Fallback** — Updated `ws-token` to resolve the agent identity via `chat-config.json` when `AGENT_USER_EMAIL` is missing, solving systemic 401 authentication issues.
5. **Prompt Management** — Added `ears-preprocess-prompt.md` to `corekit/daemon/` and updated `infra/manifests/base.txt` to deploy it.

### Completed: v2026.05.18.16.0 — Memory Pipeline Stabilization & Prefrontal Gate
> *Repaired long-term memory sync and strictly enforced the prefrontal delegation boundary.*

1. **Memory Pipeline Repaired** — Fixed Firestore pathing in `core-memory-write` and `core-memory-read` to properly target the `core_memory` collection. Handled Windows CRLF in `update-deep-truths` to successfully sync deep truths into `SOUL.md`. (Note: The required `core_memory` Firestore composite index should be automated in the Dashboard `/api/setup` bootstrap).
2. **Prefrontal Hard Gate Enforced** — Revoked root `exec` and `process` privileges from the `cortex` agent definition. Cortex is now strictly forced to delegate terminal commands to `motor` via `sessions_spawn`.
3. **Ears Recency Anchoring** — `agent-ears` now dynamically wraps incoming GChat/Dashboard messages in a structured JSON payload, injecting a mandatory `system_directive` reinforcing delegation directly beside the user input.

### Completed: v2026.05.19.17.0 — Brain v3 Phase 6 (Work Tree Dashboard + Delegation)
> *Envelope-based Brain v3 orchestration live on Stan. Dashboard Work tab with M→C→T tree. Human-in-the-loop. Mouth v3 independent poll.*

1. **Brain v3 Phases 1-6** — Complete rip-and-replace of v2 conversational LLM loop with deterministic envelope-based Firestore pipeline. Cortex classify+decide, memory recall/write, multi-step planning, checkpoint nesting (M→C→T), semantic failure detection, inter-agent delegation.
2. **Dashboard Work tab** — New view showing M→C→T work hierarchy with real-time polling (5s), collapsible tree, status icons, envelope detail panel, human-in-the-loop response form.
3. **Dashboard refactor** — Extracted shared types, API helper, Firebase client to `lib/` modules. Server-side work API using Admin SDK.
4. **Mouth v3 independent poll** — Envelope delivery poll moved from session loop dependency to dedicated 5s `setInterval`. Queries both `complete` and `needs_input` statuses.
5. **Brain delegation** — `delegate` action creates child envelopes across agents. `checkWaitingEnvelopes()` resumes parent when children complete.

### Completed: v2026.05.19.18.0 — Brain v3 Phase 7A (Responsibilities + Context Assembly)
> *Cron-driven autonomous responsibilities, R/M/C/T mental model, rich context assembly (500K tokens), per-agent generation parameters.*

1. **Responsibility scheduler** — Cron parser with next-fire calculation, config hot-reload (file watcher), R→M envelope dispatching. Responsibilities fire autonomously and flow through normal Cortex decide loop.
2. **Option C responsibility architecture** — Responsibility creation is a normal Mission (Cortex classifies → Prefrontal plans process → Motor writes config via `responsibility-manage` → Cerebellum verifies). No special Cortex action needed.
3. **R/M/C/T mental model** — Cortex SOUL rewritten with Responsibility, Mission, Checkpoint, Task as core cognitive identity. Agents naturally classify work into the hierarchy.
4. **`responsibility-manage` Motor tool** — CRUD for `responsibilities-job.json`. Validates required fields (process, purpose, success_criteria). Brain's file watcher auto-reloads.
5. **Rich context assembly** — System prompt now loads SOUL.md + IDENTITY.md + MEMORY.md + full agent registry (~20K tokens). File read cache (60s TTL).
6. **Envelope context accumulation** — Rolling context attached to envelopes: iteration blocks with timestamps, decisions, results. 400K token budget with oldest-first pruning (keep first 10% + last 90%).
7. **Per-agent generation parameters** — agent-registry.json defines max_tokens, temperature, top_p per agent. Motor gets 65536 max_tokens for artifact production. Cortex/Prefrontal get 32768. Cerebellum/Memory get 8192.
8. **Quick Ack** — External messages get immediate acknowledgment while Brain processes.
9. **Gateway parameter validation** — Confirmed OpenClaw passes through max_tokens, temperature, top_p, top_k to Vertex AI.

### Completed: v2026.05.21.1.0 — Memory Architecture Overhaul
> *Three-layer memory lifecycle with active long-term pruning, dual-pass recall, and formally governed Deep Truths.*

1. **Stripped self-monitoring responsibilities** — Removed all fleet agent responsibilities except memory consolidation. DevOps (infra-health-check, deployment-verification), PM (project-status-sync), Prime (fleet-status-check), and base (stale-envelope-review) all cleared. Dashboard/Prime handles monitoring, not the agents themselves.
2. **Three-layer memory model** — Formalized Working Memory (MEMORY.md, agent RAM), Core Memory (Firestore, long-term archive), and Deep Truths (SOUL.md, behavioral firmware) as distinct tiers with explicit lifecycles.
3. **Active T2 pruning** — Added `core-memory-retire` script for retiring stale long-term facts. Consolidation now reconciles recent work against archive, identifies contradictions/outdated entries, and retires them with justification.
4. **Dual-pass recall** — Upgraded `temporal-memory` SOUL for multi-pass retrieval: targeted archive search (all time) + broad recent scan (30 days) + context fill (follow-up on old hits). Enhanced `core-memory-read` with `--since` time-window filter.
5. **10-step consolidation** — Rewrote `r-memory-consolidation` as the single universal responsibility with a detailed 10-step process covering gather → triage → reconcile → retire → promote → prune → Deep Truths → report.
6. **Deep Truths lifecycle** — Formal governance: evidence spanning 3+ sessions, 7+ day stability, 2+ Core Memory citations required. Max 2 changes per run, max 10 total.

### Completed: v2026.05.21.2.0 — Deployment Hardening
> *Resilience fixes for brain daemon intake processing and gateway authentication on fleet deployments.*

1. **Intake error resilience** — Added automatic revert-to-pending on intake processing exceptions in the brain daemon's poll loop. Prevents transient gateway failures from permanently locking intakes in `claimed` status.
2. **ADC patcher fix** — Removed broken v2026.5.x branch from both `fleet-bootstrap.sh` and `upgrade-openclaw` that was injecting `"gcp-vertex-credentials"` (wrong literal key) instead of the `"<gce-adc>"` sentinel required by the Vertex AI provider's regex-based ADC fallback. The v2026.4.x branch correctly handles all known OpenClaw versions.
3. **Cross-agent poll interaction fix** — Hardened the intake polling loop against concurrent access patterns.

### Completed: v2026.05.22.1.0 — Brain v3 Phase 8 (Production Hardening)
> *Complete Phase 7C cleanup and harden the brain daemon for long-running production use.*

1. **Periodic envelope archival** — Replaced startup-only failed-envelope cleanup with interval-based archival sweep (every 6h, configurable). Archives `complete` envelopes older than 7 days, `failed` older than 24h, and `needs_input` older than 72h. Each archival sets `archived_reason` field (`stale_failed`, `delivered`, `unanswered`). Verified on fleet-stan and fleet-anora.
2. **BRAIN_CARD removal** — Deleted `BRAIN_CARD.md` from both prime and fleet workspaces, removed from manifests (`role-prime.txt`, `role-fleet.txt`), stripped PreTurn `brain-card` hooks from both bootstrap templates, updated fleet TOOLS.md reference. Saves ~500 tokens per Cortex turn.
3. **Contracts `brain` section** — Added 8-value `brain` section to `contracts.json` (`poll_interval_ms`, `max_iterations`, `gateway_timeout_ms`, `stale_cleanup_hours`, `archive_age_days`, `archive_interval_ms`, `context_token_budget`, `needs_input_timeout_hours`). All formerly hardcoded constants in `agent-brain.mjs` now read from contracts with fallback defaults. Restructured module init order (contracts loaded before config). Added Check 11 to `validate-contracts` with range validation.
4. **Feature flag removal** — Deleted `BRAIN_V3_ENABLED` gate from `agent-brain.mjs` (the daemon starts unconditionally). Removed env var from `start-agent-brain` launcher.
5. **Dead code cleanup** — Removed unreachable `delegate` action handler (~70 lines) that was masked by normalization to `dispatch`. Fixed `historySeq` process-global counter (reset on restart) with timestamp-based IDs to prevent history collisions.

### Completed: v2026.05.22.4.0 — Brain Hardening & Workspace Persistence
> *Contextual ACK, double-response fixes, escalation behavior, shared workspace persistence across motor sessions.*

1. **Contextual ACK** — Replaced deterministic "Got it — working on this now" with LLM-generated personality-aware acknowledgment. Uses Gemini Flash to produce a brief, contextual ack referencing what the user asked about. ACK timeout increased 10s→15s for cold starts.
2. **Double-response fix (classify short_circuit)** — When Cortex classify returns `short_circuit`, the brain now handles it inline during intake processing instead of creating an envelope and running a redundant decide loop. Prevents duplicate responses.
3. **Double-ACK delivery fix** — Added `[BRAIN-ORCHESTRATED]` marker to ACK gateway calls so mouth's JSONL tailer skips them. Previously, both the JSONL tailer path and the Brain v3 envelope poller were delivering the same ACK.
4. **Escalation-style failure directives** — Brain daemon failure directives now enforce escalation: agents must state exactly what they need, who can provide it, and what specific action to take. Cortex SOUL.md (prime + fleet) updated with `synthesize_with_failure` documentation and Decision Rule #6: "Escalate, don't report."
5. **Shared workspace persistence** — Motor SOUL.md updated with workspace persistence rules: all files must be written to `shared/` directory. Brain daemon `callAgent()` injects `## Workspace` directive with exact path. Checkpoint plans now use mission-scoped shared directories instead of per-checkpoint scoping, so files from CP2 are visible to CP3.
6. **Documentation cleanup** — Deleted retired `docs/architecture/BRAIN_ARCHITECTURE.md`, `docs/architecture/RCM_SPEC.md`, and `docs/architecture/RESP_SPEC.md`. Updated all active docs to current state.

### Completed: v2026.05.23.5.0 — Dashboard OAuth + Security Hardening
> *Google Workspace OAuth for dashboard access control, defense-in-depth on all API routes, security hardening.*

1. **Google Workspace OAuth** — Implemented `next-auth` v4 with Google provider, JWT sessions, and server-side domain restriction (`hd` claim). OAuth credentials stored in Secret Manager (never in env vars). Graceful degradation: dashboard runs in setup mode when unconfigured.
2. **Security hardening** — Added `requireAuth()` defense-in-depth to 16 of 17 POST endpoints. Only `update-status` (fleet VM callback) is exempt. Setup/oauth endpoint requires existing auth to reconfigure when OAuth is active.
3. **Auth middleware** — Primary gate on every request. Exempts auth flow, static assets, and fleet callbacks. Tightened bypass patterns (`endsWith` instead of `includes`).
4. **Error sanitization** — Auth error page maps 11 known NextAuth error codes to safe messages instead of reflecting raw query params. OAuth setup API no longer leaks internal error details.
5. **Custom sign-in page** — Branded sign-in with app icon, dynamic provider loading, `prompt: "select_account"` for Google account picker.
6. **Bootstrap integration** — `install.sh` prompts for OAuth credentials, stores client secret in Secret Manager, grants `secretmanager.admin` to Cloud Run SA. `.env.example` documents all auth variables.
7. **Dashboard documentation** — Replaced default create-next-app `app/README.md` with project-specific docs covering tech stack, auth, env vars, deployment, and project structure.

### Completed: v2026.05.23.6.0 — Delivery Pipeline Fix + Memory Reliability
> *Eliminated 100% mouth query waste. Fixed memory_written false-positives. ACK context extraction. Archival throughput 30x.*

1. **delivery_status field** — Added `delivery_status` (`pending`/`delivered`/`internal`) to all work envelopes. Brain sets `pending` at synthesis/completion, mouth sets `delivered` after delivery. Eliminates the need to scan all complete envelopes — mouth queries only `delivery_status=pending`.
2. **Mouth query restructure** — Primary query: single `owner + delivery_status=pending` (returns only actionable items). Fallback: old 3-status query for migration. Reduces 6 Firestore queries per poll to 1. Composite index deployed.
3. **Archival throughput fix** — `firestoreQuery` helper had hardcoded `limit: 10`, capping archival at 10 items per hour. Increased to 300. Archival can now keep pace with work creation.
4. **memory_written false-positive fix** — `callAgent()` failure pattern detection (`/error.*permission/`, etc.) was applied to ALL agents including `temporal-memory`. When memory stored text containing error keywords from completed work, the call was falsely marked failed, preventing `memory_written` from being set (36/37 missions affected). Fixed by scoping failure patterns to `motor` and `verifier` only.
5. **ACK context extraction** — ACK generator was fed `intakeText.substring(0,300)` which included the full chat context history dump. When context was long, the actual user message was truncated. Fixed by extracting the `[Current message - respond to this]` section before ACK generation.
6. **Backfill completed** — All 365 existing work items backfilled with correct `delivery_status`. Composite Firestore index `(owner, delivery_status, created_at)` deployed.

### Completed: v2026.05.23.7.0 — Dashboard v3 Redesign (1health Design System)
> *Single-page monolith → 17-page breadcrumb-navigated hierarchy. 1health design system. Projects as first-class entity.*

1. **1health design system** — Complete CSS rewrite (883 lines) with healthcare-grade design tokens: Graphite/Charcoal/Slate base, Trust Blue/Network Teal/Care Mint/Signal Aqua accent, Inter typography, 8px grid, premium easing, aqua glow effects.
2. **Multi-page architecture** — Replaced 1355-line `page.tsx` monolith (67KB) with 17 focused page components (~150 lines avg). Every screen has a unique deep-linkable URL.
3. **Breadcrumb navigation** — No sidebar. Global shell with breadcrumb bar auto-populated from URL path. NavCard pattern for forward navigation, breadcrumb for back navigation.
4. **Shared components** — Shell, Breadcrumb, NavCard (4 variants), StatusStrip, AgentChip, PrimeContext (shared React context).
5. **Projects feature** — First-class entity with Firestore collection (`primes/{id}/projects`), CRUD API, real-time listeners via `onSnapshot`, progress tracking, agent chips.
6. **Per-agent pages** — Agent Hub, Chat (activity timeline + @agent DM), Work (filtered timeline), Brain (6-slot LLM picker), Skills (installed kits), Settings (identity, upgrade, fire).
7. **Settings hierarchy** — Three scopes: Dashboard (GCP, DWD, OAuth), Prime (VM, upgrade, teardown), Agent (identity, fire).
8. **Skill Kit Library** — Global registry API (11 kits: base, 2 roles, 8 jobs) + browsable UI with type filters.
9. **Prime Models** — Provider-grouped model grid, per-brain-agent model assignment, scan + save.

### Completed: v2026.05.23.8.0 — Brain Resilience (Timeout Continue + Contextual Ack)
> *Motor timeout detection, cortex continue action, synthesize guard, contextual ack with recent mission + project awareness.*

1. **Motor timeout continue** — Timeouts are now a distinct status (`timed_out`) separate from hard failures. Cortex gets a `continue` action to re-dispatch timed-out tasks with check-first context ("what was already accomplished?") rather than restarting from scratch. Synthesize guard ignores timeouts (only hard failures block synthesis).
2. **Contextual ack upgrade** — Quick acks now include recent mission history (last 5 completed/archived/blocked missions) and project context. Acks recognize when incoming messages relate to prior work and acknowledge continuity instead of treating everything as brand new.
3. **Archival sweep** — `timed_out` envelopes are now archived alongside failed/complete/cancelled envelopes.
4. **DevOps SOUL hardening** — Task decomposition guidance (never combine read + code + build + verify in one dispatch), Google Drive Shared Drive flag requirements, end-to-end verification rules.
5. **Cortex SOUL update** — `continue` action documented in both fleet and prime cortex SOUL.md files.

### Completed: v2026.05.23.9.0 — Living Agent Graph Home Screen
> *Network topology home page with SVG connections, pulse dots, glassmorphic agent cards, and hover-reveal quick-nav.*

1. **Living agent graph** — Replaced flat NavCard grid with interactive network topology. Prime instances as compact selectable chips at top, fleet agents as glassmorphic cards below, connected by animated SVG Bézier curves with traveling pulse dots.
2. **Prime quick-nav** — Icon row (💬📁🌳🧠⚙) for direct navigation to all prime sub-pages without routing through the hub.
3. **Agent cards** — Glassmorphic cards with gradient sheens, staggered spring-eased entry animation, status-coded glow (teal/amber/red), hover lift + scale. Bottom icon row (💬📋🧠🔧⚙) for direct agent sub-page navigation.
4. **SVG connection layer** — Dynamically positioned via `useLayoutEffect` + `ResizeObserver`. Dual pulse dots per line at randomized speeds for organic feel.
5. **Fleet upgrade fix** — Fixed `commandId` → `id` field mismatch in agent settings page that caused all fleet CoreKit upgrades to show false "Failed" toast.

### Completed: v2026.05.24.17.0 — Dashboard UX Upgrade (Split-Panel Home + Fleet Chat + Work Tree)
> *Full-width split-panel home, inline fleet agent chat, deploy progress bars, M→C→T work tree hierarchy.*

1. **Split-panel home screen** — Replaced centered max-width graph with full-width split panel. Left column: agent graph. Right column: inline chat panel with draggable divider (30-80% range). Header is fixed, only columns scroll. No scroll-within-scroll.
2. **Expandable prime chips** — Selected prime chip expands inline to show nav icons (📁 Projects, 🌳 Work, 🧠 Models). No redundant info strip below. Clicking any chip or agent card opens chat.
3. **Fleet agent dashboard chat** — New dual-channel pipeline: Dashboard writes to `primes/{id}/fleet/{agent}/messages` in Firestore; fleet `agent-ears` polls this collection alongside GChat; fleet `agent-mouth` delivers responses to both GChat AND Firestore for dashboard visibility.
4. **Deploy progress bars** — Agent cards show real-time deploy progress (percentage, current step label, amber→red gradient for failures) when `status === 'deploying'`.
5. **Work tree overhaul** — Ported `work-tree-demo.html` spec to live Work page. Hierarchical M→C→T tree with depth indentation, expand/collapse chevrons, status dots with pulse animation, type tags (M/C/T), progress bars on active nodes, amber-bordered waiting callout blocks. Agent strip for filtering. Three tabs (Currently working on, In Queue, Previous Work) with badge counts. Detail modal overlay.
6. **ChatPanel component** — Reusable inline chat for both Prime and fleet agents. Instant snap-to-bottom on load, near-bottom auto-scroll on new messages. 3s polling.
7. **Daemon log file permissions** — Start scripts now pre-create `/var/log/agent-*.log` with `node:node` ownership inside the Docker container before launching daemons.
8. **Nav button fix** — Added `pointer-events: none` to `::before` overlays, `z-index: 2` to nav icons. Removed `overflow: hidden` from prime chips.
9. **Shell scroll fix** — Shell is `height: 100vh; overflow: hidden`. Content area fills parent with `overflow: hidden`. Pages manage their own column scrolling. Header breadcrumb bar never scrolls. No scroll-within-scroll anywhere.

### Completed: v2026.05.24.17.7 — Real-Time Visibility + Agent Introspection + Dashboard Polish
> *Cloud Build polling, real VM skills page, Firestore bus introspection daemon, Shell header redesign.*

1. **Real-time Cloud Build status** — Replaced fake countdown timer with `GET /api/upgrade/status` endpoint that polls Cloud Build API. Dashboard shows live build phase, step number, and elapsed time.
2. **Agent introspection API (Firestore bus)** — New `agent-introspect.mjs` daemon polls `primes/{id}/fleet/{agent}/introspect/{queryId}` for pending queries, reads local filesystem (`~/.openclaw/bin/`, skills, workspace files), writes results back. Supports 6 query types: `skills`, `status`, `config`, `workspace`, `brain_config` (reads live `openclaw.json` model assignments), `set_model` (writes new model config + restarts gateway). Query params decoded from Firestore `params` mapValue. Dashboard proxy at `POST/GET /api/primes/{id}/fleet/{agent}/introspect`.
3. **Real VM skills page** — Skills page now queries the actual agent VM via introspection API instead of showing hardcoded kit lists. Categorized accordion UI (Brain, Workspace, Memory, Chat, Daemon, System). Shows real tool names, descriptions parsed from file headers, and skill pack counts.
4. **Shell header redesign** — Architect Prime logo + title + version moved to the fixed Shell header bar, left-aligned with breadcrumb trail. Removed redundant rocket ship operations button. Breadcrumb no longer shows redundant "Home" text.
5. **Deploy Prime chip** — Deploy button moved from isolated top-right to inline in the prime chip bar as the last chip (dashed border `+` style).
6. **Prime chip clipping fix** — Added top padding to prime chip bar so hover `translateY(-2px)` animation doesn't clip against the header.
7. **Manifest + upgrade integration** — `agent-introspect.mjs`, `.service`, and `start-agent-introspect` added to `base.txt` manifest. `upgrade-corekit` now installs, enables, and restarts the introspect daemon alongside ears/mouth/brain.

### Completed: v2026.05.24.17.16 -- Per-Job Workspace Skills + Body-Part Categorization
> *Workspace tools installed per job type (not globally). Prime has zero Workspace skills. Skills dashboard reorganized by agent anatomy.*

1. **Per-job workspace manifests** -- Moved all Google Workspace skills (Drive, Gmail, Calendar, Docs, Sheets) from global `role-fleet.txt` to individual `job-*.txt` manifests. Each agent type gets only the tools it needs: devops (Drive+Gmail), pm (Drive+Gmail+Docs+Sheets), assistant (Drive+Gmail+Calendar+Docs), data (Sheets), finance (Gmail+Sheets), security (Gmail). SWE/QA get none.
2. **Prime is infrastructure-only** -- Stripped ALL Workspace skills from `role-prime.txt`. Prime has ZERO Google Workspace tools. Prime's Motor has fleet lifecycle tools only (deploy, hire, fire, status, upgrade, verify). Documented as a locked-in design decision.
3. **Body-part skill categorization** -- Skills page reorganized from generic categories (Brain, Workspace, Daemons) to agent anatomy: Ears, Mouth, Brain, Cortex, Motor, Memory, Config, Custom. Auto-categorization by filename pattern in `agent-introspect.mjs`. Documented in project-context for maintainability.
4. **upgrade-corekit syntax fix** -- Fixed corrupted UTF-8 em-dash that contained a literal quote character, causing bash syntax error on every upgrade.
5. **Build progress UX** -- Improved dashboard build status display to show next step name when no step is actively WORKING.
6. **CRLF hardening** -- Extended `.gitattributes` to enforce LF on `*.mjs`, `infra/manifests/*.txt`, `infra/deploy/*`.
7. **agent-ask SKILL.md in fleet** -- Added to `role-fleet.txt` so `assemble-tools` can include it in fleet agents' TOOLS.md.
8. **Fleet skill cleanup** -- Removed orphaned workspace skill files from stan/anora/tom left over from old global installs.

### Completed: v2026.05.24.19.09 — Dashboard UX Overhaul
> *Goal: Unified Prime/Fleet navigation, Brain page for LLM slot management, floating chat overlay.*

1. **Unified navigation** — Prime and Fleet share the same 3-icon nav (Work/Brain/Skills), replacing per-type configs.
2. **Brain page (Prime + Fleet)** — 6-slot LLM grid (Cortex, Prefrontal, Research, Memory, Motor, Cerebellum) with click-to-swap model picker modal.
3. **Model discovery → Settings** — Model scanning/discovery moved to global Settings → Models tab (not per-prime). `/p/{id}/models` redirects to `/settings?tab=models`.
4. **+Hire card** — Dashed "+ Hire" card in fleet grid opens hire modal with dynamic specialty picker (fetches `agent-types.json` from GitHub, 5m cache).
5. **Floating chat overlay** — Chat panel replaced from split-panel layout with glassmorphic slide-in overlay (280ms spring animation, left-edge resize 320-800px, X close button).
6. **Home breadcrumb** — "Home" added as clickable breadcrumb after AP logo on all sub-pages.
7. **Prime Hub** — Replaced Projects with Brain, Models with Skills.
8. **Prime Skills page** — Shows 11 infrastructure-only tools.

### Completed: v2026.05.24.19.51 — Dashboard UX Polish + Cloud Build Fix
> *Header restructure, specialty badges, text nav labels, regional Cloud Build API for real-time progress.*

1. **Header version layout** — Version/stable tag moved below "Architect Prime" as a second line. Clicking the version navigates to Settings → System tab.
2. **Specialty badge in chat** — "Fleet Agent" badge replaced with agent specialty type (DATA, PM, DEVOPS, etc.), moved inline next to the agent name.
3. **Text nav labels** — Emoji icons (🌳🧠🔧) replaced with text labels "Work", "Brain", "Skills" on both prime chips and agent cards.
4. **No hover underlines** — Removed all `text-decoration: underline` on hover globally (fixed duplicate `a` rule in globals.css, updated md-link).
5. **Regional Cloud Build API** — Build submission and status polling switched from global to regional endpoint (`locations/{region}/builds`). Global endpoint only returned overall status; regional provides real-time step-level timing and progress.
6. **Build status UX** — Distinguished QUEUED ("waiting for Cloud Build to start") from WORKING (shows active step + elapsed time).

### Completed: v2026.05.24.20.48 — Top-Level Route Consolidation
> *Work/Brain/Skills promoted to top-level routes with query parameters, 12 old nested routes deleted.*

1. **Top-Level Promotion** — Work, Brain, and Skills pages promoted from nested `/p/[id]/...` and `/p/[id]/a/[agent]/...` structures to global `/work`, `/brain`, and `/skills` routes.
2. **Dynamic URL Params** — Promoted pages use unified `?prime={id}` and optionally `&agent={name}` query parameters to load context dynamically, allowing direct links.
3. **Clean-Up** — Deleted 12 redundant nested route directories, reducing duplicate page logic and styling code.
4. **Component Alignment** — Updated living agent graph and page navigation to direct users to these clean global routes.

### Completed: v2026.05.24.21.32 — Deployment, Scroll & Build Fixes
> *require('os') in ESM chat pickup fix, Brain page ModelInfo object crash fix, Work/Brain/Skills/Settings page vertical scrolling enabling, real-time Cloud Build step progress estimation.*

1. **require('os') ESM Patcher** — Fixed `require('os')` usage inside `agent-ears.mjs` and `agent-mouth.mjs` which was throwing "require is not defined" in Node v24 ESM context. Replaced with clean `import { hostname as osHostname } from 'os'` ESM import. This resolves the silent bug where `AGENT_HOSTNAME` resolved to `""`, causing the fleet dashboard chat pickup poll to permanently short-circuit.
2. **Brain Page Crash Fix** — Fixed a crash on the Brain page caused by the `/api/primes/[id]/models` endpoint returning structured `ModelInfo` objects rather than plain strings. Corrected string operations to read the object attributes safely.
3. **Enable Vertical Scroll** — Re-enabled vertical scrolling for the Work, Brain, Skills, and Settings (Models) pages. Modified the global Shell layout by setting `overflow-y: auto` on content containers and removing obsolete viewport-locked `min-height: 100vh` overrides from individual page components.
4. **Real-Time Step Progress Heuristic** — Hardened Cloud Build upgrade tracking by adding an elapsed-time heuristic in the status API. Since standard Cloud Build API does not report per-step sub-statuses in real time, the API now estimates step progress based on historical/typical step durations, ensuring smooth visual progress transitions.

### Completed: v2026.05.24.21.48 — Workspace Agent Work Filter Hotfix
> *Fixed matching short agent names to structured email address owners in work envelopes, polished AgentChip, WorkDetail, and WorkTree with clean display formatting.*

1. **Robust Agent Matching** — Created and exported a segment-based `matchAgent` utility inside `useWorkEnvelopes.ts` that handles matching short VM agent names (e.g. `'stan'`) to structured Workspace email address owners (e.g. `'devops-agent-stan@domain.com'`).
2. **Integrated Short Name Matching** — Integrated the robust `matchAgent` utility into both the `useWorkEnvelopes` custom React hook (which filters envelopes in the background) and the active task mapper in `page.tsx` (which updates the agent status/activity strip).
3. **UI Name Extraction Formatting** — Added and exported a clean `formatAgentDisplayName` utility in `AgentChip.tsx` that cleans up long structured email addresses, displaying simple, high-fidelity names (like `"stan"`, `"anora"`, `"tom"`) while keeping the full email as tooltips/DOM IDs.
4. **Unified UI Rollout** — Deployed `formatAgentDisplayName` inside both `WorkTree.tsx` and `WorkDetail.tsx` components to keep the main work timeline clean and visually consistent.

### Completed: v2026.05.24.22.03 — Quick ACK Loop Prevention + Index Optimization
> *Prevented quick ACK spam loops during gateway downtime, optimized recent mission scan in memory to avoid new Firestore composite index errors.*

1. **Quick ACK Loop Prevention** — Added a `quick_ack_sent` boolean flag to intake documents in Firestore to ensure quick ACKs are only sent once per intake. This prevents infinite message loops when `processIntake` throws fetch exceptions during gateway restarts or downtime.
2. **Recent Mission Query Optimization** — Rewrote `scanRecentMissions` in `agent-brain.mjs` to query completed work envelopes (utilizing the existing composite index on owner + status + created_at) and filtered by `type === 'M'` in memory, avoiding the need for a new Firestore composite index on Compute Engine VMs.
3. **Safety POST/PATCH Checks** — Added a strict `res.ok` validation block to the Firestore PATCH call inside `agent-mouth.mjs` to ensure payload delivery issues throw clear errors rather than failing silently.


### Completed: v2026.05.25.2.1 — Projects & Processes Architecture (Phase 3 Composition)
> *Stored reusable processes, responsibility→process linking, approval gates, context promotion, ears approval detection, settings process linking UI.*

1. **Process step type execution** — Brain daemon dispatches checkpoint tasks based on `_step_type`: `standard` (unchanged), `delegation` (intent tag + source_meta), `spawn_responsibility` (motor runs `responsibility-manage create`), `approval_gate` (writes Firestore doc, notifies via mouth, pauses envelope until resolved), `optional` (checks fleet agent availability, skips if offline).
2. **Approval gate polling** — `checkApprovedApprovals()` polls `primes/{id}/approvals` every 5th cycle (~15s). Approved → resumes paused envelope. Rejected → marks envelope failed with reason.
3. **Ears approval detection** — `checkApprovalResponse()` in `agent-ears.mjs` intercepts GChat replies matching approval/rejection patterns before normal intake processing. Updates the most recent pending Firestore approval doc. Falls through to normal processing on no match.
4. **Responsibility → Process linking** — Responsibilities with `processRef` auto-execute the linked process (skip Cortex decide). `responsibility-manage` updated with `--process-ref` and `--process-params` flags. Brain daemon loads process, substitutes parameters, converts to checkpoint plan, and executes.
5. **Project ↔ Process composition** — `project-manage` updated with `--processes` flag for `standardProcesses`. Context promotion: after mission completion, brain detects new context entries and suggests promotions to project level. Auto or manual based on `contracts.json` `projects.promotion_auto` setting.
6. **Dashboard process editing** — Processes page supports inline editing (steps reorder/add/remove, parameters edit, save auto-increments version, deprecate). Projects page shows linked standard processes and pending context promotions (accept/dismiss).
7. **Approval notification badge** — Shell header polls pending approvals every 30s, shows pulsing red badge with count.
8. **Settings process linking UI** — Agent settings page replaces responsibility placeholder with a process-linking command builder (process dropdown, parameter inputs, generated `responsibility-manage update` command preview, copy button).
9. **Contracts extended** — Added `projects` section to `contracts.json` (`context_max_tokens`, `promotion_auto`, `archive_completed_after_days`). Check 12 in `validate-contracts`.
10. **Dashboard APIs** — New routes: `approvals` (GET/POST), `promotions` (GET/POST), `projects/{projectId}` (GET/PUT with `standardProcesses`).

### Completed: v2026.05.25.3.0 — Codebase Audit Cleanup
> *Scrubbed sensitive data from public repo, deleted 25+ stale files (−6,462 lines), expanded .gitignore.*

1. **Sensitive data scrubbed** — Replaced all real GCP project IDs (`tachin-website`), numeric project numbers (`85486025845`), service account emails (`@architect-prime-beta.iam.gserviceaccount.com`), and internal domain references (`@tachin.ai`, `@tachin.ag`) with generic placeholders across 9 files (SOUL.md files, fleet-deploy, install.sh, dashboard components).
2. **Dead nested routes deleted** — Entire `app/src/app/p/` directory tree removed (20 files, ~4,000 lines). These were duplicate pages from before the v2026.05.24.20.48 top-level route promotion.
3. **Boilerplate deleted** — 5 default Next.js template SVGs removed from `app/public/`.
4. **Runtime state removed from git** — `sessions.json`, `auth-profiles.json`, `checkpoint/progress.json` deleted. These are runtime artifacts that get written to by OpenClaw.
5. **Stale files deleted** — `SOUL_PROTOCOL.md` (1-line placeholder), 3 scratch implementation plan files.
6. **`.gitignore` expanded** — Added `.DS_Store`, `*.pem`, `.env*`, runtime state paths, `.agents/scratch/`.
7. **`job-swe.txt` documented** — Added alias comment explaining SWE is an alias for the engineer specialty.

### Completed: v2026.05.26.9.0 — Fleet Introspect Crash Loop Fix + Daemon Robustness
> *Fixed set_model crash loop, PRIME_ID empty on restart, deferred restart pattern.*

1. **set_model crash loop fix** — `handleSetModel()` called `docker restart openclaw-gateway`, killing the introspect daemon (runs inside container via `docker exec`). `writeResult()` never completed → query stayed `pending` → infinite restart loop every 8s. Fix: deferred restart pattern — handler returns `_needsRestart` flag, `tick()` writes result to Firestore first, then restarts gateway.
2. **PRIME_ID empty on startup** — `start-agent-introspect` reads `PRIME_ID` from Docker container env, but during gateway restart the container isn't responding to `docker exec`. Fix: 3-attempt retry with 2s sleep + VM metadata fallback (`instance/attributes/prime_id`).
3. **Hostname derivation verified** — Fleet VMs are `fleet-{name}` (not `fleet-{primeId}-{name}`). Original `hostname().replace(/^fleet-/, '')` was correct. Reverted unnecessary PRIME_ID-stripping changes.

### Completed: v2026.05.25.8.0 — All-Provider Model Discovery + Project-Level Scan
> *Hybrid discovery (API + MaaS-only partners), project-scoped routes, all providers visible.*

1. **Project-level scan route** — Moved from `/api/primes/{id}/models/scan` to `/api/models/scan`. Model Garden is project-scoped, not Prime-scoped. New `GET /api/models` reads from `config/models` Firestore doc.
2. **Hybrid discovery** — Model Garden REST API only returns deploy-capable models (~300). Third-party models have zero `supportedActions`. Anthropic/xAI aren't in the API at all. Fix: Google uses `openGenerationAiStudio` filter; all others probe directly; Anthropic/xAI added as `MAAS_ONLY_MODELS`.
3. **All-provider probing** — Now discovers and probes: Google, Anthropic, Meta (47 models), DeepSeek (16), Mistral (11), Qwen (59), Microsoft (2), Salesforce (5), OpenAI (2), xAI (4). Skip non-text publishers.
4. **API fixes** — Added `alt=json` param (matching gcloud), pagination support (20 pages max), proper error surfacing with details in response body.
5. **Dynamic provider support** — Frontend generates provider groups, colors, and labels for any provider slug. Known providers get branded colors; unknown providers get auto-generated palette.
6. **Brain page integration** — Brain page reads same `modelCatalog` from Firestore. Picker restricts to `status=="available"`. Backward compat: scan writes to both project-level and per-Prime Firestore.

### Completed: v2026.05.25.7.0 — Live Model Discovery via Model Garden API
> *Zero-curation live discovery from Cloud Run. Model Garden REST API, dynamic provider support, all providers visible.*

1. **Live model discovery on Cloud Run** — Moved model scanning from the Prime VM (bash script + command-runner + Firestore roundtrip) to a Cloud Run API route. Scan runs entirely server-side, returns results synchronously (~30s vs ~2min). No VM involvement.
2. **Model Garden REST API** — Reverse-engineered the endpoint `gcloud ai model-garden models list` uses: `GET /v1beta1/publishers/*/models?filter=is_hf_wildcard(false)&listAllVersions=True`. Returns 600+ models from all providers.
3. **Zero curation** — Removed static/curated model lists. All models are discovered dynamically from the API. New providers (xAI, DeepSeek, AI21, NVIDIA, etc.) appear automatically.
4. **Dynamic provider support** — Frontend generates provider groups, colors, and labels for any provider slug. Known providers (Google, Anthropic, Meta, xAI, etc.) get branded colors; unknown providers get auto-generated palette colors.
5. **Brain page integration** — Brain page already reads `modelCatalog` from Firestore (same data scan writes). Model picker restricts choices to `status=="available"`. Apply & Restart handles any provider via `toOpenClawId()`.
6. **Settings tab fix** — `router.replace()` inside `<Suspense>` broke tab navigation. Fixed with `useState` + `window.history.replaceState()`.

### Completed: v2026.05.25.6.0 — Multi-Provider Model Discovery + Settings Tab Fix
> *Curated third-party MaaS models (Meta Llama, Mistral), heredoc-to-temp-file robustness, settings tab nav fix.*

1. **Third-party MaaS model discovery** — `gcloud ai model-garden models list` only returns Google + Anthropic (via `openGenerationAiStudio`). Meta Llama and Mistral are available but not in the CLI listing. Added curated `THIRD_PARTY_MAAS` list: 4 Meta Llama models (Scout, Maverick, 3.3, 3.2) + 4 Mistral models (Large, Small, Nemo, Codestral).
2. **OpenAI-compatible probing** — Meta and Mistral MaaS models use `/endpoints/openapi/chat/completions` (not `rawPredict` or `generateContent`). Probe function now branches on `maas_openai` flag.
3. **Heredoc-to-temp-file rewrite** — `discover-models` Python was embedded in a bash heredoc (`<<PYEOF`). CRLF line endings from Windows SCP corrupted the heredoc. Rewritten to `cat > /tmp/discover-models-probe.py <<'PYEOF'` (quoted, no var expansion) + `python3 $PY_TMP $args`.
4. **Settings tab switching fix** — `router.replace()` inside `<Suspense>` boundary re-suspended the component, breaking tab navigation for General/Integration/Models tabs. Replaced with local `useState` + `window.history.replaceState()` for instant tab switching.
5. **Expanded model exclusions** — Added `reward`, `guard`, `safety`, `speech`, `code-gecko`, `text-bison`, `chat-bison`, `text-unicorn` to exclude list. Added `-maas` suffix dedup logic.
6. **Brand name casing** — Extended `make_name()` with Llama, Mistral, Codestral, Maverick, Scout, Jamba, etc.

### Completed: v2026.05.25.5.0 — Brain Live Model Introspection + Model Discovery Polish
> *Live model config scanning, per-agent model swap with Apply & Restart, all-provider model discovery, collapsible provider sections.*

1. **Brain page live introspection** — Brain page now queries each agent VM's live `openclaw.json` via introspection (`brain_config` query type) to show the actual running model per sub-agent slot, not just template-level Firestore assignments.
2. **Model swap with Apply & Restart** — Clicking a slot opens a picker restricted to available models only. Selection is UI-only (pending state with amber highlight). "Apply & Restart" bar appears with Discard/Apply buttons. Apply fires `set_model` introspection query which rewrites `openclaw.json` on the VM and restarts the gateway container.
3. **All-provider model discovery** — `discover-models` now uses real publisher names from Model Garden API instead of mapping everything to `google`/`anthropic`. Surfaces Meta, Mistral, OpenAI, etc. as distinct provider groups. Third-party probing uses `rawPredict` endpoint.
4. **Collapsible provider sections** — Settings → Models tab provider groups are now collapsible with chevron toggle and `N/M available` count badge.
5. **Model Garden deep links** — "Open in Model Garden" link now uses the real publisher name in the URL path for all providers.
6. **Suspense boundary fix** — Settings page wrapped in `<Suspense>` for `useSearchParams()` to fix Next.js static generation build failure.
7. **Naming convention mapping** — Brain page handles OpenClaw ID (`google-vertex/model`) ↔ catalog bare ID (`model`) ↔ display name (`Model Name`) conversion.

### Completed: v2026.05.25.4.0 — Dashboard Settings & Security Polish
> *OAuth setup fix, runtime auth detection, editable agent defaults, header warning icons, dead code cleanup (−1,282 lines).*

1. **OAuth setup fixed** — Root cause: security tab used `NEXT_PUBLIC_AUTH_CONFIGURED` (build-time env var that can never change at runtime). Replaced with `authConfigured` field from `GET /api/setup` (runtime `isAuthConfigured()` check). OAuth route also sets the env var on Cloud Run for belt+suspenders.
2. **Runtime auth status** — Added `authConfigured: boolean` to `SetupState` type and `GET /api/setup` response. Frontend checks auth status dynamically instead of relying on build-time env vars.
3. **Header warning icons** — Pulsing amber-dotted icons appear in Shell header when DWD (🔗) or Auth (🔐) aren't configured. Each links directly to the relevant settings tab (`?tab=integration` / `?tab=security`). Disappear automatically once configured.
4. **Editable agent email domain** — Settings → General tab now has an input field + save button for the agent email domain. Syncs with `POST /api/setup`, persists to Firestore `config/settings.agentEmailDomain`. Flows to the hire dialog for auto-filling agent emails.
5. **Settings URL params** — All settings tabs sync to `?tab=` URL query parameters for deep-linking and bookmarking.
6. **Header cleanup** — Removed approval checkmark/badge from header. Centered breadcrumb in header bar.
7. **Upgrade fix** — Restored seed files (fleet-registry.json, responsibilities.json, responsibilities-job.json) and removed stale SOUL_PROTOCOL from manifest to fix fleet upgrade failures.
8. **Dead code cleanup** — Deleted 5 old settings components (SettingsView, GeneralTab, ModelsTab, SecurityTab, SystemTab = −1,282 lines). Stripped IntegrationTab to only its used export (DWDGuide). Fixed import from deleted SettingsView → `@/lib/types`.

### Completed: v2026.05.26.10.0 — Work Title System + Data Migration
> *Human-readable work titles, Cortex title generation, 304-item Stan migration, tachin-website project linking, domain placeholder cleanup.*

1. **`title` field on work envelopes** — Added `title?: string` to `WorkEnvelope` TypeScript interface. Dashboard `WorkTree.tsx` and `WorkDetail.tsx` now display `title || instruction || intent` (was `intent || instruction`). New "Instruction" section in WorkDetail shown separately when title differs from instruction.
2. **Brain daemon title generation (heuristic + LLM)** — Added `summarizeTitle()` helper to `agent-brain.mjs` (first sentence, max 80 chars, word-boundary truncation). Added `title` field to all 10 envelope creation points: ACK, intake classify (2 paths), dispatch, plan steps, checkpoints, checkpoint tasks, responsibilities (2 paths), and responsibility missions (2 paths). ACKs get `"Acknowledged: {user text}"`, responsibilities get their configured `name`, other envelopes get first-sentence heuristic.
3. **Cortex LLM title generation** — Updated Cortex SOUL.md classify output schema with mandatory `title` field (5-12 word human-readable summary). Three examples updated. Brain daemon uses Cortex-provided title when available, falls back to heuristic `summarizeTitle()`.
4. **Stan data migration** — Migrated 304 work items: generated titles for all items (0 errors), linked 206 items to `tachin-website` project via `project_id`. Owner verified as agent's actual workspace email (`AGENT_USER_EMAIL` env var).
5. **Domain placeholder cleanup** — Replaced hardcoded `@tachin.ai` in MISSION_PLAN naming conventions and fleet table with `{workspace-domain}` placeholders. Workspace email domain is operator-specific, not hardcoded.

### Current: Next Phase — Prime Skills + Skill CRUD
> *Goal: Build Prime's specialized fleet management skills and expose them through the dashboard.*

Candidates:
- Build 5 skill operation types for Prime (install, uninstall, enable, disable, configure)
- Prime-specific skills: fleet health monitoring, cost analysis, capacity planning
- Dashboard skill CRUD — manual install/uninstall/toggle from the Skills page
- RSI Engine (git-ops, code-write/test skills, human gates)
- Fleet templates and self-evolution
- Multi-project federation

### Future: RSI Engine
- Git-ops skill — branch, commit, push, PR
- Code-write / code-test skills
- Test harness: deploy from branch → validate → report
- RSI mission template — plan → implement → test → promote
- Two mandatory human gates (plan approval + merge approval)

### Future: Fleet Templates + Self-Evolution
- Agent cell templates — pre-built team configurations
- Self-evolution — Prime proposes its own improvements via PR
- Multi-project federation — fleet agents across different GCP projects
