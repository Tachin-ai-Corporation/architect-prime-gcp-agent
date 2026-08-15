# ADR-001 — Three Planes, Two Loops, One Bridge

**Status:** Accepted · **Date:** 2026-08-15 · **Supersedes:** the single-axis reading of `MODULE_CHARTER.md`
**Deciders:** repo maintainers (CODEOWNERS)
**Implements:** [THREE_PLANES_PLAN](../plans/THREE_PLANES_PLAN.md)

---

## Context

Architect Prime already has the primitives of an agent platform: deterministic installation, structured
cognition, fleet lifecycle, work envelopes, projects, processes, memory, approvals, secrets, an artifact
substrate, telemetry and a dashboard. The weakness was never a missing primitive. It was that
**ownership and mutability boundaries cut across the folders and were not enforced by any single control
plane.**

That produced a standing paradox:

> **Prime has too much low-level power and too little high-level authority.**

Prime can reach shell, filesystem, GitHub, GCP and fleet operations, yet it cannot safely complete the
lifecycle the product needs — create or refine a role, soul, skill, process or responsibility; validate
it; evaluate it; canary it; promote it; observe it; roll it back. So it does one of two harmful things:
turns deployment-specific learning into a generic repository change, or patches live state through broad
tools. Both create drift.

### The root conceptual error being corrected

`MODULE_CHARTER.md` classified content by **semantic kind** — Organ, Skill, Project, Process — and then
used that same taxonomy as the **mutability boundary**. Those are independent axes. Base cortex wiring
and a designer's role-specific disposition are both "organ" content, but only the first is platform
firmware. C-28 remains correct about layer purity; it was never a statement about who may change a file.

## Decision

### 1. Three planes

| Plane | Answers | Authority | Change style | Prime access | Version coordinate |
|---|---|---|---|---|---|
| **Foundation** | How does the product work? | Generic repository + release maintainers | Reviewed code, migrations, CI, versioned release | Read/introspect; invoke public APIs; **no direct mutation** | `platformVersion` |
| **Fleet Definition** | What is this deployment's fleet? | Deployment owner; Prime as delegated author/operator | Immutable drafts and releases, semantic diffs, evals, canaries, atomic activation | Broad CRUD, composition, evaluation, rollout, rollback **within policy** | `fleetRelease` / `agentSpecDigest` |
| **Runtime State** | What is happening, what happened, what was learned? | Runtime services via domain commands | Transactional transitions, append-only evidence | Operate through commands; **no arbitrary raw-record mutation** | `stateSchemaVersion` |

Repository evolution is a **governance loop around** the Foundation Plane — not a fourth bucket.

### 2. "Foundation" does not mean frozen

Security defects, performance work, provider changes and schema migrations will still happen. Foundation
means:

- independent of any customer, application, role or fleet;
- semantically stable and backward-compatible;
- owned by the product repository;
- changed only through an explicit platform release;
- **not writable by deployed agents**;
- exposed to mutable content through versioned contracts.

### 3. Every domain splits into mechanism / definition / instance

No domain is wholly fundamental or wholly mutable. Brain, Roles, Souls, Skills, Tools, Processes,
Responsibilities, Projects, Culture of Work, Memory, Secrets, Models, Fleet, Artifacts and Evals each
divide the same way: the **mechanism** is Foundation, the **definition** is Fleet Definition, the
**instance/state** is Runtime State.

Worked example — Skills:

| Layer | Content | Plane |
|---|---|---|
| Package schema, resolver, validator, sandbox, tool-provider ABI, installer | mechanism | Foundation |
| Procedure, triggers, recovery guidance, examples, approved tool bindings, assignments | definition | Fleet Definition |
| Installed digest, use telemetry, deviations, eval results | instance | Runtime State |

### 4. Two loops, one bridge

- **Fleet improvement** — Prime changes deployment definitions through validation, evaluation, canary,
  promotion and rollback. Frequent, deployment-specific, evidence = behavioral evals and canary missions.
- **Platform improvement** — maintainers change repository mechanisms through reproducible defects, code
  review, CI, release, migration and operator-controlled upgrade. Deliberate, cross-deployment,
  evidence = reproducer plus test suites.

The **only** bridge is a structured **Platform Finding**. Not filesystem access. Not a repository push
token on the deployed Prime.

### 5. The classification test

Applied in order to every proposed change — as documentation **and** as compiler/static-analysis rules:

1. Is it a live occurrence, observation or assignment? → **Runtime State**.
2. Does it define a role, preference, procedure, schedule, playbook or policy using capabilities the
   platform already exposes? → **Fleet Definition**.
3. Does it change an invariant, schema, state transition, provider, privileged executable, storage
   behavior, security boundary, IAM capability class or installation behavior? → **Foundation**.
4. Would two unrelated deployments reasonably want different values? → it must not be hard-coded in
   Foundation.
5. Can the proposed definition acquire power its compiled capability profile does not already grant?
   → reject it as a definition; create a **Platform Finding**.

### 6. Prime's charter

Prime is the deployment's **Fleet Architect and Operator**. It should have very few *cognitive* rails —
it may reason creatively, inspect deeply, author broadly and propose novel fleet designs — and strong
*structural* rails at the only boundary that matters: **Definition content cannot mutate Foundation or
self-grant power.**

Prime does not modify the generic platform implementation, its installed copy, or its security
boundaries. It identifies genuine platform defects and submits Platform Findings.

### 7. The skill code boundary

"Skills are mutable" must never mean "any prompt may install arbitrary host code." Three distinct things:

1. **Skill definition — mutable.** Instructions, selection cues, error recovery, examples, validation,
   bindings to already-approved tools. Prime authors freely.
2. **Sandbox skill package — mutable under policy.** Code executed in an isolated runner with declared
   CPU/time/filesystem/egress/data limits, no access to platform paths or ambient credentials. Prime
   authors and canaries under risk policy.
3. **Capability provider — Foundation.** Privileged binaries, connectors, host services, secret
   injection, IAM integrations, new egress classes, daemon actions. Prime may **request**, never create
   or install.

## Consequences

### Canon

New invariants **C-29 … C-36** encode the planes, the Foundation boundary, immutable definition
revisions, per-mission spec pinning, capability closure, the Platform Finding bridge, digest-only
activation, and definition survival across Foundation lifecycle. `docs/MODULE_CHARTER.md` is rewritten
as a two-axis matrix. `BRAIN_CANON` gains **B-35/B-36** (one compiled Effective Agent Spec; protected
firmware is not overlayable).

Two existing invariants are amended as their implementations land:

- **C-7** — from "one physical JSON file" to "one compiled effective contract with authoritative
  provenance per plane" (at P1, when `infra/contracts.json` splits).
- **B-26 "Prime Unbound"** — from generic-repo authorship to Fleet Architect authority (at P4, when the
  Platform Finding path is verified and repo credentials are removed).

### Storage

Live definitions reside in a tenant-local `fleet-config` repository on the existing GCS/Firestore Git
substrate (`corekit/lib/git-store.mjs`), preserving C-2 zero-shared-infrastructure and giving immutable
content history without a runtime GitHub dependency. Firestore holds transactional metadata and active
pointers — `fleet_changes`, `fleet_releases`, `fleet_evaluations`, `fleet_assignments`, `fleet_rollouts`,
`platform_findings` — not unversioned blobs as the only history.

The bundled catalog in the repository is authoritative **only for initial import at bootstrap**. After
that it is seed content.

### Runtime

The runtime consumes one deterministic, immutable compiled bundle — the **Effective Agent Spec** — rather
than independently reading overlapping role, manifest, SOUL, skill and local-config authorities.
Composition is pure and ordered:

```text
foundation firmware
  + active deployment defaults
  + role definition
  + project overlay
  + agent overlay
  = effective bundle + digest
```

Every mission is stamped with `platformVersion`, `fleetRelease` and `agentSpecDigest`, so behavior can be
attributed and replayed.

### What this costs

- A tri-source role authority (`corekit/config/agent-types.json` + `specialties/*/kit.json` +
  `infra/manifests/job-*.txt`) collapses into one canonical Role definition with generated transitional
  manifests.
- `assemble-persona`'s in-place appends and `upgrade-corekit`'s custom-skill block are replaced by an
  independent content-sync service.
- Deployed Prime loses `github-pr` and `git-ops`.
- The dashboard stops reading catalogs from GitHub `main`.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Keep the four-layer taxonomy as the mutability boundary | Conflates semantic kind with governance; freezes role-specific dispositions alongside base cognitive firmware |
| Give deployed Prime a repository push token and let it PR the generic repo | Deployment-specific learning becomes cross-deployment code churn; no separation of cadence, evidence, approval or rollback |
| Store fleet definitions only as mutable Firestore documents | No immutable history, no atomic activation pointer, no rollback predecessor, no content digest |
| Start with the `platform/` + `catalog/` folder move | Churn without separation. Enforce schemas, APIs, imports and permissions first; move files once dependency direction is enforced (scheduled for CLEANUP) |
| Add an "eyes"/authoring organ to Prime | Duplicates an existing organ's job and trips the C-28 organ soft-lock for no benefit; authoring is tools plus a skill, not a new organ |

## The promise, in one line

> **Foundation releases control the machinery. Fleet releases control the deployed society. Runtime
> state records what that society does. Prime evolves the society; maintainers evolve the machinery.**
