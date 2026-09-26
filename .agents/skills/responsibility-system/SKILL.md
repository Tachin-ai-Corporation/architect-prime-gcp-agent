---
name: responsibility-system
description: "Responsibilities: shipped defaults (platform upkeep, locked; role defaults) merged with each agent's own store in Firestore by platform/work/responsibility-store.mjs; scheduled by platform/work/scheduler.mjs; authored with responsibility-manage (agent / Prime --agent / dashboard) — no release, no upgrade."
---
# Responsibility System (LIVE)

## Overview
Responsibilities are recurring duties, cron-scheduled or event-triggered. When one fires, the Brain daemon's scheduler creates an R→M (Responsibility→Mission) envelope pair.

## Where a responsibility comes from — three layers, one writer each
| Layer | Where | Written by |
|---|---|---|
| Platform upkeep | `corekit/config/responsibilities.json` (+ `-prime.json`), `locked: true` | the repo + a platform release only (C-30) |
| Role defaults | `corekit/responsibilities-*.json` (`specialties/<role>/responsibilities-<role>.json` → `responsibilities-job.json`, or rendered by content-sync from a Fleet release) | the repo, or Prime via `fleet-config` releases |
| The agent's own | Firestore `primes/{prime}/fleet/{agent}/responsibilities/{id}` (+ `/revisions/{n}`); a Prime's at `primes/{prime}/responsibilities` | `responsibility-manage` — the agent itself, Prime with `--agent <id>`, the dashboard's `set_responsibility_enabled` |

`platform/work/responsibility-store.mjs` is the ONE place the rule lives. The scheduler, `agent-introspect` and the CLI all merge and validate through it:
- Store docs are `mode: 'override'` (a `patch` on a shipped id; `context` merges key by key) or `mode: 'own'` (a full `body`; an own doc with a shipped id = adopted).
- `status: 'removed'` is a tombstone. Every write is a new `revision`, committed atomically with a copy in `revisions/{n}` and a CAS precondition (`StoreConflict` on a race).
- A locked shipped responsibility ignores every store record. An invalid, orphaned or unknown-mode record is logged and skipped, and the shipped default keeps running.
- Validation reuses `RESPONSIBILITY_SCHEMA` (minus the provenance envelope), plus:
  - the cron forms the matcher actually implements (`*`, `*/N`, `n`, `a-b`, lists — no names, no `7`, no stepped ranges);
  - a real IANA zone;
  - a frequency floor on author-written schedules;
  - an override checks only the fields it sets plus the cross-field rules, so a template `YOUR_PROJECT_ID` can't block a toggle.
- Policy is `contracts.responsibility_store` (from `infra/fleet-policy.json`): `refresh_ms` 60000, `min_interval_minutes` 15, `max_per_agent` 25.

## The scheduler (`platform/work/scheduler.mjs`)
- `loadResponsibilities()` reads the shipped files (base first, then every `responsibilities-*.json`, first-seen-wins) and re-applies the last good store.
- `refreshStore()` re-reads the store (dep `loadStore`, a strict query) every `refresh_ms`, from `tick()` and forced at `start()`. An outage keeps the last good set.
- `applyEffective()` re-arms ONLY responsibilities whose `enabled|schedule|timezone` changed, so a slot that came due before the next tick is never dropped by a reload.
- `start()` always starts the 60 s loop, even with nothing shipped, because an agent can create its first responsibility at runtime.
- `fireEvent()` fires from the effective set, spaced by `max(min_spacing_minutes, min_interval_minutes)`. It never chains: a mission with `source_meta.fired_by_event` fires no event responsibility, and no responsibility fires from its own mission.
- Fired R/M `source_meta` carry `responsibility_origin` (`shipped` | `override` | `agent`) and `responsibility_revision` (C-32).
- Zones: cron is matched in each responsibility's IANA `timezone`. The next fire is looked up 8 days ahead; a longer cadence is re-armed hourly as it comes into range.

## Tooling
- `responsibility-manage` = bash launcher (`bin/`) → `corekit/brain/responsibility-manage.mjs` (repo path == VM path).
  - Verbs: `list`, `show`, `create`, `update`, `toggle`, `remove`, `reset`, `adopt`, `history`, `revert --to`.
  - Flags: `--agent` (Prime only for other agents), `--note`, `--json`, `--stdin`/`--file`.
  - Identity: `AGENT_ID` env, then metadata `agent_id`, then the `fleet-<id>` hostname. An SSH shell writes the right agent's store (unlike `core-memory-*`).
- The brain's file watcher still hot-reloads installed files (upgrade / content-sync).
- NOTHING writes an installed responsibility file in place any more (C-36). `tests/responsibility-store.test.mjs` pins it.

## Gotchas
- Moving a deployment-specific responsibility out of a specialty file: `adopt` it on the agent FIRST (the store copy becomes authoritative), then remove it from the repo. Removing first leaves a gap until someone recreates it.
- A manual run counts toward `min_spacing_minutes`. Don't test a weekly job with 24 h spacing inside the 24 h before its slot.
- `responsibility_state/{respId}` (learnings overlay) is PRIME-scoped, not agent-scoped. It is separate from the store.

Reference: `docs/primitives/06-RESPONSIBILITY.md`, `docs/guides/AUTHORING_RESPONSIBILITIES.md`.
