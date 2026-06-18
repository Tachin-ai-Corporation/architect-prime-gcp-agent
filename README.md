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
    └── neural-gateway    — cognitive organs: cortex, prefrontal, motor,
                           cerebellum, temporal-research, temporal-memory
```

The brain is a deterministic state machine that consults intelligence. It owns the loop; the models own only the judgments inside it. All work flows through the **R→M→C→T** envelope hierarchy (Responsibility → Mission → Checkpoint → Task). Models, ports, agent IDs, and all cross-cutting values live in [`infra/contracts.json`](infra/contracts.json) — the single source of truth, validated at bootstrap and upgrade. The brain daemon decomposes action handling through a dispatch table, enforces iteration guards against cortex non-compliance, and budgets prior-results to prevent unbounded context growth. Completion ceremonies are centralized in a single `completeEnvelope()` lifecycle function. LLM cost telemetry tracks per-call and per-mission token usage.

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
| v2026.06.18.2.0 | 2026-06-18 | Dashboard Audit Gaps Resolution: unified model scan routes under global endpoint /api/models/scan?primeId=... and deleted legacy prime route (D1.4), decomposed settings/page.tsx into 5 distinct tab components under components/settings/ (Issue 2) and restored DWDGuide for onboarding, decomposed projects/page.tsx into modular components under components/projects/ (Issue 3), and verified clean compilation (no tsc errors).
| v2026.06.18.1.0 | 2026-06-18 | Brain Overhaul Audit Implementation: resolved all 7 gaps from audit report. Wired motor failure detection via caller-side check in checkpoint-executor (Gap 1), implemented toStr coercion for task instructions (Gap 2), unified SWF state machine using exclusively _swf_state and removed legacy _unblock_attempted flags (Gap 3), wired checkpoint-executor into process-engine and agent-brain (Gap 4), extracted all inline action handlers to actions/ modules with DI signatures (Gap 5), wired prompt caching to contracts.json (Gap 6), and added enforceSchema validation for prefrontal plan output (Gap 7).
| v2026.06.17.10 | 2026-06-17 | 6-Phase Dashboard Refactor: client/server type coherence and duplicate type removal, centralized and de-hardcoded GitHub configuration with env var fallbacks, home page decomposition into dedicated components (OnboardingFlow, PrimeGrid, FleetVisualization, HireModal), screen-brain alignment (VerdictCard, InternalsPanel, global contracts API, approvals API, intent keywords display), operational features (CostDashboard, global approvals/telemetry APIs, responsibility fire history), and MCP schema/badge UI alignment |
| v2026.06.17.9 | 2026-06-17 | Brain Daemon Overhaul (Phases 1-5): completeEnvelope extraction (7 ceremony sites → 1), action dispatch table, guard enforcement, priorResults budget, SWF state machine, LLM cost telemetry, toStr type-safety sweep (25 sites), process engine verification hardening, shared modules (plan-utils, agent-output, checkpoint-executor, to-str, envelope-lifecycle), cerebellum E2E tests (8/8 passing) |
| v2026.06.17.3 | 2026-06-17 | Deployment Resilience: strip literal backslash-r from tools.mjs (gateway crash loop), add /snap/bin to command-runner PATH (gcloud unreachable → exit 127), inject GCP_PROJECT_ID/PRIME_ID env into bootstrap service heredoc |
| v2026.06.17.2 | 2026-06-17 | Knowledge Layer Hardening: full project context + source_text to motor, process selection by intent_keywords, hallucinated skill path guards, semantic stuck detection, firebase-hosting-diagnostics skill, p-memory-consolidate process, structured telemetry |
| v2026.06.17.1 | 2026-06-17 | Idempotency & replay-safety hardening (step ledger, durable claims, checkpoint resume, idempotent createCT) + neural gateway rename (brain-gateway → neural-gateway everywhere) |
| v2026.06.16.3 | 2026-06-16 | Brain-Part Skill Visibility & Dashboard Work Refactoring: structured scannable capabilities in system prompt, explicit cortex routing rules, R-type active container bucketing, and blocked status current-trees display |
| v2026.06.16.2 | 2026-06-16 | Flash Load & Execution Quality: parse-first enforceSchema, deterministic titles, context fidelity (smartTruncate), evidence floor, mandatory accept_criteria, orphan resume, ears preprocess gate, LoopGuard, dashboard responsibilities → Persona |
| v2026.06.15.3.0 | 2026-06-15 | Product-architect abstracted: removed all Architect Prime project context from role definition, renamed repo-audit→codebase-audit, discovery-driven auditing, empty responsibilities (configured at runtime) |
| v2026.06.15.2.0 | 2026-06-15 | Designer agent role (10th specialty), workspace-slides core skill (5 Slides API tools), DWD scopes fixed in dashboard + docs (was only showing chat scopes, now all 18) |
| v2026.06.15.1.0 | 2026-06-15 | SOUL + Skills canon audit: persona layer cognition-only (prefrontal refactored, cortex genericized, -2.5k lines), skills library normalized (daemon boundary, metadata, templates, validate enhanced), agent-types.json drift fixed |
| v2026.06.14.3.0 | 2026-06-14 | App-level artifacts config (survives teardown), Skills Library rewrite (pure catalog, brain function + agent role grouping, auto-discovery, search, click-to-popup) |
| v2026.06.14.2.0 | 2026-06-14 | Resilient Prime teardown (always cleans Firestore), zombie doc auto-cleanup on deploy, ears highwater defaults to now with /var/lib persistence |
| v2026.06.14.1.0 | 2026-06-14 | Eliminate TOOLS.md: skills as single source of truth, brain daemon skill index, assemble-persona, skill-setup, 6 new skill packages, agent_part arrays |
| v2026.06.13.5.0 | 2026-06-13 | Dashboard UI redesign: sidebar navigation for Prime/Fleet agent pages, AgentWorkPanel (4-tab work view with archived search), FleetPanel inline in Prime, enlarged chat input |
| v2026.06.08.2.0 | 2026-06-08 | Brain v3 envelope orchestration, 6-organ cognitive architecture, Culture of Work primitives |

---

## License

MIT License. See [LICENSE](LICENSE).
