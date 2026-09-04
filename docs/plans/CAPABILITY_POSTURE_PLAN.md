# Capability Posture — Prime `unbound`, Fleet `strict`

**Canon:** [C-37](../PRODUCT_CANON.md) · *Cognitive latitude is a posture; the spine and the fence are not.*

## Problem

A live operator task — delete a project entirely + wipe a fleet agent's memory — was solvable by the
repo maintainer (a strong model in a free exploratory loop) but would not have been reliably solvable by
the deployed Prime `candicejr`. The root cause was **not** access (the Prime SA can delete Firestore and
SSH fleet VMs), and **not** missing raw capability (motor has `shell`/`python3`/`gcloud`). It was:

1. **Planner/executor model split.** The Prime cortex is Opus, but its *execution* organs (motor,
   prefrontal, cerebellum) run on Gemini Flash. Bespoke, destructive, multi-step code lands on the
   weakest link.
2. **A pipeline optimised for structured delivery, not open-ended forensics.** The mission machine
   (classify → plan → dispatch → verify) is heavyweight for a probe→read→adjust investigation.
3. **Latitude gates and budgets tuned for autonomous fleet safety**, which throttle exploration.

The Prime is dashboard-only, reachable solely by an administrator (C-1), with a human in the loop — so
accepting more cognitive risk **there** to make it far more capable is a good trade. Fleet agents act
autonomously in shared channels and must stay strictly canon-bound.

## Principle (C-37)

The **deterministic spine** (the daemon, the R→M→C→T envelope machine, data movement — C-4/C-5/C-15) and
the **structural fence** (what an agent may touch — C-21/C-1/C-33/C-8/C-27) are **invariant** across every
agent. What varies is **cognitive latitude** — model tier, sampling, verification strictness, and budgets —
expressed as a named **posture** the *single* brain overlays onto its effective contract **by role**:

| | `strict` (fleet) | `unbound` (prime) |
|---|---|---|
| Execution model tier | Flash | strong (`subagentStrong`) for prefrontal/motor/cerebellum |
| Iteration / tool-call budgets | baseline | wider (room to explore + verify in one task) |
| Sampling | baseline | modestly warmer where creativity helps |
| Verification / honesty gates | full | full — **unchanged** |
| Capability fence, secrets, egress | full | full — **unchanged** |

`strict` is exactly today's behavior (an empty overlay). `unbound` widens cognition only. **One daemon,
one codebase**: the posture is resolved by role at startup and *overlaid onto the effective contract* — it
is never a second build and never a runtime branch on `role` inside the loop.

## What the posture MUST NOT touch

Non-negotiable, enforced by C-37 + C-21:

- The deterministic machine — state transitions, dedup, routing, scheduling, the envelope state machine.
- The capability walls — C-1 (workspace apps), C-34 (repo authorship), C-8 (secrets), C-33 (self-grant),
  C-27 (mouth is the sole fleet egress), C-33's mount-namespace blast-radius.
- The honesty/verification floor that prevents *false greens* (finalize-requires-spine-complete,
  evidence floor, blocked-requires-real-blocker). "More creative" must never mean "more likely to lie."

The unbound prime **thinks** more freely inside **exactly the same walls**.

## Implementation (single brain, config overlay)

1. **Pure core** — `platform/contracts/posture.mjs` (B-19): `agentPosture(contracts, {isPrime})` picks the
   posture name; `applyPosture(contracts, name)` returns a NEW contracts object with the named posture's
   overrides deep-merged onto the base. No I/O, no clock — fully unit-tested.
2. **Definition** — the `postures` block lives in `infra/fleet-policy.json` → compiled by
   `compile-contracts` into `contracts.json` (never hand-edited). `strict: {}` (no change); `unbound`
   carries the overrides (strong execution models + budget headroom).
3. **Overlay points (two, because the daemon and the gateway are separate processes):**
   - The brain daemon (`platform/runtime/agent-brain.mjs`) applies the overlay once at startup, right
     after the existing per-VM env-override block — so every `dispatch.*` read downstream sees the
     posture-adjusted contract.
   - The neural gateway (`corekit/brain/…`) applies the same overlay when it loads contracts, so model
     selection (`vertex.strong_model_agents` / `subagentStrong`) routes a prime's execution organs to the
     strong tier while fleet stays on Flash.
   - Role is determined the same way both already know it (a fleet agent has `AGENT_ID`; a prime does
     not) — no new identity plumbing.
4. **Escape hatch** — a per-VM `AGENT_POSTURE=strict|unbound` env override (mirrors the existing
   `AGENT_*` pattern) for canary / rollback without a redeploy.

## Rollout

Canary-first: enable `unbound` on one prime, verify strong-model routing in the gateway logs + a real
forensic mission, then flip the posture on fleet-wide (it only affects the 3 primes; fleet is untouched
by design). Cost/latency of the strong tier is bounded to the handful of admin-facing primes.

## Complements

- The two guarded destructive tools (`project-delete`, `fleet-agent-memory-reset`) are the *safe hands*
  for the empowered prime: unbound **cognition**, fenced **actions**, dry-run by default.
- The prime cortex SOUL already carries the resourceful-operator disposition (B-26) — the posture makes
  it *actionable* rather than aspirational.

## Follow-ups (not in the first increment)

- An `operator-forensics` skill codifying the probe→inspect→verify methodology (grep the code/schema that
  defines a thing before acting on it; write a dry-run probe; verify before applying).
- Reconcile the `ids.mjs` core-memory path (`agents/{id}/core_memory`, unused) with the deployed
  `primes/{prime}/fleet/{agent}/core_memory` — a documentation defect that misleads any agent consulting
  the "contract" for where memory lives.
- Widen additional latitude knobs (sampling, relaxed re-plan foreclosure) once the strong-model prime is
  observed in production.
