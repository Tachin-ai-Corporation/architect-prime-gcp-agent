# Architect Prime — Product Canon

> **Version:** 1.0
> **Repo location:** `docs/PRODUCT_CANON.md`
> **Ownership:** Human maintainers, via CODEOWNERS. Agents may propose amendments only via PR (§Amendments).
> **Audience:** Every agent operating on this repository — above all the Product Architect.

This document is **normative**. Where MISSION_PLAN.md describes what Architect Prime *is and is becoming*, the Canon defines what it must *remain*. An "improvement" that violates an invariant below is not an improvement, regardless of the benefit claimed. Efficiency, structure, logic clarity, and cleanness are pursued **inside** these walls, never through them.

---

## I. Identity

### C-1 · Prime is a factory, not an orchestrator
Prime creates, upgrades, monitors, and tears down agents. It does not route their work. Humans assign work to agents directly; agents delegate to each other directly — peer-to-peer, with no Prime routing hop, though every delegation still egresses through the delegating agent's own mouth (C-27); "directly" negates a Prime relay, not the egress funnel. Consequently, work artifacts (missions, plans, processes) are rooted at the deployment/project level — not under a Prime subcollection. The Prime is an executor, not the storage root. Actor state (fleet, messages, commands) legitimately remains prime-scoped.
**Violation looks like:** a feature that makes Prime a mandatory hop in agent-to-agent workflows; a "Prime task queue" that fleet agents consume from; centralizing fleet decision-making in Prime's brain; storing work artifacts under `primes/{id}/` instead of top-level collections.

### C-2 · Zero shared infrastructure
Everything runs inside the operator's own GCP project. No vendor-hosted services in the runtime path, no cross-tenant anything, no phone-home dependencies.
**Violation looks like:** a callback to any endpoint outside the operator's project; a shared Firestore/bucket/queue outside the project; telemetry leaving the project boundary.

### C-3 · Agents are teammates, not endpoints
Fleet agents hold real Google Workspace identities and communicate where humans communicate (Chat, Gmail, Calendar) via Domain-Wide Delegation. Inter-agent protocols must stay human-readable in those channels even when machine-parsed. Every such message — agent-to-agent included — egresses through the sending agent's own mouth (C-27); the "no opaque side channel" prohibition and the sole-egress rule are one wall seen from two sides.
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

### C-7 · One compiled effective contract, with authoritative provenance per plane
All cross-cutting values — models, ports, agent IDs, timeouts, locations, repo coordinates — live in the contract and nowhere else. `validate-contracts` enforces it at bootstrap and upgrade. READMEs and docs describe; contracts decide.

There is **one artifact** every consumer reads (`infra/contracts.json`), and it is **generated**. It is compiled from two authored sources that are owned by different planes (C-29):

- `infra/platform-defaults.json` — **Foundation.** Mechanism: organ topology, gateway wiring, protocol grammar, execution ceilings, the workspace path catalog, artifact-substrate constants. Changes only through a platform release.
- `infra/fleet-policy.json` — **deployment-owned.** Choices: models and regions, thresholds and feature flags, repo coordinates, tuning. Two unrelated deployments reasonably differ here.

Policy may not set a Foundation-owned path; `compile-contracts` reports the attempt and fails rather than silently discarding the value. The compiled artifact carries a `_provenance` block recording the digest of each source and the Foundation path list, so any live value can be traced to the plane that owns it. CI fails when the artifact is stale.

**Violation looks like:** a model string, port, or timeout hardcoded in a script or prompt; a second config file duplicating a contract value; documentation cited as authority over the contract; **hand-editing the generated `contracts.json`**; a deployment tuning a platform mechanism by moving its key into `fleet-policy.json`.

### C-8 · No secrets in git, on disk images, or in Firestore — ever
Authentication is ADC via GCE metadata, DWD signJwt, and the dashboard Secret Store (payloads only in GCP Secret Manager; metadata and grants in Firestore; per-secret per-agent IAM). Tokens are minted or read at runtime, used via command substitution, and never persisted into files, remote URLs, transcripts, MEMORY.md, or Drive artifacts.
**Violation looks like:** an API key in a manifest, bootstrap script, or `.git/config`; a secret value mirrored into Firestore "for caching"; a token echoed into a chat response or work-envelope output.

### C-9 · Manifest discipline is absolute
Every file a manifest references exists in the same commit as the manifest entry. Files ship with their `base.txt` / `role-*.txt` / `job-*.txt` lines together — split commits break deployments. CI's manifest-integrity job enforces this; no PR merges around it.
**Violation looks like:** a manifest line landing one commit before its file; a new corekit lib added to a daemon without its base.txt entry; "I'll add the manifest entry in the follow-up PR."

---

## IV. Structure

### C-10 · The six modules are the map
`app/` (control plane) · `infra/` (contracts, manifests, bootstraps) · `corekit/` (VM runtime) · `platform/organ-firmware/` (identity workspaces) · `specialties/` (per-type bundles) · `skills/` (skill packages). New code belongs in exactly one. Cross-module reach-ins (app importing corekit internals, corekit reading app code) are forbidden.
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

### C-14 · The eight primitives are a closed set
Responsibility → Mission → Checkpoint → Task form the execution spine. Project, Process, Artifact, and Skill are the supporting cast. These eight cover all structured work and all codified procedure; inventing new envelope types, work abstractions, or knowledge containers is forbidden without a canon amendment.

**Every primitive is an executable contract.** A primitive named here has a schema, a storage path, a writer, and a reader in the running system. Documentation alone does not create one. *Plan* — an "unexecuted Mission blueprint" with a `draft → approved → executing` lifecycle — was carried in this set with a 212-line specification, a state diagram, two mutually contradictory Firestore paths, and **no implementation whatsoever**; it was retired at v2026.08.15. What it described is covered without a separate aggregate: the agent's own `checkpoint_plan` is the M→C→T layout (C-15), approvals gate the consequential checkpoints, and the draft→validate→evaluate→canary→promote lifecycle belongs to Fleet Definition content (C-31), not to work.

**Violation looks like:** a new envelope type; a "Sprint"/"Epic"/"Ticket" object in Firestore; a parallel work-tracking structure beside `work/`; a knowledge container outside Skills; a primitive that exists only in documentation.

### C-15 · R→M→C→T is the execution spine; no exceptions
All executable work flows Responsibility (optional wrapper) → Mission → Checkpoint → Task. Missions are always flat — they never nest other Missions. Projects are the **sole** recursive primitive, max depth 4. Every Mission has a `project_id`; never null. The spine is laid out exactly one way — the agent's own `checkpoint_plan` — never by a competing step-machine; a recalled process narrative informs that plan as a prior but never dispatches it (C-28).
**Violation looks like:** a Mission spawning a child Mission; Tasks outside Checkpoints; depth-5 projects; a Mission written with `project_id: null`; work executed outside the envelope hierarchy "just this once"; a process step-executor structuring the spine in place of the agent's own `checkpoint_plan`.

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
All inter-agent communication is logged in Firestore; daemons emit structured JSON logs with telemetry; the Work Tree shows the full envelope hierarchy in real time. New mechanisms (delegation, secrets grants, rollouts) arrive with their observability built in, not promised later. A single outbound egress — the mouth (C-27) — is what keeps this observability point single and makes the "silent side channel" prohibition enforceable: one path to log, one path to audit.
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
Work products live in git repos backed by GCS bundles (objects) + Firestore CAS refs (branches). Two planes: **Plane 1** (GitHub) is the template source — `architect-prime` repo deployed to VMs via manifests. **Plane 2** (GCS+Firestore) is the shared agentic ether — one repo per project, mission branches merged to `main`. Object writes to GCS must precede Firestore ref advancement (parallel to C-18). Ref advancement uses Firestore `commit` with precondition guards (compare-and-swap). Transport: `platform/persistence/git-store.mjs`. Motor atoms: `skills/workspace-git/`.
**Violation looks like:** Raw file uploads to Drive as the primary artifact substrate; refs advanced before objects are durably stored; CAS-free ref writes; mission branches not merged to main on completion.

---

## Amendments

The Canon changes the way code changes: by PR, reviewed and approved by a human CODEOWNER. An amendment PR must state the invariant being added, changed, or retired; the evidence that the change preserves the product's identity; and the migration consequences for existing invariant checks (cerebellum SOUL_APPEND, CI jobs). Agents — including the Product Architect — may propose amendments; only humans approve them. Absent an approved amendment, the Architect rejects any improvement proposal that conflicts with this document, and the conflict itself is recorded as a learning.

### C-25 · Dashboard deliveries may carry structured attachments
Attachments (name, size, object path) exported at mission publish from the tenant
artifact store extend the delivery payload; they never change the delivery path.
The mouth remains the single outbound surface (the general rule is **C-27**, of which
attachment delivery is one application — attachments extend the payload, never the
path), and the dashboard streams objects
through an authenticated, prime-scoped route — never public or signed URLs.

### C-26 · Fleet dashboard-chat is read-only
Live interactive chat for fleet agents has migrated entirely to direct Google Chat threads.
The dashboard-chat POST endpoint is retired with a deterministic 405 error, and the fleet
agent deep-dive tab renders historic communications as a read-only historic archive.
The *send* side of those direct Chat threads is still the mouth (C-27); migration-to-Chat
is not a license for a fleet-side direct-send path.

### C-27 · The mouth is the sole outbound egress
Every agent-initiated outbound message — to a human **or** to another agent, on any channel
(Chat, Gmail, dashboard, and any channel added later) — leaves the VM only through that agent's
own `agent-mouth` daemon and its classify-and-deliver path. No organ, tool, skill, or daemon
may originate an outbound send by any other route. An agent *requests* a send by writing (or
completing) a work envelope with `delivery_status:'pending'` and a `delivery_address`; it never
delivers. Inter-agent delegation is **not** exempt: the durable coordination record is the shared
work envelope in Firestore, and the delegation ping egresses through the mouth (composed as an
output envelope, delivered by the mouth), never a direct `chat-send`. Inbound sensing (ears polling,
`chat-read`, `gmail-search`/`gmail-get`) is unaffected — reading is not egress.

**Carve-out — operator provisioning tooling.** Prime-run fleet lifecycle scripts (`fleet-verify`,
`fleet-upgrade`, `fleet-teardown`) and the pre-mouth `fleet-bootstrap` self-report card are
out-of-band *operator* instruments, not agent cognition; they may post terse status directly (the
bootstrap card structurally *must* — it fires before the agent's mouth exists). This carve-out is
for Prime lifecycle tooling only; it is never a license for a fleet agent's motor to send outside
its mouth.

**Enforcement (structural, not behavioral — C-21).** Agent send-CLIs (`chat-send`, `gmail-send`,
`gmail-draft-*`) are not installed on fleet agents; the agent-facing token minter (`dwd-token`)
refuses to mint send-class scopes (chat send is denied to fleet, email send to all); the Workspace
DWD grant withholds all Gmail send scopes entirely; and the mouth mints its send token through the
daemon library `dwd-auth.mjs`, which is not on the agent command PATH (a motor reaches CLIs, not
module imports, in its tool/skill-driven flow). **Residuals (tracked hardenings):** (1) on a
single-VM, shared-SA, keyless host the chat send capability cannot be cryptographically isolated
from a co-resident motor — a `node` one-liner could import `dwd-auth.mjs` (or hand-roll the signJwt
exchange) against the VM metadata SA to mint a `chat.messages` token, bypassing both the CLI guard
and the mouth; this is an off-script act outside normal tool/skill flow, is bounded by the DWD grant
(Gmail send cannot be minted at all), and is closable for chat only by giving the mouth its own
workload identity. (2) Delegation egresses through the mouth today but is delivered as a
pre-formatted marker on a path that skips the voicing/classify filter (`deliverDelegation`);
converting it to a voiced conversational nudge is the second follow-on.

**Violation looks like:** motor or a skill calling a Chat/Gmail send API directly; a delegation or
delegation-result marker written to a channel by anything but the mouth; a
"quick notify" / "ping the operator" path that posts without an output envelope; a send-capable
scope reachable from the agent-facing token CLI; any outbound side channel that skips the mouth's
classify filter.

### C-28 · Layer purity: each content layer holds one purpose; organs are the locked core
The product's authored content lives in four delineated layers, and each holds exactly one kind of
thing (the full map is [`docs/MODULE_CHARTER.md`](MODULE_CHARTER.md)):
- **Organs** (`brain/**/SOUL.md`, `IDENTITY.md`, specialty `SOUL_APPEND.md`) — WHO an agent is and
  HOW it thinks: character, values, decision bias, epistemic discipline, and how to *find* skills.
  Never tool syntax (→ Skill, B-16/B-17), a work-path or process id (→ Process), a project fact or
  taxonomy (→ Project), or a Claude-Code/harness concept.
- **Skills** (`skills/`, `specialties/*/skills/`) — HOW to use a capability: tool commands, flags,
  per-tool procedure, error recovery. Never character, a when/sequence work-path, or an
  operator/project particular.
- **Projects** (Firestore `projects/{id}`) — WHERE work happens: the 40,000-foot working-area view
  (name, goal, description), team, durable resource references, and `standardProcesses[]`. Never
  mission particulars/instances, history, transient state, or process/task steps.
- **Processes** (Firestore `processes/` — the global living library; seeds in
  `corekit/config/processes/`, `operator/processes/`) — a **named narrative playbook** of how a
  recurring kind of work is done well: a contextual pattern narrative the agent recalls into its own
  plan as a prior, never a step-machine the daemon executes. Never tool syntax (→ Skill), rigid steps
  / agent-per-step / checkpoint or approval gates (→ the agent's own plan), agent voice/character, or
  an operator particular.

The dividing line between the two know-how layers: *a skill teaches HOW to drive a tool; a process
narrates WHAT has worked for a recurring kind of work*
([`docs/primitives/08-SKILL.md`](primitives/08-SKILL.md)).
Content in the wrong layer is a defect regardless of whether it "works." The layers stratify by
volatility: organs are the frozen identity core, the other three carry all iteration.

**Organs are soft-locked.** An organ changes only by explicit intent. `validate-contracts` pins each
organ file's content hash (`platform/organ-firmware/ORGAN_LOCK.json`) and fails on any un-acknowledged drift;
re-pinning with `update-organ-lock` plus an `organ-change: intended` commit trailer is the sanctioned
acknowledgment — the same verify-or-abort discipline that already guards the `## Deep Truths` region
(`corekit/memory/update-deep-truths`). A parallel always-on check rejects cross-layer leakage (tool
flags, `p-*` ids, project tokens) in any organ body.

**Violation looks like:** a `--flag` or backtick command in a SOUL; a `p-*` process id or an
improvement-module taxonomy frozen into an organ; a mission particular, failure-mode, or transient
state written to project context; a bash/curl block or an operator id inside a process narrative; a
process written as executable steps / agent-per-step / gates instead of a narrative; a "skill" that
governs zero tools and is really a playbook narrative; an organ edited without re-pinning the lock.

### C-29 · Three planes: Foundation, Fleet Definition, Runtime State
Every artifact in the system belongs to exactly one governance plane, and the plane is **independent of
the semantic layer** it sits in (C-28). Organ/Skill/Project/Process says *what kind of thing* something
is; the plane says *who may change it and how*. Base cortex wiring and a designer's role disposition are
both organ content; only the first is platform firmware.
- **Foundation** — deployment-independent mechanism. Repo-owned, release-versioned (`platformVersion`).
- **Fleet Definition** — this deployment's roles, soul overlays, declarative skills, processes,
  responsibilities, policies, assignments and eval suites. Deployment-owned, Prime-authored
  (`fleetRelease` / `agentSpecDigest`).
- **Runtime State** — live work, memory, approvals, health, evidence (`stateSchemaVersion`).

No domain is wholly one plane. Brain, Roles, Souls, Skills, Tools, Processes, Responsibilities,
Projects, Culture of Work, Memory, Secrets, Models, Fleet, Artifacts and Evals each split into
**mechanism** (Foundation), **definition** (Fleet Definition) and **instance/state** (Runtime State).
The classification test and the domain-by-domain table are
[`ADR-001`](adr/ADR-001-three-planes-two-loops.md) and [`MODULE_CHARTER`](MODULE_CHARTER.md).

**Violation looks like:** a deployment-specific role, soul overlay or playbook that can only change by a
generic repository commit; a platform mechanism made editable from a deployment; a document or table
that treats the four semantic layers as the mutability boundary; "is it an organ?" answered as if it
settled "who may change it?"

### C-30 · Foundation is release-owned, not frozen — and unwritable from deployed cognition
Foundation code changes: security defects, performance work, provider changes and schema migrations are
all legitimate. What Foundation guarantees is that it is independent of any customer, application, role
or fleet; semantically stable and backward-compatible; owned by the product repository; changed only
through an explicit platform release; **never writable by a deployed agent**; and exposed to mutable
content only through versioned contracts. The boundary is structural, not behavioral (C-21): installed
Foundation files are read-only to agent cognition, and no agent tool grants a write path to them.

**Violation looks like:** an agent tool that can write under the installed platform root; "Foundation is
immutable" used to block a security fix; a deployed agent holding credentials that can push the generic
repository; a prompt instruction relied upon as the only thing stopping a Foundation write.

### C-31 · Fleet Definitions are immutable revisions; activation is an atomic pointer
A definition is never edited in place. Every revision carries `schemaVersion`, a stable `id`, an
immutable `revision` plus content digest, its parent revision, author identity and timestamp, scope,
platform compatibility range, declared capabilities / tool bindings / secret handles / egress class, and
its validation and evaluation evidence. Every mutation supplies a `baseRevision` and fails closed on
concurrent drift (`409`) rather than overwriting another change. Making a definition live is an atomic
pointer swap; rollback is the same operation aimed at the predecessor.

**Violation looks like:** a definition document mutated in place with no prior revision retained; a write
without `baseRevision` that silently clobbers a concurrent edit; "active" represented by a mutable blob
with no digest; a rollback implemented by re-authoring the old content instead of repointing.

### C-32 · Every mission pins the exact spec that produced it
Work is stamped with `platformVersion`, `fleetRelease` and `agentSpecDigest` at creation, and reads the
pinned spec for its whole life. Definitions never change underneath running work; a new release applies
at an idle mission boundary unless an emergency rollback policy applies. Behavior is therefore
attributable and replayable.

**Violation looks like:** a running mission picking up a mid-flight soul or skill change; telemetry that
cannot say which content produced a behavior; an eval comparing a candidate against a baseline whose
version coordinates were not pinned.

### C-33 · A definition cannot self-grant capability
The compiler computes capability closure. No overlay may replace a Foundation field, add an undeclared
capability, broaden egress, grant IAM, or inject a secret. "Skills are mutable" splits three ways:
a **skill definition** (instructions, cues, recovery, examples, bindings to already-approved tools) is
freely authorable; a **sandbox skill package** (isolated runner, declared CPU/time/filesystem/egress/data
limits, no platform paths, no ambient credentials) is authorable under risk policy; a **capability
provider** (privileged binary, connector, host service, secret injection, IAM integration, new egress
class, daemon action) is Foundation and may only be *requested*.

**Violation looks like:** a SKILL.md that ships a new privileged binary; a role definition naming a
provider that does not exist or that its profile does not grant; an overlay that widens an egress class;
a definition that reaches ambient credentials; capability enforcement living in a prompt rather than the
compiler.

### C-34 · The Platform Finding is the only bridge from a deployment to the repository
When a deployment need genuinely requires a new provider, permission class, schema, state transition or
runtime mechanism, the answer is a structured **Platform Finding** — severity, frequency, scope, version
coordinates, mission evidence, sanitized logs, deterministic reproduction, the desired invariant (not an
unreviewed implementation demand), why no Definition-plane solution is valid, the required capability
class, a privacy/secret scan result, and any fleet-level workaround with its limitations. Prime may
monitor a finding's status and explain upgrade impact. It does not clone, patch, push, merge or deploy
the generic repository as part of fleet improvement.

**Violation looks like:** a deployed agent opening a PR against the product repository; a "temporary"
hand-patch of installed platform files; a platform gap worked around by broadening an agent's raw tool
reach; a finding filed as a free-text complaint with no reproduction or version coordinates.

### C-35 · Activation resolves to immutable digests — never a branch, tag, or fallback ref
A human channel (`STABLE`) resolves to immutable identifiers **before** installation: full source SHA,
CoreKit artifact digest, control-plane image digest, installer and manifest-graph digest, contract and
state-schema epochs, supported Fleet Definition schema range, ordered migration IDs and checksums, build
provenance, and the previous supported rollback release. `main`, `latest`, and "could not resolve SHA,
using the branch name" are not activatable. Installation stages into an inactive slot, verifies, probes,
switches a pointer atomically, health-checks, and returns to the prior slot on failure. Contract and
manifest validation is fatal before services start (C-19).

**Violation looks like:** an install or upgrade that activates a branch name or a mutable container tag;
a SHA-resolution failure that degrades to the branch instead of aborting; files copied into the live tree
one at a time; contract validation that warns and continues; a failed activation that leaves a hybrid
runtime and restarts services anyway.

### C-36 · Fleet definitions and runtime state survive the Foundation lifecycle
A Foundation upgrade, rollback, reboot or agent replacement never erases or silently replaces
deployment-owned content. No manifest owns a path that holds tenant definitions. Definition schemas
carry an N/N-1 compatibility policy with shipped migrations, validated before activation. Rolling out
fleet content never invokes a CoreKit upgrade, and the dashboard never labels one as the other.

**Violation looks like:** a manifest line that overwrites a tenant-authored soul, responsibility or
skill; content rollout implemented as a platform upgrade; an upgrade that drops assignments, profiles or
memory; a definition schema bump with no migration and no compatibility window.

### C-37 · Cognitive latitude is a posture; the spine and the fence are not
The determinism of C-4/C-5 and the structural capability fencing of C-21 are invariant across every
agent — they govern the MACHINE (the daemon, the R→M→C→T envelope state machine, data movement) and the
STRUCTURE (what an agent may touch), not the breadth of judgment the intelligence is granted. That
breadth — execution model tier, sampling, verification strictness, and iteration / tool-call / context
budgets — is a named **posture** the single brain overlays onto its effective contract by role. Prime
agents run **unbound** (a wider cognitive envelope: stronger execution models, more exploratory latitude,
larger budgets); fleet agents run **strict** (the canon-bound baseline, unchanged). The unbound posture is
licensed ONLY because Prime is reachable solely by an administrator through the dashboard (C-1), with a
human in the loop; a fleet agent, acting autonomously in shared channels, is never granted it. The posture
changes only the config the ONE brain reads — never its function: there is exactly one daemon and one
codebase, and the posture is resolved by role, not compiled into a second build. A posture may widen
cognition; it may never loosen the deterministic spine or the structural fence (C-4, C-5, C-15, C-21, C-1,
C-33, C-8, C-27). The unbound prime thinks more freely inside exactly the same walls.

**Violation looks like:** forking the brain daemon into a prime build and a fleet build; a posture that
relaxes a capability fence, secret handling (C-8), or mouth-egress (C-27) "because it's only the prime";
granting fleet agents the unbound posture; moving the determinism of the machine (state transitions, dedup,
routing, data movement) under a posture knob; a "more creative" prime that can now touch what C-21 fenced off.

