# Module Charter — What Goes Where, and Who May Change It

> Two normative rules meet in this document. **C-28** governs *what kind of thing* a piece of content
> is (layer purity). **C-29** governs *who may change it and how* (governance plane). They are
> **independent axes**. This charter is the operational map of both.

Read the two questions separately, always:

1. **What kind of thing is this?** → Organ · Skill · Project · Process (the semantic layer, C-28)
2. **Who owns it and how does it change?** → Foundation · Fleet Definition · Runtime State (the
   governance plane, C-29)

Answering one does not answer the other. Base cortex wiring and a designer's role-specific disposition
are both **organ** content; only the first is platform firmware. A skill's package schema and a skill's
procedure text are both **skill** content; only the first is Foundation. Treating the four layers as the
mutability boundary was the original conceptual error this charter corrects
([ADR-001](adr/ADR-001-three-planes-two-loops.md)).

---

## Axis 1 — Semantic layer (C-28): what kind of thing is it?

| Layer | Answers | Holds | Never holds → goes to |
|---|---|---|---|
| **Organ**<br>SOUL / IDENTITY | WHO the agent is + HOW it thinks | character, values, decision bias, epistemic discipline, output contract, *how to find skills* | tool syntax → **Skill** · work-path or process id → **Process** · project fact/taxonomy → **Project** · harness concept (AGENTS.md) → *nowhere* |
| **Skill**<br>SKILL.md + bindings | HOW to use a capability | tool commands, flags, per-tool multi-step procedure, error recovery, tool-usage examples | character → **Organ** · when/sequence work-path → **Process** · operator/project particular → **Project** |
| **Project** | WHERE work happens (the working area) | 40,000-ft name/goal/description, `team`, durable resource references (`{kind,ref,summary}`), `standardProcesses[]` | mission particular/instance → **Artifact/Mission record** · history/failure-mode → *nowhere (or a Process learning)* · transient state → *nowhere* · process/task steps → **Process** |
| **Process**<br>narrative playbook | WHAT has worked for a recurring kind of work | a contextual pattern **narrative** (prose), a one-line description, recall cues (`intent_keywords`); recalled into the agent's own plan as a prior | tool syntax → **Skill** · rigid steps / agent-per-step / checkpoint & approval gates → **the agent's own plan** · voice/emoji/character → **Organ/Mouth** · operator particular → **Project** or the Mission |

### The two load-bearing lines

- **Organ vs Skill** (B-16/B-17): *SOULs teach cognitive patterns; skills teach procedures.* The
  SOUL says **what** to produce and how the agent should reason; the SKILL.md says **how** to drive
  the tools. Tool syntax lives *exclusively* in skills.
- **Skill vs Process** ([08-SKILL.md](primitives/08-SKILL.md)): *A skill teaches HOW to drive a tool; a
  process narrates WHAT has worked for a recurring kind of work.* A skill is a reusable capability
  (drive Google Docs), carrying tool syntax. A process is a contextual pattern **narrative** (how a
  redlined legal doc has been finalized well before) — no tool syntax, no rigid sequence; the agent
  recalls it into its own plan and adapts it.

---

## Axis 2 — Governance plane (C-29): who may change it?

| Plane | Answers | Authority | Change style | Prime access | Version |
|---|---|---|---|---|---|
| **Foundation** | How does the product work? | Repo + release maintainers | Reviewed code, migrations, CI, versioned release | Read/introspect, invoke public APIs — **no direct mutation** | `platformVersion` |
| **Fleet Definition** | What is this deployment's fleet? | Deployment owner; Prime as delegated author | Immutable revisions, semantic diffs, evals, canaries, atomic activation | Broad CRUD, composition, evaluation, rollout, rollback **within policy** | `fleetRelease` / `agentSpecDigest` |
| **Runtime State** | What is happening / happened / was learned? | Runtime services via domain commands | Transactional transitions, append-only evidence | Operate through commands — **no raw-record mutation** | `stateSchemaVersion` |

Repository evolution is a **governance loop around** Foundation, not a fourth plane.

---

## The matrix — both axes at once

Every domain splits three ways: **mechanism** (Foundation) · **definition** (Fleet Definition) ·
**instance/state** (Runtime State).

| Domain | Foundation — mechanism | Fleet Definition — definition | Runtime State — instance |
|---|---|---|---|
| **Brain / organs** | organ topology, legal action schemas, routing, prompt assembly, model/provider ABI, verification protocol | role and deployment soul overlays, model policy, collaboration policy | session context, active mission context, organ traces |
| **Roles** | role schema, compiler, capability closure, compatibility checks | purpose, owned outcomes, decision posture, default skills, responsibilities, escalation contract | agent→role assignments, rollout status |
| **Souls / identity** | protected firmware blocks, composition order, reserved fields, validation | role soul, deployment culture overlay, optional agent profile overlay | learned preferences and truths with provenance; the rendered effective SOUL is a **cache** |
| **Skills** | package schema, resolver, validator, sandbox, tool-provider ABI, installer/synchronizer | procedure, triggers, recovery guidance, examples, approved tool bindings, assignments | installed digest, use telemetry, deviations, eval results |
| **Executable tools** | privileged provider implementation, connector, secret injection, IAM and egress policy | references to already-approved providers; sandboxed script package where policy permits | invocation record, result metadata, audit event |
| **Processes** | schema, version/scope resolver, recall/matching, registry API | narrative playbooks, intent cues, applicable scopes | use evidence and outcomes |
| **Responsibilities** | scheduler, leasing, idempotency, event matching, timezone/catch-up rules | schedule/event rule, instruction, target, success criteria, enablement | cursor, lease, last/next fire, execution history |
| **Projects** | schema, hierarchy, context inheritance, dependency semantics, repository API | project templates and deployment conventions | project records, membership, accumulated context, status |
| **Culture of work** | R→M→C→T state machine, transition reducer, approvals, waits, delegation, artifact/outbox rules | approval thresholds and routing policy within platform bounds; narrative processes | envelopes, approvals, handoffs, checkpoints, tasks, artifacts |
| **Memory** | storage/retrieval, consolidation, supersession, provenance, retention and prompt-budget algorithms | memory/retention policy, role-specific recall priorities | facts, observations, summaries, preferences, lessons |
| **Secrets** | secret broker, redaction, workload identity, grant reconciliation, audit | required secret handles and allowed purposes | secret values in Secret Manager; grants and audit events |
| **Models** | provider compatibility, routing API, fallback semantics, budget enforcement | per-role model and cost/quality policy | calls, cost, latency, failures |
| **Fleet** | agent lifecycle/reconciler, images, health, package application | desired role/capability/release assignments | VMs, service health, actual digest, drift status |
| **Artifacts** | git store, CAS semantics, merge/publish protocol | retention and merge policy within bounds | objects, refs, changed-path manifests |
| **Evals** | runner, isolation, graders, metrics schema | role/skill regression cases and rollout thresholds | eval runs, comparisons, decisions |

---

## Deciding where a thing goes

Ask both questions. **Layer first, then plane.**

### Layer (C-28)

1. Is it **tool syntax** (a command, flag, API shape)? → **Skill**. Always. No exceptions in organs or
   processes.
2. Is it **who the agent is / how it reasons / its values**? → **Organ**.
3. Is it a **durable fact about a working area** (a repo, a Drive folder, a design-system doc, the team,
   the processes that apply)? → **Project** — as a resource reference, not a story.
4. Is it a **pattern of how a recurring kind of work is done well**, worth remembering as a narrative to
   adapt (not a rigid sequence to run)? → **Process**.
5. Is it a **one-off particular of this mission**? → the **Mission record / Artifact**, not any of the
   four layers.

### Plane (C-29) — the classification test

1. Is it a live occurrence, observation or assignment? → **Runtime State**.
2. Does it define a role, preference, procedure, schedule, playbook or policy using capabilities the
   platform **already exposes**? → **Fleet Definition**.
3. Does it change an invariant, schema, state transition, provider, privileged executable, storage
   behavior, security boundary, IAM capability class or installation behavior? → **Foundation**.
4. Would two unrelated deployments reasonably want different values? → it must not be hard-coded in
   Foundation.
5. Can the proposed definition acquire power its compiled capability profile does not already grant? →
   reject it as a definition and file a **Platform Finding** (C-34).

This test exists twice on purpose: as this document, and as compiler and static-analysis rules.

---

## The process ↔ memory boundary

A playbook is remembered know-how, so it must be told apart from the memory tiers beside it. (These
tiers are a third axis: a Process is authored content; the memory tiers are the agent's living state.)

- **Process (playbook)** — a *named, shareable, reusable how-to narrative*: "how a recurring kind of work
  is done well." Fleet Definition content; every agent recalls and evolves it.
- **Working memory** (`MEMORY.md`) — the transient scratchpad, pruned relentlessly. Runtime State.
- **Core memory** — an atomic durable fact, actively retired and superseded. Runtime State.
- **Deep truth** — a behavioral constraint, changed rarely and only on multi-session evidence. Fleet
  Definition (an agent-profile overlay), *rendered into* the effective SOUL — never authored in place in
  a manifest-managed file.

The test: if it is *a fact*, it is memory; if it is *a constraint on behavior*, it is a deep truth; if it
is *a named narrative of how a kind of work goes well*, it is a Process.

---

## The skill code boundary (C-33)

"Skills are mutable" never means "any prompt may install arbitrary host code."

| | What it is | Plane | Who may author |
|---|---|---|---|
| **Skill definition** | instructions, selection cues, error recovery, examples, validation, bindings to already-approved tools | Fleet Definition | Prime, freely |
| **Sandbox skill package** | code in an isolated runner with declared CPU/time/filesystem/egress/data limits, no platform paths, no ambient credentials | Fleet Definition, policy-gated | Prime, under risk policy, evaluation required |
| **Capability provider** | privileged binary, connector, host service, secret injection, IAM integration, new egress class, daemon action | Foundation | Maintainers only — Prime **requests** via a Platform Finding |

---

## Anti-patterns

**Layer violations** (each seen in the repo before this charter):

- A `p-*` process id or a "9 improvement modules" taxonomy frozen into a SOUL → the SOUL carries the
  *stance*; the narrative lives in the Process library, the taxonomy in the Project.
- `AGENTS.md` in a motor's immutable-files list → a Claude-Code harness concept; no such file is deployed
  to an agent.
- `legal_review_review_procedure` as a **project context key** → a work-path; it is a **Process**.
- A specific `document_id_…`, `…-repo-state`, `…-font-pairing` in project context → mission particulars,
  transient state, design decisions; none are 40,000-ft working-area facts.
- A `firebase deploy …` block inside a process narrative → tool syntax; the narrative names the kind of
  work, the skill holds the command.
- A "skill" with `scripts: []` that is really a narrative → it governs no tools; it is a **Process**.

**Plane violations:**

- A deployment-specific role, soul overlay or playbook that can only change through a generic repository
  commit → Fleet Definition content trapped in Foundation.
- A hand-authored `job-*.txt` manifest as a third authority beside `agent-types.json` and
  `specialties/*/kit.json` → one canonical Role definition; manifests are **generated**.
- The dashboard reading its role catalog from GitHub `main` → the deployment's authority is its own
  active Fleet release, not a branch.
- A skill package that ships a new privileged binary → that is a capability provider, not a skill.
- Rolling out a soul change by invoking a CoreKit upgrade → content rollout is not a platform upgrade
  (C-36).
- A deployed agent holding a repository push token "so it can fix the platform" → C-34; the bridge is a
  Platform Finding.

---

## Enforcement

`validate-contracts` (the CI `contracts` gate, C-19) carries both axes:

- **Layer purity** — no tool flags, `p-*` ids or project tokens in organ bodies; project-context shape;
  process purity.
- **Organ soft-lock** — content-hash pin in `brain/ORGAN_LOCK.json`, re-pinned by `update-organ-lock`
  with an `organ-change: intended` commit trailer.
- **Plane boundaries** — Foundation never imports concrete catalog or tenant definitions; no direct
  Firestore access outside persistence adapters; generated artifacts carry their source digest and are
  never edited as authorities; deployed agent tools have no write path under the installed platform
  root.

See PRODUCT_CANON **C-28** (layers) and **C-29 … C-36** (planes).
