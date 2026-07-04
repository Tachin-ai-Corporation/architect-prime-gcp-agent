# Architect Prime — Product Canon

> **Version:** 1.0
> **Repo location:** `docs/PRODUCT_CANON.md`
> **Ownership:** Human maintainers, via CODEOWNERS. Agents may propose amendments only via PR (§Amendments).
> **Audience:** Every agent operating on this repository — above all the Product Architect.

This document is **normative**. Where MISSION_PLAN.md describes what Architect Prime *is and is becoming*, the Canon defines what it must *remain*. An "improvement" that violates an invariant below is not an improvement, regardless of the benefit claimed. Efficiency, structure, logic clarity, and cleanness are pursued **inside** these walls, never through them.

---

## I. Identity

### C-1 · Prime is a factory, not an orchestrator
Prime creates, upgrades, monitors, and tears down agents. It does not route their work. Humans assign work to agents directly; agents delegate to each other directly. Consequently, work artifacts (missions, plans, processes) are rooted at the deployment/project level — not under a Prime subcollection. The Prime is an executor, not the storage root. Actor state (fleet, messages, commands) legitimately remains prime-scoped.
**Violation looks like:** a feature that makes Prime a mandatory hop in agent-to-agent workflows; a "Prime task queue" that fleet agents consume from; centralizing fleet decision-making in Prime's brain; storing work artifacts under `primes/{id}/` instead of top-level collections.

### C-2 · Zero shared infrastructure
Everything runs inside the operator's own GCP project. No vendor-hosted services in the runtime path, no cross-tenant anything, no phone-home dependencies.
**Violation looks like:** a callback to any endpoint outside the operator's project; a shared Firestore/bucket/queue outside the project; telemetry leaving the project boundary.

### C-3 · Agents are teammates, not endpoints
Fleet agents hold real Google Workspace identities and communicate where humans communicate (Chat, Gmail, Calendar) via Domain-Wide Delegation. Inter-agent protocols must stay human-readable in those channels even when machine-parsed.
**Violation looks like:** an opaque agent-to-agent side channel humans cannot read; protocol messages reduced to bare payloads with no human-readable summary; bypassing Workspace identity for agent communication.

---

## II. The Governing Boundary

### C-4 · Everything that can be deterministic is deterministic
This is the supreme engineering principle of the codebase. LLM calls are reserved exclusively for work that genuinely requires judgment, language, or synthesis. Structure, flow control, scheduling, parsing of known formats, state transitions, retries, dedup, and routing are code.
**Violation looks like:** an LLM call deciding envelope status transitions; prompting a model to parse a marker whose grammar is fixed; cron evaluation, dedup, or ref-matching delegated to cortex; "let the model figure out the flow."

### C-5 · LLMs think inside structured JSON; daemons move the data
The brain daemon owns the state machine. Cortex returns structured decisions within defined schemas; the daemon validates and executes them. The LLM never holds the loop.
**Violation looks like:** free-text model output driving execution; the daemon trusting unvalidated model JSON; moving orchestration logic from `agent-brain.mjs` into prompts.

### C-6 · The shadow-LLM pattern is sanctioned, not drift
Stateless utility calls (summarization, title generation, classification) go directly through `vertex-text.mjs`, bypassing the gateway. Persona overhead is waste for these. The contract is the formalization — do not "fix" this by rerouting utility calls through the gateway.
**Violation looks like:** routing `smartSummarize`/title calls through cortex sessions "for consistency"; conversely, sneaking judgment-bearing decisions through the utility path to dodge persona constraints.

---

## III. Configuration & Truth

### C-7 · `infra/contracts.json` is the single source of truth
All cross-cutting values — models, ports, agent IDs, timeouts, locations, repo coordinates — live in contracts.json and nowhere else. `validate-contracts` enforces it at bootstrap and upgrade. READMEs and docs describe; contracts decide.
**Violation looks like:** a model string, port, or timeout hardcoded in a script or prompt; a second config file duplicating a contract value; documentation cited as authority over contracts.json.

### C-8 · No secrets in git, on disk images, or in Firestore — ever
Authentication is ADC via GCE metadata, DWD signJwt, and the dashboard Secret Store (payloads only in GCP Secret Manager; metadata and grants in Firestore; per-secret per-agent IAM). Tokens are minted or read at runtime, used via command substitution, and never persisted into files, remote URLs, transcripts, MEMORY.md, or Drive artifacts.
**Violation looks like:** an API key in a manifest, bootstrap script, or `.git/config`; a secret value mirrored into Firestore "for caching"; a token echoed into a chat response or work-envelope output.

### C-9 · Manifest discipline is absolute
Every file a manifest references exists in the same commit as the manifest entry. Files ship with their `base.txt` / `role-*.txt` / `job-*.txt` lines together — split commits break deployments. CI's manifest-integrity job enforces this; no PR merges around it.
**Violation looks like:** a manifest line landing one commit before its file; a new corekit lib added to a daemon without its base.txt entry; "I'll add the manifest entry in the follow-up PR."

---

## IV. Structure

### C-10 · The six modules are the map
`app/` (control plane) · `infra/` (contracts, manifests, bootstraps) · `corekit/` (VM runtime) · `brain/` (identity workspaces) · `specialties/` (per-type bundles) · `skills/` (skill packages). New code belongs in exactly one. Cross-module reach-ins (app importing corekit internals, corekit reading app code) are forbidden.
**Violation looks like:** a seventh top-level module without a canon amendment; runtime logic in `app/`; dashboard logic in `corekit/`; a specialty bundle scattering files across modules.

### C-11 · Modular manifests: base + role + job, chained
`install.sh --role prime|fleet --job {specialty}` chains exactly three fragment layers. Each specialty is independently iterable. Capabilities are granted by layer — universal tools in base, role tools in role, specialty tools and credentials in job.
**Violation looks like:** specialty-only tools leaking into `base.txt`; a fourth ad-hoc layer; install logic special-casing one job name; credential-bearing tools (e.g. `gh-api`) placed below the job layer.

### C-12 · Host-native under systemd; no containers
Daemons (ears, brain, mouth, introspect, gateway) run as native Node.js systemd services directly on the GCE host. Agent VMs run no containers and no container runtime.
**Violation looks like:** a Dockerfile reappearing in corekit; a containerized daemon; compose files for VM runtime.

### C-13 · Boot stub pattern
VM startup scripts are ~10-line stubs that curl bash from GitHub. Bootstrap changes require only `git push` — never a Cloud Run rebuild, never JS-templated shell.
**Violation looks like:** embedding bootstrap shell inside dashboard TypeScript; baking setup into VM images; bootstrap steps that require a dashboard redeploy to change.

---

## V. The Culture of Work

### C-14 · The nine primitives are a closed set
Responsibility → Mission → Checkpoint → Task form the execution spine. Project, Process, Plan, Artifact, and Skill are the supporting cast. These nine cover all structured work and all codified procedure; inventing new envelope types, work abstractions, or knowledge containers is forbidden without a canon amendment.
**Violation looks like:** a new envelope type; a "Sprint"/"Epic"/"Ticket" object in Firestore; a parallel work-tracking structure beside `work/`; a knowledge container outside Skills.

### C-15 · R→M→C→T is the execution spine; no exceptions
All executable work flows Responsibility (optional wrapper) → Mission → Checkpoint → Task. Missions are always flat — they never nest other Missions. Projects are the **sole** recursive primitive, max depth 4. Every Mission has a `project_id`; never null.
**Violation looks like:** a Mission spawning a child Mission; Tasks outside Checkpoints; depth-5 projects; a Mission written with `project_id: null`; work executed outside the envelope hierarchy "just this once."

### C-16 · One envelope at a time per brain; concurrency is more agents
A brain instance processes a single envelope at a time. Throughput problems are solved by hiring more agents, never by building concurrent envelope processing into one brain.
**Violation looks like:** worker pools inside `agent-brain.mjs`; parallel envelope claims by one agent; async fan-out of a brain's decide loop.

### C-17 · Checkpoints are sequential; structure is daemon-owned
Checkpoints within a Mission execute strictly in order; all Tasks in one complete before the next begins. The daemon — not the model — creates, advances, completes, fails, and archives envelopes.
**Violation looks like:** out-of-order checkpoint execution; an LLM prompt instructed to "mark the mission complete"; status transitions written by anything but the daemon's validated paths.

---

## VI. Operations

### C-18 · Idempotent everything
Installs, deploys, upgrades, hires, and fires are safely re-runnable. Upgrades overwrite manifest-managed files and never delete non-manifest files. SAs and IAM persist across fire/re-hire.
**Violation looks like:** a script that fails on second run; an upgrade that wipes agent state outside the manifest; teardown that destroys SAs needed for re-hire.

### C-19 · Fail fast at bootstrap
`validate-contracts` runs before services start; config errors surface in seconds, not after a daemon limps into production. New subsystems add their validation to the same gate.
**Violation looks like:** a service that starts with invalid config and fails an hour later; validation moved to "best effort" post-start; a new config file with no bootstrap-time check.

### C-20 · Observable by default
All inter-agent communication is logged in Firestore; daemons emit structured JSON logs with telemetry; the Work Tree shows the full envelope hierarchy in real time. New mechanisms (delegation, secrets grants, rollouts) arrive with their observability built in, not promised later.
**Violation looks like:** a silent side channel; a new daemon without telemetry writes; grant/revoke actions with no audit trail.

### C-21 · Capability fencing is structural, not behavioral
What an agent *cannot* do is enforced by manifests, IAM, CODEOWNERS, branch protection, and CI — never by persona text alone. SOUL.md reinforces; structure enforces. The Architect cannot push code because it holds no token, not because it promised not to.
**Violation looks like:** relying on a SOUL.md rule as the only barrier to a privileged action; granting a credential broadly and asking agents to self-restrict; agents owning `/.github/` or `contracts.json` in CODEOWNERS.

### C-22 · Code changes flow through the gated path
Branch → local pre-commit gates → test-agent verification → PR with declared scope → CI green → human CODEOWNERS review → merge → fleet rollout. Agent-authored changes never reach `main` by any other road, and never touch files outside their declared scope.
**Violation looks like:** a direct push to main; a PR with no `Scope:` block; scope-check bypassed or widened mid-PR; fleet upgraded from an unmerged branch outside a verification cycle.

---

## VII. Versioning

### C-23 · The canonical commit format is forever
`v{YYYY}.{MM}.{DD}.{index}.{subindex}: description` — defined in `contracts.json` (`versioning.canonicalRegex`), parsed by the upgrade route. It does not change.
**Violation looks like:** semver tags on new work; commits to main without the version prefix; a second versioning scheme introduced "temporarily."

---

## VIII. Artifact Substrate

### C-24 · Git is the artifact substrate; objects-before-refs is the law
Work products live in git repos backed by GCS bundles (objects) + Firestore CAS refs (branches). Two planes: **Plane 1** (GitHub) is the template source — `architect-prime` repo deployed to VMs via manifests. **Plane 2** (GCS+Firestore) is the shared agentic ether — one repo per project, mission branches merged to `main`. Object writes to GCS must precede Firestore ref advancement (parallel to C-18). Ref advancement uses Firestore `commit` with precondition guards (compare-and-swap). Transport: `corekit/lib/git-store.mjs`. Motor atoms: `skills/workspace-git/`.
**Violation looks like:** Raw file uploads to Drive as the primary artifact substrate; refs advanced before objects are durably stored; CAS-free ref writes; mission branches not merged to main on completion.

---

## Amendments

The Canon changes the way code changes: by PR, reviewed and approved by a human CODEOWNER. An amendment PR must state the invariant being added, changed, or retired; the evidence that the change preserves the product's identity; and the migration consequences for existing invariant checks (cerebellum SOUL_APPEND, CI jobs). Agents — including the Product Architect — may propose amendments; only humans approve them. Absent an approved amendment, the Architect rejects any improvement proposal that conflicts with this document, and the conflict itself is recorded as a learning.
