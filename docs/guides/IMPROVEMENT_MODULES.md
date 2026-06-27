# Improvement Modules — Reference

This document defines the 8 modules of the Prime Self-Improvement System, their boundaries, owned files, and cross-module rules.

## Module Map

| # | Module | Process | Owns | Triggered By |
|---|--------|---------|------|--------------|
| 1 | Daemons | p-improve-daemons | `corekit/daemon/`, `corekit/lib/`, `infra/contracts.json` (thresholds) | Crashes, stuck loops, MAX_ITERATIONS, ceremony divergence |
| 2 | Organ SOULs | p-improve-souls | `brain/*/SOUL.md`, `brain/*/SOUL_APPEND.md`, `specialties/*/brain/*/SOUL*.md` | Bad decisions, plan inflation, false verdicts, wrong agent assignments |
| 3 | Context & Memory | p-improve-context | Firestore `projects/`, `core_memory/`, MEMORY.md | Stale/missing project context, memory recall failures, duplicate fact discovery |
| 4 | Neural Gateway | p-improve-gateway | `corekit/brain/`, `infra/contracts.json` (model assignments, cache flags) | High token cost, low cache rate, loop guard issues, model errors |
| 5 | Work Layer | p-improve-work-layer | Firestore `processes/`, `corekit/config/processes/` | Missing processes, bad process steps, low process coverage |
| 6 | Skills | p-improve-skills | `skills/*/SKILL.md`, `skills/*/skill.json`, `specialties/*/skills/` | Missing procedures, wrong syntax, low motor success rate, skill gaps |
| 7 | Dashboard & Bootstrap | p-improve-dashboard | `app/src/`, `infra/bootstrap/`, `infra/manifests/` | Missing UI features, deployment friction, SSH-required debugging |
| 8 | Delegation | p-improve-delegation | Cross-cutting: delegation instructions (SOULs), pre-delegation publish (daemon), delegation guards (executor) | Delegation storms, ENOENT cross-VM, vague instructions, timeout gaps |

## Entry Point

All improvements enter through **p-triage-improvement**, which:
1. Reads the improvement suggestion and referenced mission history
2. Classifies into one or more modules
3. Executes the corresponding `p-improve-*` process
4. Submits changes (PR for code, Firestore for data)
5. Reports results back

## Cross-Module Rules

1. **One module per commit.** If an improvement touches files owned by multiple modules, create separate commits — one per module.
2. **Delegation module is cross-cutting.** It may identify fixes that belong to Daemons (pre-delegation publish) or Organ SOULs (instruction quality). Route each fix to the correct module's process.
3. **Contracts.json is shared.** Both Daemons (thresholds) and Gateway (model assignments, cache flags) own sections. Changes must not conflict — check the other module's section before editing.
4. **SOULs never contain tool syntax.** Tool syntax belongs in Skills. SOULs reference skills by name only (B-17).
5. **Processes never reference files by absolute path.** Use project context keys or relative repo paths.

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
