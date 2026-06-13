# Architect Prime

**Self-bootstrapping agent factory for Google Cloud.**

Architect Prime creates, upgrades, monitors, and tears down autonomous AI agents running inside your own GCP project. Each agent gets a Compute Engine VM, a host-native brain powered by Vertex AI, and a Google Workspace identity — reachable by chat and email, working alongside humans in the channels humans already use.

Prime handles **infrastructure, not orchestration**. Humans assign work to agents directly; agents delegate to each other directly. The factory builds and maintains the fleet — it never sits in the middle of the work.

Everything runs inside the operator's own GCP project: no shared infrastructure, no external runtime dependencies, no API keys. Authentication is Application Default Credentials, Domain-Wide Delegation, and per-agent IAM, end to end.

---

## Quick Deploy

### Cloud Shell (Recommended)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent&tutorial=infra/deploy/tutorial.md)

### Manual

```bash
git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent
cd architect-prime-gcp-agent
export PROJECT_ID="your-project-id"
bash infra/deploy/install.sh
```

After install, open the printed URL to access the dashboard.

---

## Getting Started

1. **Deploy a Prime** — Dashboard → Enter a name → Click **Deploy Prime**. Ready in minutes.
2. **Configure DWD** *(optional, required for fleet Google Chat)* — See [Chat Setup](docs/CHAT_SETUP.md).
3. **Hire agents** — Set an agent email domain, create a Workspace email, then hire a specialist from the Fleet tab. Prime deploys a specialist VM and brings the agent online.
4. **Work** — Talk to Prime through the dashboard. Add fleet agent emails to Chat spaces. Agents read and respond independently.

---

## Architecture

```
Dashboard (Cloud Run — Next.js)
    │  control plane: fleet lifecycle, chat, work trees, introspection,
    │  projects, processes, plans, secret management
    ▼
Firestore (state store)
    ▼
Agent VMs (GCE, host-native under systemd — no containers)
    ├── agent-ears       — deterministic input: poll, dedup, fire-and-forget
    ├── agent-brain      — envelope orchestrator: classify, decide, dispatch
    ├── agent-mouth      — output delivery to the channel
    ├── agent-introspect — dashboard introspection bus
    └── brain-gateway    — cognitive organs: cortex, prefrontal, motor,
                           cerebellum, temporal-research, temporal-memory
```

The brain is a deterministic state machine that consults intelligence. It owns the loop; the models own only the judgments inside it. All work flows through the **R→M→C→T** envelope hierarchy (Responsibility → Mission → Checkpoint → Task). Models, ports, agent IDs, and all cross-cutting values live in [`infra/contracts.json`](infra/contracts.json) — the single source of truth, validated at bootstrap and upgrade.

For the full cognitive architecture, see [Brain Canon](docs/BRAIN_CANON.md). For governing invariants, see [Product Canon](docs/PRODUCT_CANON.md).

---

## Repository Layout

```
.
├── app/            # Dashboard control plane (Cloud Run, Next.js)
├── infra/          # contracts.json, install.sh, bootstraps, manifests
├── corekit/        # VM runtime — daemons, libs, tools, config
├── brain/          # Agent identity workspaces — SOUL.md, IDENTITY.md per role
├── specialties/    # Per-agent-type bundles — workspace, brain appends, skills
├── skills/         # Versioned skill packages — the system's codified know-how
├── docs/           # Canons, culture of work, primitives, guides, plans
└── MISSION_PLAN.md # What the system is and is becoming
```

Six modules, one home for everything. See [MISSION_PLAN.md](MISSION_PLAN.md) for the full map.

---

## Governing Documents

| Document | Purpose |
|----------|---------|
| [MISSION_PLAN.md](MISSION_PLAN.md) | Identity + trajectory — what Architect Prime is and is becoming |
| [Product Canon](docs/PRODUCT_CANON.md) | The walls — invariants that must never be crossed |
| [Brain Canon](docs/BRAIN_CANON.md) | The gradient — what better looks like for the brain |
| [Culture of Work](docs/CULTURE_OF_WORK.md) | The operational framework — eight primitives, the R→M→C→T spine |
| [contracts.json](infra/contracts.json) | Single source of truth for all cross-cutting values |

---

## Uninstall

```bash
export PROJECT_ID="your-project-id"
bash infra/deploy/uninstall.sh
```

---

## Version History

| Version | Date | Summary |
|---------|------|---------|
| v2026.06.13.5.0 | 2026-06-13 | Dashboard UI redesign: sidebar navigation for Prime/Fleet agent pages, AgentWorkPanel (4-tab work view with archived search), FleetPanel inline in Prime, enlarged chat input |
| v2026.06.08.2.0 | 2026-06-08 | Brain v3 envelope orchestration, 6-organ cognitive architecture, Culture of Work primitives |

---

## License

MIT License. See [LICENSE](LICENSE).
