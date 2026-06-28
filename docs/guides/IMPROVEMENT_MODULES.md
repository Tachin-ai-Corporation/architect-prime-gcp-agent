# Improvement Modules — Reference

This document defines the 9 modules of the Prime Self-Improvement System, their tier assignments, boundaries, owned files, and cross-module rules.

## Tier Model

Every improvement is either **REPO** (upstream-safe, benefits every fork) or **LOCAL** (operator-specific, stays in this deployment). A single change never mixes tiers — split it.

| Tier | Landing skill | Mechanism | When to use |
|------|--------------|-----------|-------------|
| **REPO** | `repo-improvement` | Contamination scan → branch → PR to `main` | Generic platform code, skills, SOULs, processes in `corekit/config/`, dashboard, infra |
| **LOCAL** | `local-improvement` | Firestore write or `operator/` overlay commit — **no PR** | Operator project context, core memory content, operator processes, deployment config |

**Default to LOCAL when unsure.** Never let an operator value reach a REPO-level change.

## Module Map — REPO Modules

| # | Module | Process | Tier | Landing Skill | Owns | Triggered By |
|---|--------|---------|------|---------------|------|--------------|
| 1 | Daemons | `p-improve-daemons` | REPO | `repo-improvement` | `corekit/daemon/`, `corekit/lib/`, `infra/contracts.json` (thresholds) | Crashes, stuck loops, MAX_ITERATIONS, ceremony divergence |
| 2 | Organ SOULs | `p-improve-souls` | REPO | `repo-improvement` | `brain/*/SOUL.md`, `brain/*/SOUL_APPEND.md`, `specialties/*/brain/*/SOUL*.md` | Bad decisions, plan inflation, false verdicts, wrong agent assignments |
| 3 | Neural Gateway | `p-improve-gateway` | REPO | `repo-improvement` | `corekit/brain/`, `infra/contracts.json` (model assignments, cache flags) | High token cost, low cache rate, loop guard issues, model errors |
| 4 | Skills | `p-improve-skills` | REPO | `repo-improvement` | `skills/*/SKILL.md`, `skills/*/skill.json`, `specialties/*/skills/` | Missing procedures, wrong syntax, low motor success rate, skill gaps |
| 5 | Dashboard & Bootstrap | `p-improve-dashboard` | REPO | `repo-improvement` | `app/src/`, `infra/bootstrap/`, `infra/manifests/` | Missing UI features, deployment friction, SSH-required debugging |
| 6 | Context & Memory Machinery | `p-improve-context-repo` | REPO | `repo-improvement` | `corekit/brain/context.mjs`, `corekit/lib/` memory helpers, consolidation logic, context schema | Context loading bugs, memory retrieval failures, schema gaps |
| 7 | Platform Processes | `p-improve-work-layer-repo` | REPO | `repo-improvement` | `corekit/config/processes/` (generic processes), process authoring standard | Missing platform processes, bad process steps, low coverage |

## Module Map — LOCAL Modules

| # | Module | Process | Tier | Landing Skill | Owns | Triggered By |
|---|--------|---------|------|---------------|------|--------------|
| 8 | Context & Memory Content | `p-improve-context-local` | LOCAL | `local-improvement` | Firestore `projects/`, `core_memory/`, `MEMORY.md` content | Stale/missing project context, wrong facts, memory recall failures |
| 9 | Operator Processes | `p-improve-work-layer-local` | LOCAL | `local-improvement` | `operator/processes/`, Firestore project processes (e.g. `p-web-*`, `p-publicfile-*`) | Operator process improvements, custom workflow gaps |

> **Note:** `p-improve-context-local` is the on-demand cousin of `p-memory-consolidate`. The scheduled nightly consolidation handles routine memory hygiene; `p-improve-context-local` handles targeted content corrections triggered by the operator or an improvement suggestion.

## Removed: Delegation

**Delegation is not a module.** It owns no artifacts — its fixes belong to the modules that own the relevant code:

| Delegation finding | Route to |
|---|---|
| Governance, guards, timeouts, cross-agent publish code | `p-improve-daemons` |
| Vague instruction quality | `p-improve-souls` |
| Delegation as a process step (generic) | `p-improve-work-layer-repo` |
| Delegation as a process step (operator workflow) | `p-improve-work-layer-local` |
| Operator-specific delegation pattern | `p-improve-context-local` |

## Entry Points

All improvements enter through one of two processes:

- **`p-triage-improvement`** — triggered by a fleet agent's `[IMPROVEMENT SUGGESTION]` delegation
- **`p-review-and-improve`** — triggered by the operator via dashboard chat

Both classify findings into the 9-module set and route to the matching `p-improve-*` process. REPO modules land via the `repo-improvement` skill (contamination scan → PR). LOCAL modules land via the `local-improvement` skill (Firestore/overlay, no PR).

## Cross-Module Rules

1. **One module per commit.** If an improvement touches files owned by multiple modules, create separate commits — one per module.
2. **One tier per change.** A single change is either REPO or LOCAL, never both. If a finding has both generic and operator-specific aspects, split it: generic skeleton via the REPO process, operator values via the LOCAL process.
3. **Contracts.json is shared.** Both Daemons (thresholds) and Gateway (model assignments, cache flags) own sections. Changes must not conflict — check the other module's section before editing.
4. **SOULs never contain tool syntax.** Tool syntax belongs in Skills. SOULs reference skills by name only (B-17).
5. **Processes never reference files by absolute path.** Use project context keys or relative repo paths.
6. **Every process declares `tier`.** Machine-readable — `"tier": "repo"` or `"tier": "local"`.
7. **REPO processes reference the `repo-improvement` skill; LOCAL processes reference the `local-improvement` skill.** The two paths share nothing.

## Protected Properties

Every improvement must confirm these are untouched:
- **Determinism** (B-1): Same input → same output
- **Crash-safety** (B-22): Daemon recovers from any crash without data loss
- **Observability** (B-23): Every decision is logged with evidence
- **Testability** (B-19): Every invariant has a test

## Improvement Axes

Each fix must claim which axis it advances:
- **Efficiency** — fewer tokens, faster completion, less waste
- **Structure** — logic in its right home, less duplication
- **Logic** — correct behavior, fewer bugs
- **Cleanness** — readable code, clear naming, minimal complexity
