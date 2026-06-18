# Implementation Plan — MCP Integration for the Skill Layer

> **Repo location:** `docs/plans/MCP_INTEGRATION_PLAN.md`
> **Ownership:** Human maintainers via CODEOWNERS. The Product Architect ranks; the Engineer cell implements the generator and client; Security gates external consumption; QA verifies.
> **Relationship to canon:** This plan makes the skill layer speak the Model Context Protocol so that (a) agents can consume the external MCP tool ecosystem under governance, and (b) core skills can be **published** as standalone MCP servers — the seed of a universal, interoperable skill library. It preserves every governing invariant: skills remain the single source of truth (B-16), the daemon keeps the loop (C-4, C-5), capability fencing stays structural (C-21), and no secret or phone-home path is opened (C-2, C-8). MCP is adopted as a **tool transport and packaging standard**, never as an orchestrator.

---

## Objective

Express skills in MCP without making MCP the authority over skills. A skill remains a versioned repository artifact — `skill.json` + `SKILL.md` + its scripts — and gains an MCP face that is **generated from that artifact**, so there is exactly one definition and no drift. The same generation runs in two directions: outward (publish a skill as a runnable MCP server other systems can call) and inward (let organs invoke skill tools as typed MCP tool calls, and consume approved external MCP servers).

This directly serves the improvement thesis: skills are the success bottleneck and the easiest layer to expand; making them MCP-native makes every improvement portable and the public library interoperable from day one.

---

## Invariants & Constraints

- **Skills are the single source of truth (B-16).** MCP tool definitions are *generated* from `skill.json`; they are never authored separately. A tool that exists in MCP but not in a skill is a violation.
- **The daemon owns the loop (C-4, C-5, B-1).** MCP supplies tools, never control flow. No external server may drive envelope transitions, classification, or synthesis.
- **The daemon boundary holds (B-16).** Daemon-internal tools never become MCP tools. Only skill-governed capabilities surface, and only to the organ whose `agent_part` is granted them.
- **Capability fencing is structural (C-21).** What an organ can call is enforced by `agent_part` + IAM + manifest layering, not by persona text or by trusting an MCP server's advertised tool list.
- **Zero shared infrastructure, no phone-home (C-2).** Consuming an external MCP server is an egress to a non-tenant endpoint and is therefore gated: allowlist, explicit operator approval, in-tenant preference, per-server identity.
- **No secrets in git, on disk, or in Firestore (C-8).** MCP server credentials are minted at runtime via DWD/ADC or read from the Secret Store; never embedded in a manifest or skill.
- **Six modules, one home (C-10).** MCP runtime code lives in `corekit/lib/`; published server packaging lives under `skills/`. No seventh module.
- **Contracts decide (C-7); observability ships with behavior (C-20, B-23).**

---

## Current State (what is)

- A skill is `skills/<id>/skill.json` (`id`, `name`, `version`, `agent_part`, `scripts[]`, `when_to_use`, `origin`, `category`) plus `SKILL.md` (procedure) plus its scripts on `PATH` (`/opt/corekit/bin/`).
- Organs reach capabilities through a single shell surface: the gateway's `runCommand` tool (`corekit/brain/tools.mjs`), after reading the relevant `SKILL.md`. Tool *syntax* lives only in `SKILL.md`; tool *arguments* are described in prose, not declared as schemas.
- Discovery is runtime: `skills/skill-introspect` plus the catalog injected into execution organs by `buildSkillCatalogPrompt()` in `corekit/brain/loop.mjs`.
- There is no typed contract for a script's inputs, and no way for an external client to call a skill, nor for an organ to call an external MCP tool.

---

## Target State (what becomes)

- Every core skill declares **typed tool schemas** in `skill.json`; `SKILL.md` keeps the cognition/procedure, the schema carries the machine contract.
- A generator turns any skill into an **MCP server** whose tools are the skill's scripts, executed by invoking the existing scripts (no reimplementation). The same skill therefore has one definition and one execution path, exposed two ways: as `runCommand` syntax (legacy/fallback) and as MCP tools.
- The brain is an **MCP client**: organs invoke skill tools as typed MCP calls, fenced by `agent_part` and IAM. `runCommand` remains for skills not yet schema-lifted and for free-form shell.
- Approved **external MCP servers** are consumable under governance, expanding agent capability without bespoke scripts.
- Selected core skills are **published** as standalone MCP servers — the public library seed — versioned in lockstep with `skill.json`.

---

## Checkpoints

Checkpoints execute sequentially; each closes on accept criteria + QA verification (B-13). Findings are severity-ranked Critical / Major / Minor.

### CP1 — Tool schema lift
**Goal.** Give every core skill's scripts a declared, typed input contract — the prerequisite for any MCP exposure — without disturbing `SKILL.md` or the scripts.

**Changes.**
- Extend the skill schema with a `tools` block: for each script, `{ name, description, input_schema (JSON Schema), output_hint }`. `scripts[]` remains; `tools[]` is the typed superset.
- Lift the argument conventions currently described in prose in each core `SKILL.md` into `input_schema` (start with `web-search`, `workspace-gmail`, `workspace-drive`, `workspace-docs`, `workspace-sheets`, `workspace-calendar`, `workspace-slides`, `workspace-chat`).
- Extend `corekit/system/validate-contracts` (and the skill validator) to enforce: every entry in `scripts[]` has a matching `tools[]` schema; every `tools[]` entry maps to a real script on disk; one authoritative template (closes the multi-template drift concern).

**Accept criteria.** Every listed core skill has a complete `tools[]` block; the validator fails closed on a script/schema mismatch; `SKILL.md` procedure is unchanged.

### CP2 — MCP server generator (CoreKit lib)
**Goal.** Generate a conformant MCP server from a skill directory, reusing the skill's scripts as the execution path.

**Changes.**
- Add `corekit/lib/mcp-server.mjs`: reads a skill directory, registers each `tools[]` entry as an MCP tool, and on invocation executes the corresponding script with the validated arguments. Supports stdio transport (local, per-VM) and HTTP/SSE (remote, for publication).
- Respect `agent_part`: a generated server exposes only the tools of skills granted to the requesting organ; the grant set is computed from manifests/IAM, never from the request.
- Reuse existing auth edges (`corekit/lib/dwd-auth.mjs`, `gce-auth.mjs`) for tools that need Workspace/GCP tokens — minted at call time, never persisted (C-8).

**Accept criteria.** A core skill runs as an MCP server locally; an MCP client lists and calls its tools; a tool call produces the same result as the equivalent `runCommand` invocation; tools outside the caller's `agent_part` are not listed and not callable.

### CP3 — Brain as MCP client (additive)
**Goal.** Let organs call skill tools as typed MCP calls, alongside the existing shell surface.

**Changes.**
- Add an MCP client path consumed by the gateway/daemon so a dispatched organ can call a skill tool by name with typed arguments, routed through the generated server.
- Evolve the catalog injection (`buildSkillCatalogPrompt()` in `corekit/brain/loop.mjs`) and `skill-introspect` to advertise MCP tools and their schemas; the instruction to read `SKILL.md` before first use is preserved.
- Enforce the daemon boundary in code: daemon-internal tools are never registered with the MCP client; only skill-governed tools are reachable (B-16).
- `runCommand` remains the fallback for un-lifted skills and free-form shell.

**Accept criteria.** Motor executes a schema-lifted skill via MCP; the call is fenced to its `agent_part`; daemon-internal tools never appear in any organ's MCP tool list; `runCommand` continues to work for un-lifted skills.

### CP4 — External MCP consumption under governance
**Goal.** Make the external MCP ecosystem usable without violating sovereignty or secret invariants.

**Changes.**
- Add an `mcp` allowlist to `infra/contracts.json`: approved external server endpoints, each with required auth source (Secret Store reference or DWD scope), transport, and per-server timeout. Anything not on the allowlist is blocked.
- Route external credentials through the Secret Store / DWD only; no key ever lands in a manifest, skill, or Firestore (C-8). Each external server is reached under a scoped identity (C-21).
- Security cell owns the approval gate for adding an endpoint; Infra cell change requires a human merge gate (consistent with the permanent human gate on infrastructure).
- Emit telemetry on every external MCP call (server, tool, outcome) (C-20).

**Accept criteria.** An approved external server is callable under scoped auth with full telemetry; an unapproved endpoint is refused deterministically; no credential is observable in git, disk, Firestore, or any transcript.

### CP5 — Publish core skills as MCP servers (public-library seed)
**Goal.** Package selected core skills as standalone, runnable MCP servers other systems can consume — the first interoperable slice of the universal library.

**Changes.**
- Under `skills/<id>/`, add an MCP publication manifest (entrypoint, transport, declared tools, version mirroring `skill.json.version`).
- Provide a `skill-introspect`-style discovery document so an external client can enumerate published skills and their tool schemas.
- Define the publication boundary: only skills with `origin: core` and a passing CP1 schema are publishable; specialty skills follow once their schemas are lifted.

**Accept criteria.** At least one core skill is published as a standalone MCP server consumable by an external MCP client; its version matches `skill.json`; specialty skills remain unpublished until lifted.

### CP6 — Contracts, validation, observability
**Goal.** Make MCP behavior configurable, validated at bootstrap, and self-evident in telemetry.

**Changes.**
- Finalize the `mcp` contract block: transports, loopback/ports for generated servers, allowlist (CP4), timeouts, publication settings. `validate-contracts` enforces it (C-19).
- Achieve telemetry parity with the existing tool path: MCP tool calls write through `corekit/brain/brain-telemetry-write` with the same `what / which envelope / what outcome` shape (B-23).
- Confirm capability fencing end to end: a test asserts that an organ cannot call a tool outside its `agent_part` even when the MCP server technically advertises it.

**Accept criteria.** No MCP tunable is hardcoded (C-7); `validate-contracts` fails closed on an invalid `mcp` block; MCP and `runCommand` tool calls are equally observable; the fencing assertion passes.

---

## Risks & Mitigations

| Severity | Risk | Mitigation |
|---|---|---|
| Critical | An external MCP server becomes a phone-home / data-exfiltration path | Allowlist-only egress (CP4); scoped per-server identity; full call telemetry; Security-owned approval gate; in-tenant preference |
| Critical | MCP drifts into orchestration (server logic driving control flow) | Hard rule: MCP supplies tools only; the daemon owns every transition (C-4, C-5); no envelope state is ever written by an MCP call |
| Major | Schema drifts from script behavior | Generator reuses the actual scripts as the execution path; validator checks schema↔script mapping (CP1); QA regression compares MCP and `runCommand` results |
| Major | A daemon-internal tool leaks into an MCP tool list | Code-level boundary in the client/generator (CP3); explicit fencing test (CP6) |
| Minor | Two surfaces (`runCommand` + MCP) confuse procedure authorship | `SKILL.md` remains the sole procedure; the schema is generated, not authored twice; un-lifted skills stay on `runCommand` until lifted |

---

## Rubric Impact (Brain Canon Part IV)

- **Structure (↑):** skills gain a typed, interoperable interface while remaining the single source of truth; tool code stays in `corekit/lib/`, packaging under `skills/` (C-10, B-18).
- **Cleanness (↑):** prose argument descriptions are replaced by declared schemas; one authoritative skill template enforced by the validator.
- **Logic (neutral→↑):** the capability surface becomes explicit and machine-checkable rather than prose-governed.
- **Protected properties:** determinism (the daemon still owns the loop), observability (telemetry parity), and testability (generator and fencing are unit-/integration-tested) are preserved.

---

## Out of Scope

- **A2A / roles-as-agent-cards.** Publishing *agent roles* for interoperability is the sibling track to publishing *skills*; it is a separate plan. This plan establishes the tool/skill standard; the role standard follows.
- **Replacing `runCommand` wholesale.** MCP is additive. `runCommand` remains for un-lifted skills and free-form shell.
- **Adopting an MCP-based orchestration framework.** MCP is a tool and packaging standard here; the orchestration spine remains hand-owned and host-native (C-12).
