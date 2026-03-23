# Architect Prime — Mission Plan

> **Living document.** Updated at each checkpoint. Tracks completed milestones, current status, and the roadmap to **v1.0** and beyond.

---

## Vision

Architect Prime is a **self-bootstrapping, fleet-orchestrating AI system** built on [OpenClaw](https://github.com/openclaw/openclaw) and GCP.

**v1.0 Definition of Done:** From an empty GCP project, a single bootstrap command deploys Architect Prime — an OpenClaw instance that communicates with humans via Google Chat (using Domain-Wide Delegation to impersonate a Workspace user account), and can **hire** (spin up) and **fire** (tear down) fleet agents across separate GCP projects within a Google Cloud organization. Each fleet agent is also an OpenClaw instance with its own Workspace Chat identity. The full message loop is closed: human @-mention → DWD Chat polling → inbox-daemon → LLM → Chat response, for both Prime and every fleet agent.

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
- [x] `test-checkpoint.ps1` — GCP E2E test harness (14 SSH verification checks)
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
- [x] Single-project fleet concept established

---

### v0.6.0 — Fleet Agent Template (Multi-Project)
> *Tagged: 2026-03-03*

- [x] `fleet-deploy` — creates an entire GCP project for each fleet agent
  - Project creation → billing link → API enablement → SA → GCS bucket → Cloud Function → VM
- [x] `fleet-teardown` — deletes the fleet agent's entire GCP project
- [x] `fleet-registry.json` — Prime tracks all fleet agents (name, project, IP, status, specialty)
- [x] Fleet agents self-install CoreKit via `install.sh` on boot
- [x] Each fleet agent gets its own Chat app (direct @-mentions)
- [x] Dynamic identity: agent name, specialty injected via VM metadata
- [x] Org-level IAM: Prime SA gets `projectCreator` + `billing.admin`
- [x] Admin human gets `roles/owner` on every fleet project
- [x] Chat setup instructions auto-printed after deploy

---

### v0.7.0 — Agent-Ask: The Fundamental Skill (LLM + Web Search)
> *Tagged: 2026-03-11*

- [x] `agent-ask` — the core "answer question" skill shared by Prime and all fleet agents
  - Calls Vertex AI Gemini API with Google Search grounding
  - Accesses agent workspace (SOUL, MEMORY, IDENTITY, specialty) to build context-aware system prompt
  - Read-only skill: agent queries its resources, knowledge, and the web to best answer the question
- [x] `build-system-prompt` — assembles system prompt from workspace files
- [x] Non-command Chat messages auto-routed to LLM for intelligent answers
- [x] Fleet agents inherit `agent-ask` via shared CoreKit install
- [x] `.gitattributes` — forces LF line endings on all shell scripts

---

### v0.7.1 — DWD Chat Migration + Bootstrap Hardening
> *Tagged: 2026-03-22*

- [x] **DWD Migration** — replaced Cloud Functions + GCS inbox with Domain-Wide Delegation (DWD) user impersonation
  - `dwd-token` — keyless DWD via VM metadata `signJwt` (no JSON key files)
  - `chat-send` — rewritten for DWD impersonation (messages appear as the Workspace user)
  - `chat-read` — new script: reads messages via DWD-impersonated `spaces.messages.list`
  - `inbox-daemon` — rewritten: polls Chat API directly instead of GCS bucket
  - Removed `cloud-functions/chat-handler/` — no longer needed
- [x] **Interactive bootstrap** — guided `bootstrap.sh` with env var prompts, `CORE_REF` selection, Phase 1 + Phase 2 automation
- [x] **Phase 2 hardening** — deterministic gateway readiness poll loop (replaced fragile `sleep 45`)
- [x] **chat-read fixes** — 4 bugs fixed:
  - Pipe API response via stdin instead of triple-quote string embedding
  - Client-side time filtering (server-side `filter` param unreliable with DWD)
  - Mention matching without sender email (API doesn't return it)
  - Normalize hyphens + spaces for Google Chat display name matching
- [x] Full message loop verified: human @-mention → DWD polling → inbox-daemon → Gemini → chat-send → Chat response

---

## Roadmap to v1.0

### v0.8.0 — Inter-Agent Communication (via Google Chat)  ← *next*
> *Goal: Prime and fleet agents talk to each other through Google Chat — all comms visible to humans.*

**Design principle:** All agent-to-agent communication flows through Google Chat, not through private channels. This ensures human visibility, auditability, and the ability for humans to participate in any agent conversation.

Now that DWD is in place (v0.7.1), agents impersonate Workspace user accounts. Fleet agents need their own DWD-compatible Workspace identities.

- [ ] **Fleet agent DWD provisioning** — `fleet-deploy` provisions DWD for each fleet agent's Workspace user, shares the same SA Client ID grant
- [ ] **Prime → fleet messaging** — Prime sends tasks/questions to fleet agents by @-mentioning them in Chat (via `chat-send` targeting the fleet agent's display name)
- [ ] **Fleet → Prime reporting** — fleet agents post status/results back to the shared Chat space, visible to Prime and humans
- [ ] **Fleet intro ceremony** — after `fleet-deploy`, Prime provides DWD setup instructions to human admin (Workspace user creation + space membership); once human enables Chat, Prime verifies the new agent responds ("fleet intro" handshake)
- [ ] **Task routing** — Prime routes human requests to the appropriate fleet agent by specialty (via Chat @-mention)
- [ ] **Multi-agent conversation** — a human message to Prime can trigger a fleet agent consultation, with all exchanges in the shared Chat space

---

### v0.9.0 — Fleet Health Monitoring
> *Goal: Prime monitors its fleet, detects problems, and reports to humans — leveraging inter-agent comms from v0.8.0.*

- [ ] **Fleet heartbeat** — Prime periodically @-mentions each fleet agent in Chat; agents respond with status (leverages v0.8.0 comms)
- [ ] **GCP-level health checks** — Prime uses its project ownership to verify fleet VMs are running, inbox-daemons are alive, containers are healthy
- [ ] **`fleet-status` command** — humans can ask Prime for fleet health report in Chat
- [ ] **Registry sync** — `fleet-registry.json` updated with `healthy` / `unhealthy` / `offline` based on combined Chat response + GCP checks
- [ ] **Error recovery** — if a fleet agent is unresponsive, Prime can restart or redeploy and reports action to humans in Chat

---

### v1.0.0 — Production-Ready Fleet Orchestrator 🎯
> *Goal: The complete, reliable, self-bootstrapping fleet system.*

- [ ] **One-command bootstrap** — `bootstrap.sh` fully verified from empty project to working Prime + DWD Chat + fleet capability
- [ ] **DWD-based Chat (by design)** — all agents communicate via DWD user impersonation; humans create Workspace accounts and add them to Chat spaces
- [ ] **Agent-ask verification** — confirm `agent-ask` works end-to-end for both Prime and fleet agents: Chat @-mention → DWD polling → Gemini + grounding → Chat response
- [ ] **Fleet agent upgrade** — Prime can upgrade all fleet agents to a new CoreKit version via Chat command
- [ ] **Graceful fleet lifecycle** — hire, monitor, upgrade, and fire fleet agents entirely via Chat commands
- [ ] **Checkpoint E2E test** — `test-checkpoint.ps1` covers the full lifecycle (bootstrap → hire agent → verify Chat comms → answer question → fire agent)
- [ ] **Documentation** — complete Bootstrap, Operations, and Fleet Management guides
- [ ] **README** updated with full checkpoint history and architecture diagrams

---

## Post-v1.0 — Future Capabilities

These are planned capabilities for after the core fleet system is production-ready:

- **Google Workspace skills** — fleet agents that manage Docs, Sheets, Calendar, Gmail on behalf of humans
- **Mission queue / task system** — agents operate from a durable task queue with checkpoints, assigned by humans or by Prime
- **Collaborative execution** — multiple fleet agents coordinate on multi-step tasks, with Prime as the orchestrator
- **Cost governance** — Prime tracks and reports fleet spending, auto-scales or shuts down idle agents
- **Self-evolution** — Prime proposes its own CoreKit improvements via PR, human approves, Prime merges and tags
- **Audit trail** — full GCS-based audit log of every command, decision, and action across the fleet

---

## Architecture Summary

```
Google Chat (Humans)
    │
    ▼  @-mention agent's Workspace user
    │
inbox-daemon (per VM)                ◄── polls Chat API via DWD every 10s
    │  uses: dwd-token → signJwt → OAuth2 token
    │  uses: chat-read → spaces.messages.list
    │
    ├── Built-in commands (help, status, fleet, whoami)
    └── agent-ask → Vertex AI Gemini + Google Search
                │
                ▼
        chat-send (DWD) → Google Chat API   ◄── response posted as agent user
```

```
GCP Organization
├── Prime's Project (architect-prime-beta)
│   ├── architect-prime (VM)          ◄── Fleet orchestrator
│   ├── DWD via SA signJwt            ◄── No JSON key files needed
│   ├── inbox-daemon (systemd)        ◄── DWD Chat polling
│   └── fleet-registry.json           ◄── Tracks all fleet agents
│
├── fleet-alpha/ (Project)
│   ├── fleet-alpha (VM)              ◄── Fleet agent
│   ├── DWD (same SA Client ID grant) ◄── Shared DWD authorization
│   └── inbox-daemon                  ◄── DWD Chat polling
│
└── fleet-beta/ (Project)
    ├── fleet-beta (VM)               ◄── Fleet agent
    └── inbox-daemon                  ◄── DWD Chat polling
```

---

## Principles

1. **No secrets in repo** — all secrets injected at runtime via ADC, DWD signJwt, or GCP metadata
2. **Manifest-driven** — `manifest.txt` is the single source of truth for installed files
3. **Checkpoint-versioned** — only tagged checkpoints are stable; `main` may move forward
4. **Idempotent** — every script safely re-runnable
5. **Self-upgradable** — drift detection + in-place upgrade
6. **Agent-maintainable** — Prime can propose changes via PR
7. **Human-auditable** — Chat relay (DWD = human-visible messages), tagged checkpoints
