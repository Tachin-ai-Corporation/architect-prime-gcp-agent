# Delegation as Intra-Mission Checkpoint Hand-off (the "baton" model)

## Problem

Today a delegation spawns a **separate child mission** on the delegate
(`agent-brain.mjs materializeDelegationMission` → a new `work/{id}`, `owner=delegate`,
linked to the delegator only through `source_meta.delegation_ref`). Only a summarized
result travels back. Every delegation-orchestration bug this produced —
result-misattribution, re-delegation loops, the delegate over-planning a context-poor
mini-mission, leaked scratch, lossy hand-back — descends from that one fact: **context
does not travel; a fresh, thin child mission is born and a lossy summary returns.**

## Direction

**Delegation = assign checkpoint(s) of ONE mission to a teammate + pass the baton.**
The mission doc is the shared context substrate: its Firestore state (`_cp_spine`,
`_cp_progress`, accumulated context, ledgers) **and** its `mission/<id>` git branch travel
agent→agent. The delegate works the same `work/{id}`, executes its assigned checkpoints,
and hands the same mission back. Context and work product travel natively.

## Why this fits the canon (it is *more* aligned than today's model)

- **C-15 (R→M→C→T, missions never nest):** one mission, no child — today's child-mission
  is the nesting smell. The baton is the canonical ideal.
- **C-5 (daemons move the data):** the hand-off is a daemon field-write, not an agent message.
- **C-24 (git is the artifact substrate; objects-before-refs):** the baton is *sequential*,
  so each agent clones `mission/<id>` (prior agent's commits included), works, pushes
  (ref-CAS-safe). The work product travels with no special machinery.
- **C-4 / B-1 (deterministic machine consults intelligence):** routing/lease/reclaim are
  deterministic; the organs still decide the work.
- **B-4 (context economy):** no lossy re-summarize across a round-trip.
- **B-28 (verification is re-derivation):** each checkpoint is verified on the shared
  artifact; there is no separate delegation-result to misread.
- **C-28 (layer purity):** brain owns the baton mechanics; skill owns how a checkpoint is
  assigned and how the plan tags an assignee; organs are untouched.

Delegation stays one of the nine CoW primitives (C-14) — its **mechanics** are redefined,
which is a canon amendment (MODULE_CHARTER / CULTURE_OF_WORK / delegation skill), not a new
primitive.

## What the codebase makes easy (grounding)

- `work` is **deployment-rooted** — one shared top-level collection every daemon reads
  (`agent-brain.mjs:839`). A hand-off is "change who it routes to," not a data migration.
- Routing is a single owner-localpart filter in `dequeueAndProcess` (`agent-brain.mjs:5008`).
- The spine is **inline on the mission doc**, per-checkpoint `{n, outcome, accept_criteria,
  tasks, status, criteria_revisions}` (`checkpoint-spine.mjs:28`) — **no assignee yet**; adding
  one is additive.
- The git working tree is `mission/<id>` in the shared store (`artifacts.mjs:272`); baton =
  sequential access → the branch carries the work product across agents.

## Data model (on the mission `work/{id}` envelope)

- `originator` — the agent that started the mission (stable identity). Shim: `originator ?? owner`.
- `assignee` — the agent whose turn it is (routing key). Shim: `assignee ?? owner`.
- `_cp_spine[n].assignee` — which agent owns checkpoint n (email); default = originator.
- `_baton` — `{ turn, from, to, lease_expiry, handed_at }` for hand-off tracking + reclaim.
- `owner` is kept (= originator) for back-compat so nothing downstream breaks.

## Phases (each layer-pure per C-28; all flag-gated by `dispatch.delegation.model`)

- **Phase 0 — Govern & design.** This doc + the data model + `contracts.dispatch.delegation`
  (model flag default `child-mission`, lease/turn/reclaim keys). Amend the delegation
  primitive definition in the canon docs + delegation skill.
- **Phase 1 — Ownership split (brain, invisible).** `effectiveAssignee`/`missionOriginator`
  shims; `dequeueAndProcess` routes by `effectiveAssignee`. No behavior change while
  `assignee == owner`. Ship + prove zero regression first.
- **Phase 2 — Checkpoint assignee (skill + brain).** `buildSpine` carries `assignee`;
  `plan-structuring` tags a cross-specialty checkpoint with the teammate (from the project
  team roster) instead of a `type:delegation` task.
- **Phase 3 — Baton mechanism (brain, the core).** In the executor loop, when the next
  checkpoint's `assignee ≠ me`: commit+push `mission/<id>`, field-masked write
  `{assignee, status:queued, _baton{turn++, lease_expiry}}`, stop. The new assignee dequeues,
  re-clones, resumes the same spine at the first incomplete checkpoint, hands back the same
  way. Lease-expiry + reclaim (sweep) returns a dead assignee's mission to the originator or
  escalates `needs_input`. All decision logic is pure in `corekit/lib/baton.mjs`; the daemon
  wiring is thin (call the pure fn, do a disjoint field-masked write, return).
- **Phase 4 — Attribution.** Spine + step-ledger carry per-entry `agent`; dashboard shows
  per-checkpoint assignee and lists a mission for every agent that worked any checkpoint;
  telemetry/recall attribute by checkpoint assignee, not `owner`.
- **Phase 5 — Canary & migrate.** Flag off by default; child-mission path stays until proven.
  Canary the tachin-web edit→staging→prod as ONE mission (archie originator; CP1→engineer,
  deploy→devops), prove baton both ways + no loop. Then flip fleet-wide, retire child-mission.

## Concurrency correctness

The baton is **sequential by construction** — only the current assignee's daemon dequeues the
mission (owner/assignee filter + the single in-memory active slot). The hand-off is one writer
flipping `{assignee,status,_baton}` via a **disjoint field-masked write** (`firestoreWriteFields`,
the existing no-clobber tool), after which that agent stops touching the doc. The shared
`mission/<id>` branch is pushed sequentially (git-store ref-CAS). No true doc-level CAS is
required; the lease + reclaim covers a dead assignee. This subsumes the earlier D1–D4 re-delegation
loop-fix plan — there is no cross-mission round-trip left to loop on.

## Verification & discipline

Pure state-machine unit tests for `baton.mjs` (B-19); `validate-contracts` green with new
`dispatch.delegation.*` keys (C-7); skill vs brain in separate commits (C-23); file + manifest
together (C-9); no organ SOUL edits. Canary before any fleet-wide flip; instant revert = flip the
flag off.
