# Three Planes — Implementation Plan

**Status:** ACTIVE · **Opened:** 2026-08-15 · **Base:** `df84a75` (v2026.08.15.1.0)
**Source:** *Architect Prime Architecture Assessment and Fleet-Evolution Roadmap* (2026-08-15)
**Canary:** `prime-candicejr` (Prime / author) + `fleet-millie` (assistant / target)

---

## The one sentence

> **The repository defines and releases _how agents work_; each deployment, primarily through
> Prime, version-controls _what its agents are_.**

Three planes, two loops, one bridge:

| Plane | Answers | Authority | Version coordinate |
|---|---|---|---|
| **Foundation** | How does the product work? | Repo + release maintainers | `platformVersion` |
| **Fleet Definition** | What is this deployment's fleet? | Deployment owner; Prime as delegated author | `fleetRelease` / `agentSpecDigest` |
| **Runtime State** | What is happening / happened / was learned? | Runtime services via domain commands | `stateSchemaVersion` |

- **Fleet improvement loop:** Prime → draft → validate → evaluate → canary → promote → observe → roll back.
- **Platform improvement loop:** maintainer → reproducer → RFC → CI → release → operator upgrade.
- **The only bridge:** a structured **Platform Finding**. Not a push token, not filesystem access.

---

## Operator decisions (locked 2026-08-15)

| Decision | Choice |
|---|---|
| Physical restructure | **Full move** to `platform/` + `catalog/` (roadmap §5.1) — executed in CLEANUP, after boundaries are proven |
| Deployed Prime repo credentials | **Remove `github-pr` + `git-ops` from ALL Primes at P4**, once the Platform Finding path is verified |
| Blast radius during build | **candicejr + millie only**, every mechanism contract-flagged default-OFF; millie's definitions are mutable canary subjects; fleet-wide only at final rollout |

---

## Verified current state (checked at `df84a75`, not inherited from the assessment)

Confirmed live defects — each becomes a P0 fix with a regression test:

| # | Defect | Evidence at HEAD |
|---|---|---|
| D1 | Dashboard-created **Project is invisible to runtime** | `app/src/app/api/projects/route.ts` POST writes the doc **without `id`**; `corekit/lib/projects.mjs` `load()` skips any record where `p.id` is falsy |
| D2 | Dashboard-created **Process is invisible to runtime** | `app/src/app/api/primes/[id]/processes/route.ts` POST writes **without `id`**; `corekit/lib/process-registry.mjs` `loadProcesses()` requires `p.id` |
| D3 | **Fleet self-report is unauthenticated** | `app/.../fleet/update-status/route.ts` documents `X-Gateway-Token` verification and performs **none** — any caller can set any agent's status |
| D4 | **Brain gateway auth fails open** | `corekit/brain/index.mjs` `checkAuth()`: `if (!GATEWAY_TOKEN) return true` |
| D5 | **Stale runtime concepts in active prompts** | `follow_process` still instructed in `brain/prime/cortex/SOUL.md:143,197`, `specialties/product-architect/brain/cortex/SOUL_APPEND.md:38`, `skills/delegation/SKILL.md:127,163` — the action was **deleted** at v2026.08.14.6.15 |
| D6 | **CI false confidence** | `.github/workflows/ci.yml:75` runs `node --test test/*.test.mjs` only — the entire `tests/` directory (27 files) is outside CI; no app typecheck/lint/build |
| D7 | **CODEOWNERS covers 3 paths** | `.github/`, `infra/contracts.json`, `corekit/daemon/` — brain, libs, system, manifests, skills all unowned |
| D8 | **Mutable activation refs** | `infra/install.sh:93` `CORE_REF="${CORE_REF:-main}"`; `corekit/system/upgrade-corekit:84` falls back to the branch name when SHA resolution fails; `app/src/app/api/upgrade/route.ts` deploys `:latest` |
| D9 | **Prime has no improvement cadence** | `corekit/config/responsibilities-prime.json` → `"responsibilities": []` |
| D10 | **Prime holds repo-write** | `infra/manifests/role-prime.txt` installs `github-pr` (with `github-clone`, `github-pr-open`) and `git-ops` |

Assets to preserve and formalize (not replace): the git-store CAS substrate
(`corekit/lib/git-store.mjs` — bundles over GCS, refs in Firestore, CAS ref advance,
objects-before-refs), Firestore-overrides-local process loading, manifest-driven install,
`validate-contracts` (18 repo checks + 7 runtime checks), 1,144 passing tests.

---

## Phases

Each phase: **implement → repo suite green → `validate-contracts --repo` green → version-prefixed
commit → deploy to canary → prove live → loop on failure.** No phase is "done" on green tests alone.

### P0 — Integrity and doctrine

**Objective:** stop adding mixed-authority behavior; close the gaps that make expanded Prime
authority unsafe.

1. `docs/adr/ADR-001-three-planes-two-loops.md` — planes, loops, classification test, Prime boundary.
2. Canon amendments: `PRODUCT_CANON.md` (new invariants), `BRAIN_CANON.md`, `MODULE_CHARTER.md`
   **rewritten as a two-axis matrix** (semantic kind × governance plane — the assessment's identified
   root conceptual error), `MISSION_PLAN.md`, `README.md`, `CLAUDE.md`.
3. **D1/D2** — canonical-ID patch on every Project/Process write path + backfill + a cross-surface
   contract test that asserts a dashboard-created entity is loadable by the runtime loader.
4. **D3/D4** — authenticate `fleet/update-status` against the registry token; make brain gateway auth
   fail closed; make missing destructive/public approval a hard failure; stop logging the bootstrap
   gateway token.
5. **D5** — purge `follow_process` from active prompts; re-pin `ORGAN_LOCK.json`.
6. **D8** — require a resolved full SHA and immutable image digest for activation; delete `main`,
   `latest` and branch-fallback paths; make contract/manifest validation fatal before services start.
7. **D6/D7** — CI runs both suites plus app typecheck/lint/build; Scope block mandatory; CODEOWNERS
   expanded to every Foundation path.
8. One Firestore-index authority; ship lockfiles; freeze destructive legacy migration cleanup;
   mark the incomplete custom-skill mutation endpoints experimental; resolve the `Plan` primitive
   (implement or remove from the closed set).

**Exit gate:** every surface has one declared plane, owner, source of truth and mutation path;
critical auth/approval/ID defects have regression tests; canon, active prompts and legal runtime
actions agree; CI exercises all 1,144 tests plus dashboard gates.

**Canary proof:** on candicejr — create a Project and a Process from the dashboard, then show the
brain loads both without a redeploy. On millie — confirm no `follow_process` reaches cognition.

### P1 — Canonical contracts and domain gateways

**Objective:** make "how it works" one executable contract before moving content.

- `corekit/contracts/` (Foundation): pure JS schema + validator per aggregate — Work, Approval,
  Project, Process, Responsibility, Role, Persona, Skill, Capability, Assignment, Memory, Eval,
  Change, Release, PlatformFinding, EffectiveAgentSpec. Canonical ID/path catalog. Provenance
  envelope (`id`, `schemaVersion`, `revision`, timestamps, actor).
- Typed repositories with transactions/CAS and `baseRevision` preconditions; dashboard, daemon,
  shell tools and Prime all route through them. Dashboard TS types **generated** from the same
  schemas — one source, two languages.
- Extract the authoritative work-transition reducer (pure) out of `agent-brain.mjs`; property-test
  legal and illegal transitions; delete duplicate `completeEnvelope` and legacy approval paths.
- Split `infra/contracts.json` into platform defaults and deployment-tunable policy; compile one
  effective snapshot with provenance. **Amend C-7** from "one physical JSON file" to "one compiled
  effective contract with authoritative provenance per plane."
- Dependency rule test: no direct Firestore access outside persistence adapters.
- Define the immutable Foundation release manifest (release ID, source SHA, artifact digests,
  contract/state epochs, supported Fleet Definition schema range, ordered migration IDs, provenance,
  rollback predecessor).

**Exit gate:** dashboard-created entities are runtime-visible through the same contract; all legal
and illegal Work transitions are property-tested; every mutation has authn, authz, revision
precondition, validation and audit provenance; an interrupted install leaves the previous immutable
release running.

### P2 — Fleet Definition Registry and deterministic compiler

**Objective:** establish the authoritative mutable plane, independent of runtime installation.

- Tenant-local `fleet-config` repository on the existing git-store CAS substrate (zero shared
  infrastructure). Layout per roadmap §5.3: `roles/`, `skills/`, `processes/`, `responsibilities/`,
  `project-templates/`, `policies/`, `evals/`.
- Firestore transactional metadata and active pointers: `fleet_changes`, `fleet_releases`,
  `fleet_evaluations`, `fleet_assignments`, `fleet_rollouts`, `platform_findings`. Every revision
  carries schemaVersion, id, immutable revision + digest, parent, author, scope, compatibility range,
  declared capabilities/bindings/secret handles/egress class, evidence, release provenance. All
  writes CAS on `baseRevision`; drift returns `409`.
- **Pure compiler** → Effective Agent Spec + rendered bundle + digest. Composition is ordered:
  `foundation firmware + deployment defaults + role + project overlay + agent overlay`.
  No overlay may replace Foundation fields, add undeclared capability, broaden egress, grant IAM
  or inject secrets.
- Validators: schema, reference resolution, capability closure, layer purity, prompt budget,
  secrets/PII, protected firmware, egress, compatibility, cycles.
- Semantic diff. Release APIs with optimistic concurrency.
- One-time import of the bundled catalog into the tenant registry; `job-*.txt` becomes **generated**
  from canonical Role definitions (ending the tri-source role authority:
  `agent-types.json` + `specialties/*/kit.json` + `infra/manifests/job-*.txt`).

**Exit gate:** golden parity — the compiler reproduces all **12 roles** and **50 skill packages**;
a candidate role built only from existing capabilities compiles with no repo change; a definition
attempting to alter Foundation or acquire undeclared capability fails deterministically; rollback is
an atomic pointer operation.

### P3 — Runtime application and content migration

**Objective:** apply Fleet Definition releases atomically; preserve them across Foundation lifecycle.

- Independent content-sync/reconciliation service: resolve desired assignment → render to a staging
  directory → verify content digest → atomic switch → reload at an **idle mission boundary** →
  report desired vs actual digest. Decoupled from `upgrade-corekit`.
- Replace `assemble-persona` in-place appends with pure bundle rendering.
- Remove the custom-skill block from `upgrade-corekit` (and the `FLEET_AGENT_ID` /
  `agentDisplayName` identity mismatch with it).
- Stamp every mission with `platformVersion`, `fleetRelease`, `agentSpecDigest`.
- Move responsibilities out of manifest-managed local files; move the `workspace/SOUL.md` deep-truth
  tail into versioned profile/memory state (rendered SOUL becomes derived output).
- Per-agent pins, canary cohorts, propagation status, drift reconciliation.

**Migration order:** Processes/Responsibilities → Project schema → Role/persona → declarative skills
and assignments → agent profiles and model/memory policies.

**Exit gate:** a soul, Process, Responsibility or declarative Skill change reaches a canary with **no
GitHub commit and no CoreKit upgrade**, and survives reboot, agent replacement, Foundation upgrade
and Foundation rollback; no manifest overwrites tenant definitions.

### P4 — Prime as Fleet Architect

**Objective:** make Prime conversationally excellent at fleet composition and improvement.

- `skills/fleet-architecture/SKILL.md` handbook (plane classification, role/soul/skill design,
  least-privilege composition, evidence-based diagnosis, anti-overfitting, eval design, canary and
  rollback, provenance and sanitation, how to explain a change).
- Concise Prime charter in protected firmware: mandate, reasoning discipline, authority boundary —
  and nothing else. Evolving know-how lives in mutable Skills and Processes.
- Tools, all clients of the same control-plane service the dashboard uses:
  `fleet-config`, `role-author`, `soul-author`, `skill-author` (rewired — staging stops being the
  end of the workflow), `process-author`, `responsibility-author`, `fleet-assign`, `fleet-eval`,
  `fleet-release`, `platform-finding`.
- Semantic diffs and impact analysis instead of raw file patches.
- Low-risk autonomous improvement responsibility (identify repeated failures → draft → evaluate;
  never silently fleet-promote) — fills D9.
- **Remove `github-pr` and `git-ops` from all Prime roles** once the Finding path is verified (D10).
  Structural boundary: unprivileged cognition identity, root-owned read-only Foundation files,
  no direct Firestore mutation from Prime tools, capability/grant broker instead of direct IAM.

**Exit gate:** from dashboard chat, Prime creates a role, improves a role soul, creates a declarative
Skill, assigns it to a canary, evaluates it, requests approval, promotes it and rolls it back —
and **none** of those actions touches repository source, installed Foundation files or raw Firestore
records. A request for a new connector or IAM class produces a complete Platform Finding, not drift.

### P5 — Behavioral evaluation and governed rollout

**Objective:** make "better" measurable, attributable and reversible.

- Eval Runner: isolated fixtures, fresh contexts, pinned models, deterministic effect simulation.
- Regression suites per role and high-impact skill; sanitized historical replay.
- Baseline vs candidate under identical Foundation, model, tools and fixtures.
- Canary thresholds, automatic pause, critical-regression rollback, observation windows.
- Metrics: independent accept-criteria pass rate, first-pass completion, iteration count, tool-error
  rate, `needs_input`/blocked/timeout/false-complete rate, skill-selection correctness, safety denial
  rate, cost/latency/tool-calls, role rubric, regression rate on unchanged cases.
- Human corrections and false-complete evidence become **candidate eval cases**, never automatic
  prompt edits.

**Exit gate:** no candidate reaches fleet-wide active status without pinned validation and eval
evidence; candidate-vs-baseline attribution is reproducible; rollback thresholds proven in a
fault-injected canary.

### P6 — Fleet Studio UX and enforcement

**Objective:** make the boundary and the lifecycle obvious to the operator.

- Fleet Studio, separate from Foundation/infrastructure settings: roles, souls, skills + tool
  bindings, effective agent + provenance, processes, responsibilities, changes + semantic diffs,
  evaluations, releases/canaries/rollback, platform findings.
- Structured proposal cards in chat (learning, proposed change, before/after, target, evidence, risk)
  with `Run canary` / `Approve rollout` / `Reject` / `Pause` / `Rollback`.
- Replace GitHub-`main` catalog reads with active tenant Definition data and the deployed Foundation
  ref. Display `platformVersion`, `fleetRelease`, `agentSpecDigest` on every agent and work view;
  make expected-vs-actual drift visible.
- Enforce filesystem, import, API, IAM, egress and CODEOWNER boundaries in CI and deployment policy.

**Exit gate:** from one screen an operator can answer what changed, why, who authored it, where it
is active, how it performed, what approval occurred and how to undo it. Boundary tests demonstrate
deployed Prime cannot write Foundation paths or use repo release credentials.

#### Status — enforcement done, the studio is not

**Shipped and proven (`1c9d3f2`, `173898f`):**

- **Boundary enforcement**, as its own CI job. Seven structural rules: the contracts package is
  self-contained; Foundation never imports catalog content; runtime and dashboard do not reach into
  each other; the dashboard never writes `fleet_*` directly; no Prime manifest installs a repo write
  path; every Foundation directory is owned by CODEOWNERS and every rule names an owner; the
  compiled contract is marked generated. **Each is paired with a negative case** proving the
  detector fires — which caught a real hole immediately: the containment check matched on `../`
  depth and so waved through `../lib/firestore.mjs` from `corekit/contracts`, the precise escape it
  exists to catch. Depth is not containment.
- **The version coordinates, served honestly.** `GET /api/primes/[id]/fleet/coordinates` reports all
  three per agent, desired and actual never collapsed, read from the deployment's own records.
  Verified against millie's live assignment: `converged · Running fr-6a524ab97fd1
  (sha256:f9a980797b8d…) as assigned`. The dashboard had no test runner at all — Node's native
  TypeScript stripping means the pure module has 13 real tests, the first in `app/`.

- **The seven exit-gate questions, as a structure** (`954ec95`). `release-view.ts` answers what
  changed / why / who authored it / where it is active / how it performed / what approval occurred /
  how to undo it — or returns an explicit `unknown` with a reason, with `unanswered()` naming the
  gaps. Never-measured is distinguished from measured-zero; an unreadable change is named rather
  than dropped; `created_by` is not passed off as the content author. Served by
  `GET /api/fleet/releases[?id=]`.

  **Run against the live registry it immediately found a real defect** — see below.

- **Template cleanliness for people, not just projects** (`5e5b0ad`). `identity-scan.mjs` +
  validate-contracts Check 19 + a `CODEOWNERS Resolves` CI job that fails closed. Caught a real
  address shipped inside a `fleet-policy.json` comment, which compiles into `contracts.json` and
  installs onto every VM.

- **The screen** (`4aea2d8`). `/p/[id]/studio` shows what each agent is running (all three
  coordinates, desired and actual side by side) and answers the seven questions for a selected
  release. The design rule that carries meaning rather than taste: **an unknown must not look like
  good news** — unknowns render as a marked block with their reason, never an empty cell, and the
  panel leads with a count of how many of the seven the record cannot answer.

- **Deployed content, not `main`** (`043fbc0`). `/api/contracts` and `/api/primes/[id]/brain-config`
  read the prime's own commit. `resolveDeployedRef` keeps a pinned 40-hex commit apart from a
  floating branch — `coreRef` is initialised to the literal `"main"` and only becomes a commit once
  a deploy resolves one, so the field holds two different kinds of thing. A floating ref returns
  WITH its reason as `_source`, so a caller renders it as unpinned rather than as fact.

**Not built — no partial credit claimed:**

- Structured proposal cards in chat with `Run canary` / `Approve` / `Reject` / `Rollback`.
- The Studio's authoring surfaces: roles, souls, skills and semantic diffs are readable through
  `fleet-config` but have no screen. The exit gate's read half is met; authoring is still CLI.
- `/api/agent-types` still reads `main` — deliberately. It is a fleet-wide catalog read with no
  single prime to resolve against, and inventing one would be worse than the honest `main`.
- The Studio page is **not visually verified**: the dashboard is behind authentication and
  disabling it for a screenshot is not a trade worth making. `tsc` and a production build cover
  compilation only.
- IAM and egress boundary enforcement in deployment policy (the CI half is done; the deployed half
  is not).
- The CODEOWNERS owner swap. The operator chose a team handle; landing it before the team exists
  would reproduce the failure it exists to prevent — every rule inert while still reading as
  enforced. `.github/CODEOWNERS` is exempt from Check 19 until then, and the reason is written at
  the exemption rather than left as a silent hole.

#### The rollback target that was never set

Running the exit gate against the live registry produced this, for both releases:

```
undo : UNKNOWN — this release has no predecessor, so there is nothing to roll back to
```

`parent_release` came from `activeReleaseId()`, which matches only `status === 'active'`. A release
reaches `active` only after a full promotion, and a canary-first rollout never takes it there — both
live releases sit at `canary`. So every release recorded a null parent and none had anywhere to roll
back to. C-31 makes rollback a pointer operation with a target named in advance;
`evaluateRollout` can decide `rollback`, and `observe --apply` would then find no target and pause
instead. **The one moment the promise matters is the one where it was missing.**

`previousLiveReleaseId()` supersedes it: newest release at `active` or `canary`, excluding
`superseded` and `rolled-back` (rolling forward onto something already rolled back would undo the
undo). Two equality filters rather than an unfiltered read — the shape that made the rollout gate
report zero missions.

**Live data still needs a backfill:** `fr-6a524ab97fd1` carries a null `parent_release`. The code is
fixed; the existing record is not, and no tenant data was edited to change that.

### CLEANUP — restructure, purge, redocument

**Objective:** main branch is wholly fresh — no former-version scaffolding retained.

- Community exchange: signed portable packages, sanitizer, untrusted-draft import, local
  compatibility validation and evaluation before activation.
- Delete every legacy writer, duplicate seed, hand-authored role triad, upgrade-coupled custom-skill
  sync, stale flag, dead claim and GitHub-live catalog read.
- **Full §5.1 physical move** to `platform/{contracts,runtime,work,persistence,security,context,
  deployment,control-plane,providers,organ-firmware}` + `catalog/`, rewriting every manifest, import
  and doc. Invariants over names: Foundation never imports concrete catalog/tenant definitions;
  catalog is seed content only; dashboard and Prime never bypass authoritative domain services;
  generated artifacts are marked and never edited as sources.
- Per-file efficiency pass (the assessment's hotspots: `agent-brain.mjs` 5,541 lines,
  `checkpoint-executor.mjs` 1,843, `agent-mouth.mjs` 1,096, `git-store.mjs` 1,042).
- Regenerate canon, contract references, README, MISSION_PLAN, primitives and guides from
  authoritative schemas to the new normal. N/N-1 compatibility policy set and enforced.

**Exit gate:** community content imports without leaking deployment data or acquiring automatic
authority; every legacy writer and duplicate authority is gone; a clean deployment and an upgraded
deployment converge to the same effective state for the same two version coordinates.

---

## Progress log

| Phase | Commit | Proven on the canary |
|---|---|---|
| **P0** integrity & doctrine | `be099b5` | Gateway refuses an unauthenticated call (401, was served); zero `follow_process` reaching cognition; a record stored with no `id` — the old dashboard shape — went from **SKIPPED** to **LOADED** through the installed production code path |
| **P1a** contracts package, C-7 split | `4887972` | 32 Foundation / 202 deployment values, lossless round trip; provenance visible on the VM |
| **P1b** Work state machine | `25f5e52` | Real mission on millie completed with **0** `illegal_transition` observations — the table matches the daemon |
| **P2** registry & compiler | `65f8de3`…`e084492` | Live tenant: 106 definitions sealed → validated → released `fr-bc76ebe656e2` → millie pinned → spec compiled (12 skills, 74 capabilities, closure clean) |
| **P3** runtime apply & stamping | `eca92bb`…`6f238c4` | **A soul change reached millie with no GitHub commit and no CoreKit upgrade** (`coreRef` unchanged across the apply); mission stamped with all three coordinates |
| **P4** Prime as Fleet Architect | `d847527`…`eebc848` | All four repo push paths **absent** on candicejr; a Platform Finding refuses missing fields, refuses an embedded secret, and files when complete |
| **P5** evaluation & rollout gate | `1377be6`…`a6361e9` | Gate runs live against the tenant: a candidate clearing every floor but regressing on its baseline still rolls back; a critical breach does not wait for the window |
| **P5 fix** idempotent composition | `a5e8138` | **Applying the same release three times is applying it once** — see below |
| **P5 fix** the gate reads its own release | `8c1ba91`…`7918999` | Five real missions on millie: `hold` at three, `promote` at five, all rates clean |

### The P3 exit gate, demonstrated

```
author  → change fc-2b380a2f921b (persona assistant-cortex, +74 chars)
diff    → "persona 'assistant-cortex': body: rewritten" · impacted: ["millie"]
validate→ ok, 6 checks
release → fr-6a524ab97fd1
apply   → 3 written, 24 unchanged   ← no-op detection working
result  → marker in live SOUL.md: 0 → 1
          coreRef before and after: 6f238c45b259 (unchanged)
mission → platform_version 6f238c45b259…
          fleet_release    fr-6a524ab97fd1
          agent_spec_digest sha256:a7404054cc66… (= CONTENT.json)
```

### FIXED — content-sync was not idempotent (found 2026-08-15, P5 canary)

**Symptom.** Applying the same release twice composes the soul overlay twice.
`fleet-millie` currently carries the assistant-cortex overlay **2×** (20,193-byte
SOUL, two `<!-- role: assistant-cortex -->` provenance comments), and her
attested `agent_spec_digest` changes on every apply even when no content changed.
Downstream, `fleet-config observe` cannot group her missions, so the rollout gate
reports 0 missions for a release that has run several.

**Cause.** `agent-content-sync` reads base firmware from the *installed*
`workspace-<organ>/SOUL.md` — which is the rendered output of the previous apply.
Each run composes the overlay onto its own previous output. This is exactly the
`assemble-persona` in-place-append defect that P3 claimed to replace,
reintroduced through the firmware *input* rather than the write path. The
staging, digest-verify and atomic-swap machinery is correct; what it is handed is
not.

**Fix (shipped v2026.08.15.7.4).** Every organ SOUL now installs twice, and the
pair is the whole fix:

| file | plane | written by |
|---|---|---|
| `workspace-<organ>/SOUL.base.md` | Foundation | the manifest, and nothing else, ever |
| `workspace-<organ>/SOUL.md` | Fleet Definition | composition — truncated and re-rendered each time |

Composition reads the base and writes the render, so the render is recomputable
from scratch rather than accumulated. That makes the rendered SOUL the derived
cache MODULE_CHARTER already says it is ("the rendered effective SOUL is a
**cache**"). Four changes carry it:

1. `role-prime.txt` / `role-fleet.txt` install each organ SOUL to both paths.
2. `agent-content-sync` reads `SOUL.base.md` **and nothing else** — the old
   fallback to `SOUL.md` is now a hard error. The fallback is what made the bug
   possible, and it looked like forgiveness.
3. `assemble-persona` renders instead of appending. It was correct exactly once;
   a second run appended a second copy, and it only survived because an upgrade
   happened to reinstall a fresh SOUL.md first.
4. `reconcile` re-derives convergence from the live tree (`bundleMatches`)
   instead of trusting the registry's `actual_spec_digest`. Otherwise a platform
   upgrade that reverts a rendered file leaves an agent permanently stale,
   because nothing ever asks again (B-28).

Two consequences of the new file, both of which would have shipped as breaks:
the motor workspace sweep would have deleted the base between missions (leaving
nothing to compose onto), and the artifact `.gitignore` would have let it leak
into a project commit. Both closed, both tested.

No migration script is needed: the upgrade overwrites `SOUL.md` from the
manifest, and the next render is clean.

**Proven on the canary.** millie had reached **7×** (a 28,388-byte SOUL) before
the fix — worse than the 2× first observed, because every manual apply during
P5 added another copy.

```
before          overlay 7× · SOUL 28,388 bytes · no SOUL.base.md
upgrade a5e8138 SOUL.base.md 15,395 · render reset, overlay 0×
                assemble-persona → 16,915 (base + specialty layer, once)
apply 1         27 written · spec sha256:f9a980797b8d… · overlay 1× · 17,034 bytes
apply 2         skip: already converged
apply 3         skip: already converged
after 3 applies 17,034 bytes · overlay 1× · base 15,395 untouched · digest unchanged
```

And the drift path, which is the half that is easy to get wrong — revert the
render the way a platform upgrade would, while the registry still says
converged:

```
cp SOUL.base.md SOUL.md      overlay 0× — the agent is now running Foundation defaults
sync                          "content on disk has drifted from the assigned spec — re-applying"
                              1 written, 26 unchanged   ← the no-op detection stays precise
after                         17,034 bytes · overlay 1×
```

Before the fix that same state reported `already converged` and left the agent
stale indefinitely.

### The gate was reading the wrong sample (found in the same proof run)

With composition fixed, millie's three proof missions all carried the same
stable stamp — release `fr-6a524ab97fd1`, spec `sha256:f9a980797b8d…`, platform
`a5e813876956` — and `observe` still reported **0 missions**.

`observe` read the deployment-rooted `work` collection with *no filter* and a
limit of 300, then grouped locally. `work` holds every mission the deployment
has ever run, so that read returns an arbitrary 300 documents which almost
certainly exclude the release being judged.

The failure mode is the dangerous kind: "0 missions — too early to judge" is
indistinguishable from a genuinely young release, so an operator waits for
evidence that will never arrive. A gate that says *I have no evidence* when it
means *I looked somewhere else* is worse than no gate.

Fixed in `a5e8138`…`7918999`: the read asks for the release's own work (one
equality filter on `fleet_release`, no composite index), and lives on the
registry where the injectable-db doubles can exercise it. It now also reports
what it did not cover — a truncated read and any unstamped missions — because a
sample that reads as a census is how a partial view becomes a confident verdict.

The detail that let this hide: the fake db ignored `limit`. A caller that reads
a capped slice and filters locally is perfectly correct against an unbounded
fake and wrong against Firestore. The fake honours `limit` now.

### The P5 exit gate, demonstrated

Five real missions on millie, all carrying the same stable stamp, judged by the
gate running on candicejr:

```
3 missions  → hold     "only 3 of 5 finished mission(s) — too early to judge"
5 missions  → promote  "clean over 5 finished mission(s)"

candidate: completion_rate 1 · false_complete_rate 0 · failure_rate 0
           stalled_rate 0 · mean_iterations 1 · tool_error_rate 0
```

The hold is as much of the proof as the promote: the gate declined to judge on
three missions and changed its verdict only when the evidence arrived, rather
than promoting whatever it saw first.

### The timer was already running — a correction

While writing this up I recorded that "the sync timer is not enabled, so nothing
compounds on its own". That was wrong, and the journal says so plainly: the
`timers.target.wants` symlink was created at **18:10** and the service has 94
starts. The doubling was not an artifact of manual applies during P5 — it was an
unattended loop adding a copy every five minutes whenever a compile succeeded.
It reached 7× rather than hundreds only because most early runs failed on an
unrelated Firestore error.

The claim was comforting and unverified, which is the combination worth
distrusting. `systemctl list-timers` reports the *next* run, not whether the unit
was enabled by me a moment ago or by bootstrap hours earlier; the symlink's
timestamp is what actually answers that.

The correction improves the result rather than spoiling it, because the proof is
now unattended:

```
20:35, 20:41  (pre-fix)   applied … 3 written, digests 6e5d140c → 07c0e1e2 → different every run
20:46         (mid-upgrade) ERROR: no base firmware at workspace-cerebellum/SOUL.base.md
                            ← the new fail-closed guard, refusing to compose onto its own output
20:52, 20:57, 21:03 …     skip: already converged   (five consecutive)

soul unchanged across all of them: sha256 285b760e… · overlay 1× · 17,034 bytes
```

The 20:46 line is the guard doing its job unrehearsed: the new code was installed
before the base file it depends on, and it refused rather than duplicating.

**The test that would have caught it** now exists —
`test/content-sync-idempotence.test.mjs` applies the same release five times and
asserts one overlay and an unchanged tree digest. It also keeps the *bug itself*
as a live case: composing from the render accumulates one copy per apply, so if
anyone reinstates the fallback the difference is visible in the same file.

### Carried forward (not done, not implied)

- Agent profiles / deep truths still live in the manifest-managed `workspace/SOUL.md` tail.
- Responsibilities still ship as manifest-installed local files.
- `agent-content-sync.timer` is installed but not yet enabled by bootstrap — the canary runs it
  by hand. Enabling it is a bootstrap edit, not a mechanism change.
- The transition guard stays in `observe`; `enforce` after a wider clean window.
- Dashboard lint (56 errors) becomes a CI gate in CLEANUP.

---

## Canary proof loop (roadmap §11.3) — the real definition of done

Run on `prime-candicejr` (author) and `fleet-millie` (target). Loop until all ten pass.

| # | Scenario | Passes when |
|---|---|---|
| 1 | **New role** | Prime creates and canaries a role from existing capabilities with no repository change |
| 2 | **Soul improvement** | Role overlay changes; active work stays pinned; new work uses the candidate; rollback restores the prior digest |
| 3 | **Skill improvement** | Prime authors a declarative Skill, validates bindings, evaluates, assigns and observes it with no CoreKit upgrade |
| 4 | **Capability boundary** | A new connector cannot be smuggled into a Skill; it becomes a Platform Finding |
| 5 | **Foundation upgrade** | Upgrade preserves fleet release, assignments, responsibilities, profiles, memory and project state |
| 6 | **Concurrency** | Two edits from the same base produce a conflict, not a lost update |
| 7 | **Secret safety** | No plaintext in prompts, Firestore, files, Git, logs or eval captures |
| 8 | **Tenant isolation** | Definition content and state never cross deployment projects |
| 9 | **Canary failure** | A deliberately regressive candidate auto-pauses/rolls back and leaves evidence |
| 10 | **Repo separation** | Deployed Prime lacks credentials and filesystem capability to modify Foundation, even when prompted to |

## Success measures (roadmap §12)

| Outcome | Target |
|---|---|
| Deployment-specific role/soul/declarative-Skill changes needing a repo commit | 0% |
| Fleet-wide changes with immutable diff, author, validation, eval evidence and rollback target | 100% |
| Missions stamped with Foundation, Fleet release and effective digest | 100% |
| Foundation writes possible from deployed Prime cognition | 0 |
| Definition rollouts requiring a Foundation upgrade | 0 |
| Roles preserved by compiler golden tests | 12 / 12 |
| Skill packages classified Definition / sandboxed / Provider | 50 / 50 |
| Secret plaintext in model, log, state or artifact scans | 0 |
| Runtime mutation APIs without auth, validation, revision precondition and audit | 0 |

---

## Risk register

| Risk | Mitigation |
|---|---|
| Big-bang refactor destabilizes the live fleet | Every mechanism contract-flagged default-OFF; enabled on candicejr + millie only; dual-read during migration |
| Restructure churn without separation | Boundaries, schemas, APIs and import rules first; the folder move is **last**, in CLEANUP |
| Mutable Skill code becomes an escape hatch | Three-way split: declarative Skill (mutable) / sandbox package (policy-gated) / capability Provider (Foundation only) |
| Definitions change under running work | Pin the Effective Agent Spec per mission; apply releases at idle boundaries |
| Evaluation confounds model and content changes | Pin Foundation, model, providers and fixtures on both sides |
| Foundation upgrade breaks old definitions | N/N-1 compatibility declared, migrations shipped, validation before activation, rollback preserved |
| Prime overfits a single failure | Baseline cases, multiple evidence points, canary, explicit regression additions |
