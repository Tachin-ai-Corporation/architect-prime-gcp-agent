# On-Demand Responsibility Triggers

> **Version:** 0.4
> **Status:** SHIPPED + PROVEN + ROLLED FLEET-WIDE (v2026.07.23.8.0–.12.0; 7/7 agents on v.12.0, brains healthy, all markers verified). The operator path is proven end-to-end and the agent path is wired + deployed. The two temporal-memory gaps this surface exposed were **fixed in-session** (v.11.0 process-runs-via-executeProcess + checkpoint `_exec`; v.12.0 singleton archived-terminal) — consolidation now fires on demand and **completes cleanly 9/9** (report written, MEMORY pruned, no block/churn), which is the temporal-memory behavioral proof that had been pending. `STABLE` moved to the finalize commit. Canary-surfaced bugs fixed along the way: `.9.0` collection rooting, `.10.0` singleton noOrderBy, `.12.0` singleton archived-terminal.
>
> **(historical 0.3)** SHIPPED + CANARY-VALIDATED on Millie (v2026.07.23.8.0–.10.0). **Operator path proven end-to-end:** a `responsibility_triggers` doc → brain claims it → `[TELEMETRY] responsibility_triggered id=r-memory-consolidation source=operator bypass_spacing=true` → the linked `p-memory-consolidate` process executes **via temporal-memory** (the exec path — no stall, unlike the 2026-07-23 nightly that blocked) → `consolidation_report.md` (3865 B) written, `MEMORY.md` pruned to ~871 B, mission does **not** block. Two canary-surfaced bugs fixed: **(.9.0)** `responsibility_triggers` added to `DEPLOYMENT_ROOTED` — the brain was querying `primes/{id}/responsibility_triggers` while the introspect daemon writes top-level; **(.10.0)** singleton guard query needs `{noOrderBy:true}` to avoid a missing composite index (was failing-open). Agent path (`trigger_responsibility`) is wired + deployed but not yet chat-smoke-tested. **Fleet-wide + STABLE: HELD** — see below.
>
> **Surfaced (separate — temporal-memory authority completion, not this surface):** the consolidation mission does not *cleanly* complete — after the process runs, cerebellum FAILs because the on-disk report isn't surfaced as verification evidence, and cortex's re-planned "gather Core Memory/Deep Truths" checkpoint tasks dispatch to temporal-memory **without exec tools** → the org can't retrieve → verify churn until force-terminate. Two follow-up fixes (report-as-evidence; exec on verification/checkpoint retrieval) tracked to finish [TEMPORAL_MEMORY_AUTHORITY_PLAN](TEMPORAL_MEMORY_AUTHORITY_PLAN.md). The trigger let us find this on demand instead of at 08:00 nightly — its intended value.
>
> **(historical) IMPLEMENTED —** code landed (v2026.07.23.8.0), deploy + canary validation pending. All six phases in the repo: `fireById` primitive (unit-tested, 9/9), the `trigger_responsibility` Cortex action, `triggerable`+`singleton` config, the operator poll + introspect enqueue + dashboard "Run now", manifest. Two silent-failure gates were traced and closed during build: (1) `buildUserBlocks` cherry-picks decide-payload fields into tiered blocks — `available_responsibilities`/guidance had to be forwarded into the cached `boot` block or Cortex would never see them; (2) the Cortex decide output is doubly action-gated — the structured-output **schema enum** and a **validator allowlist** in `vertex-text.mjs` both had to gain `trigger_responsibility` (plus a `responsibilityId` schema property) or the model literally could not emit it. Builds directly on [TEMPORAL_MEMORY_AUTHORITY_PLAN](TEMPORAL_MEMORY_AUTHORITY_PLAN.md) — the on-demand trigger is the surface that lets us fire the nightly consolidation *now* and finally prove that work end-to-end (its behavioral proof was "pending next nightly").
> **Ownership:** Human maintainers via CODEOWNERS.
> **Canon alignment:** Preserves **C-14/C-15** (responsibilities stay the R in R→M→C→T; missions never nest — a trigger creates a normal R→M cycle, exactly as cron does), **C-4/C-5** (deterministic mechanics in the daemon; LLM only *decides* to fire), **C-27** (mouth remains sole egress — the agent path ends in a normal synthesize→mouth confirmation), **C-28** (layer purity — see below), **B-1** (determinism). Telemetered (**C-20**), revertible (a responsibility is triggerable only when it opts in).

## Objective

Give responsibilities a **deliberate on-demand trigger** — a way to run one *out of turn*, not only on its cron `schedule`. Two initiation faces converge on one primitive:

1. **Agent-initiated** (the emphasized requirement): a user asks the agent in conversation to run a scheduled cycle now ("run the memory consolidation"). Cortex recognizes this and fires the responsibility via a new `trigger_responsibility` decision action.
2. **Operator-initiated:** a dashboard **"Run now"** control writes a trigger doc; the brain daemon polls it and fires.

Both call one shared primitive: **`scheduler.fireById(id, opts)`**.

## Verified foundations (code)

| Fact | Where | Consequence |
|---|---|---|
| Responsibilities fire only on cron `schedule`, or on an event `trigger` (`on_complete`/`on_deploy`/`on_failure`) | `corekit/lib/scheduler.mjs` — `start()` interval + `fireEvent()` | No on-demand path exists for a `schedule`-only responsibility like `r-memory-consolidation` |
| `fireResponsibility(resp)` is the reusable engine (builds R→M, runs the linked process or Cortex loop) but is **internal** — reachable only by the cron loop and `fireEvent` | `scheduler.mjs:210` | The engine is done; it just needs a deliberate entry point (`fireById`) |
| The scheduler's public API is `loadResponsibilities/start/stop/fireEvent/recalcNextFires/getResponsibilities/getNextFires` | `scheduler.mjs:625` | No `fireById` today |
| Cortex actions are table-dispatched: `ACTION_NAMES` + `ACTION_HANDLERS`, each handler `(ctx, deps) → {continue|exit, priorResultsAppend, activeGuard}` | `corekit/daemon/actions/index.mjs`; `agent-brain.mjs:3629` | Adding an agent-facing trigger = one new action handler, same shape as `follow_process` |
| The decide payload already injects `available_processes` so Cortex can pick `follow_process`; guidance lives in `dispatch_guidance` | `agent-brain.mjs:1399` | Same mechanism injects `available_responsibilities` — mechanism-awareness stays in **injected context, not SOUL** |
| Dashboard ↔ agent already has a request/response bridge (`introspect` subcollection) and a mutation hook; `ResponsibilityList` renders per-responsibility cards | `app/.../introspect/route.ts`; `app/src/components/agent/ResponsibilityList.tsx` | Operator "Run now" reuses the card + a small trigger route |
| Brain daemon runs a 3s `pollLoop` (intake, delegations, waiting, approvals) and filters agent-scoped work client-side by `owner` | `agent-brain.mjs:5084`, `dequeueAndProcess:4888` | A trigger-doc poll drops in beside `checkApprovedApprovals()`, same pattern |

## Gap this closes

A scheduled responsibility cannot be run on request. The nightly `r-memory-consolidation` can only prove itself at 08:00 UTC; an operator who wants it now has no control; and — the load-bearing one — **when a user asks the agent to run a cycle, the agent has no way to honor it**. The engine (`fireResponsibility`) already exists; only the deliberate entry points are missing.

## Architecture principle — right layer, one purpose (C-28)

- **Brain code (`corekit/`)** — the mechanics: `fireById` (the primitive); the `trigger_responsibility` action + handler; the `available_responsibilities` decide-context injection; the operator trigger-doc poll. Deterministic; the daemon moves the data (C-5).
- **Config (`corekit/config/responsibilities.json`)** — a per-responsibility **`triggerable`** opt-in (gates the agent path) and **`singleton`** (serializes cycles). Data, not logic.
- **App (`app/`)** — the operator-facing **"Run now"** control + a trigger route. The visible surface.
- **SOUL** — **untouched.** Whether the agent *may* trigger a responsibility is mechanism-awareness (which actions/responsibilities exist), delivered as injected decide context; it is not organ identity. No SOUL edit ⇒ no `ORGAN_LOCK` churn. Cortex's *judgment* (is the user actually asking me to run this?) is its native role.
- **Skills** — **none needed.** Triggering is a single Cortex decision (emit action + id), not a multi-step tool procedure. The fired responsibility's own skill/process (e.g. `memory-consolidate`) already carries the procedure that runs.

## The primitive — `scheduler.fireById(id, opts)`

```
fireById(id, { bypassSpacing = false, force = false, source = 'ondemand' })
  → not found / disabled (unless force)        → { ok:false, error }
  → singleton && a non-terminal cycle exists    → { ok:false, skipped:true, error }   // ALWAYS enforced
  → !bypassSpacing && within min_spacing         → { ok:false, skipped:true, error }
  → else: record lastFired, re-arm next cron fire, [TELEMETRY] responsibility_triggered,
          fireResponsibility(resp) fire-and-forget (mission runs in background), → { ok:true, id, name }
```

- **Singleton is always enforced** — never two concurrent consolidation cycles (memory corruption risk). On-demand callers **bypass min-spacing** (running "out of turn" is the whole point) but never the singleton guard.
- **Non-blocking:** `fireResponsibility` runs the whole mission; `fireById` dispatches it detached so neither the agent's decide loop nor the operator poll blocks for minutes. Callers observe the running mission via `source_meta.responsibility_id` (the same key the singleton guard queries).

## Phases

### P1 — Core primitive (`corekit/lib/scheduler.mjs`)
Add `fireById` (above) and export it. Reuses `fireResponsibility`, `_respLastFired`, `cronNextFire`, and the singleton query already used by `start()`.

### P2 — Agent path (`corekit/daemon/`)
- New `actions/trigger_responsibility.mjs`: validate `decision.responsibilityId` against the **triggerable** set; `fireResponsibilityById(id, {bypassSpacing:true, source:'agent'})`; on success push a system result + `activeGuard{forbidden:'trigger_responsibility', fallback:'synthesize'}` and set `envelope._responsibility_triggered` so Cortex delivers a brief confirmation via the normal synthesize→mouth path (C-27) and cannot re-fire.
- `actions/index.mjs`: export + add to `ACTION_NAMES`.
- `agent-brain.mjs`: import + register in `ACTION_HANDLERS`; add `fireResponsibilityById` + `getTriggerableResponsibilities` module wrappers and into `deps`; inject `available_responsibilities` + `responsibility_trigger_guidance` into the decide payload (beside `available_processes`); extend the invalid-action nudge when triggerable responsibilities exist.

### P3 — Config (`corekit/config/responsibilities.json`)
Add `"triggerable": true` and `"singleton": true` to `r-memory-consolidation` (the canary) and `r-git-gc` (both safe/idempotent). Absent ⇒ not agent-triggerable (safe default).

### P4 — Operator path
- `agent-brain.mjs`: `checkResponsibilityTriggers()` — query `responsibility_triggers` where `status==pending`, filter to this agent (`agent_id` ∈ {AGENT_ID, AGENT_EMAIL-prefix}), claim (status→`firing`), `fireResponsibilityById(..., {bypassSpacing, source:'operator'})`, write terminal status (`fired`/`skipped`/`error` + detail). Call it in `pollLoop`.
- `app/`: a trigger API route that writes the `responsibility_triggers` doc; a **"Run now"** button on `ResponsibilityCard`.

### P5 — Manifest / contracts
`infra/manifests/base.txt` += `corekit/daemon/actions/trigger_responsibility.mjs`. Note the `responsibility_triggers` collection name where control-collection names live.

### P6 — Verify + roll
Deploy canary (Millie). **Operator path:** write a trigger doc for `r-memory-consolidation` → brain log shows `responsibility_triggered` + the consolidation mission runs to **complete** with the report artifact (this is also the pending behavioral proof for the temporal-memory authority work). **Agent path:** a chat "run the memory consolidation now" → Cortex emits `trigger_responsibility` → fires. Fleet-wide after a clean pass; then move `STABLE`.

## Rollout & measurement
Each phase: implement → version-prefixed commit → canary Millie → verify → fleet-wide. Acceptance: an operator and the agent can each start `r-memory-consolidation` on demand; it completes (not blocks) with a report; singleton prevents overlap; non-triggerable responsibilities are unreachable from the agent path. Reverts by clearing the `triggerable` flags.
