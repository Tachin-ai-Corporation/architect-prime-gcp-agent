# Fleet Project Bootstrap — a PM/lead can stand up a delivery project from a chat ask

## Intent
Let the **product-architect / PM-lead** fleet role bootstrap a whole delivery project from a single
chat request, treating **the GChat space the ask arrived on as the project's comms space**. After
bootstrap the mission **auto-continues** into the actual work (draft → staging → prod) inside the
new, correctly-scoped project — no operator hand-holding beyond the one thing the fleet genuinely
cannot do (add bots to a Chat space).

## Why (the live incident)
An operator opened a "1health Web Team" space, @mentioned Archie, and asked him to set up a new
"1health Website" project and ship it. Archie stalled. Two distinct root causes:

1. **Chicken-and-egg on delivery.** Delegation is delivered *through the project's GChat space*
   (`delegate.mjs` looks up `PROJECTS[project_id].gchat_space_id`; no space → refuses to send).
   The bootstrap ask itself arrived on an unregistered space, so it fell back to the `general`
   project (`projects.mjs:364`), which has no space → the first delegation to Stan couldn't deliver.
2. **No path to "make this space the project's space."** Nothing surfaced the origin space as a
   settable value, and Archie's `project-ops` skill only covered internal "improvement projects."

Neither is a canon violation — project CRUD is already a fleet capability (`project-manage` +
`project-ops`), and **C-1** roots work at the project level with agents acting peer-to-peer. This is
an *extension* of an existing capability, not new authority.

## Decisions (operator-confirmed)
- **Delivery handoff = auto-continue.** After the project is registered, the daemon re-scopes the
  *same* mission from `general` to the new project and proceeds to plan + delegate the delivery, so
  delegations route through the origin space automatically.
- **Membership = verify + ask operator.** The delegate bots must be *members* of the space to
  receive delegations, but no fleet agent can add them (see boundary). The skill verifies membership
  (read scope) and, for any missing teammate, replies asking the operator to add them — it does not
  attempt to add members.

## The hard scope boundary (why membership is the operator's part)
`dwd-token` grants the fleet only `chat.messages` (prime) / `chat.spaces.readonly` (read) and
**explicitly denies** `chat.messages.create`, space-write, and any membership scope. There is **no
`chat.memberships` scope anywhere** and no `spaces.create` call in the codebase. Adding a bot to a
space is a Google Chat **admin** action, by design outside the fleet's authority. The operator's
natural setup act — create the space, add the team bots, @mention the PM — satisfies the
precondition; the skill's job is to *verify* it and escalate the gap, never to silently fail a
delegation.

## Grounding facts (verified in code)
- Intake **captures the origin space** onto every envelope: `metadata.space` → `source_meta.space`
  (`agent-ears.mjs:591`; read back by `addressFromMeta`, `agent-brain.mjs:216`).
- `project-manage` already does the registry work: `create / update / team-add / canon-set /
  add-context` (create writes any keys in its JSON, so `gchat_space_id` sets through). `drive-mkdir`
  (workspace-drive) creates the project's Drive folder; git-store makes a repo.
- The delegation block lives only in `delegate.mjs` — **bootstrap done as local writes (no
  `delegate` action) never trips it.**

## Layer discipline (C-28)
| Piece | Layer | Path |
|---|---|---|
| `project_bootstrap` **action** — deterministic: create `projects/{id}` keyed to the origin space, seed team/canon/context, membership preflight, **re-scope the current mission** | **Brain** | `corekit/daemon/actions/project_bootstrap.mjs` + router + schema |
| Origin-space resolver + "unregistered space" context line | **Brain** | `corekit/daemon/agent-brain.mjs`, `corekit/lib/` (pure helper) |
| *When/how* to bootstrap, the spec shape, the membership-precondition procedure, idempotency | **Skill** | `specialties/product-architect/skills/project-ops/SKILL.md` |
| "Bootstrapping a project from a chat ask is in-remit; you cannot add bots to a space — verify + ask; never route new work through a foreign project's space" | **Organ** | product-architect cortex/prefrontal `SOUL_APPEND.md` (ORGAN_LOCK re-pin) |
| Feature flag + `general`-fallback messaging | **contracts + brain** | `infra/contracts.json` |
| Adding bots to the space | **Operator** | out of fleet scope |

## Architecture — `project_bootstrap` as a cortex action
Cortex already chooses among structured actions (`checkpoint_plan`, `delegate`, `follow_process`,
`approval_gate`, …). Add **`project_bootstrap`**. The LLM emits a structured project spec (C-5); the
deterministic handler does the Firestore writes and the envelope re-scope (C-4) — the LLM never
hand-writes an opaque space id or rewrites its own envelope.

Decision payload (validated by schema):
```jsonc
{
  "action": "project_bootstrap",
  "project": {
    "id": "1health-website",              // daemon slugifies/validates; falls back to derive-from-name
    "name": "1health Website",
    "description": "...",
    "goal": "...",
    "team": [                              // roles the ask named; emails resolved from the fleet roster
      {"role":"lead","specialty":"product-architect","responsibilities":"PM: plan + delegate + report"},
      {"role":"engineer","specialty":"engineer","responsibilities":"page code + commits"},
      {"role":"devops","specialty":"devops","responsibilities":"GCP + staging/prod deploy"},
      {"role":"designer","specialty":"designer","responsibilities":"design drafts"}
    ],
    "canon":   [{"key":"deploy-flow","text":"draft → staging (url) → approval → prod"}],
    "context": [{"key":"source","kind":"drive","ref":"1OJ...","summary":"1health landing HTML"}]
  }
}
```
Handler steps (all deterministic):
1. **Idempotency (C-18):** if a project already exists with `gchat_space_id == this mission's origin
   space`, adopt it (no recreate); else validate/derive the id and ensure it's unused.
2. **Resolve teammate emails** from the fleet roster by specialty (reuse the baton `resolveAssignee`
   roster logic — never trust a model-written email).
3. **Write `projects/{id}`** with `gchat_space_id` = the mission's origin space + team + canon +
   context + `owner` = the PM. `drive-mkdir` the project folder; record it in context.
4. **Membership preflight** (read): list the space's members; for any required teammate not present,
   `needs_input` → post in-space "add `<email>` to this space so I can delegate to them," and stop
   (do not proceed to a delegation that would silently fail).
5. **Re-scope (the auto-continue):** set `envelope.project_id = <new id>`; log
   `[TELEMETRY] project_bootstrapped mission=… project=… space=…`. Return so cortex plans the
   delivery — now every delegation routes through the origin space.

Because the re-scope keeps it **one flat mission** (bootstrap step, then delivery checkpoints), this
never nests a mission (**C-15**) and never leaves `project_id` null.

## Bootstrap → delivery lifecycle (auto-continue walkthrough)
```
operator @PM "set up project X … ship to prod"   (space spaces/XYZ, unregistered)
  → intake: envelope {project_id: general (fallback), source_meta.space: spaces/XYZ, owner: PM}
  → cortex: action = project_bootstrap
      → handler: create projects/x (gchat_space_id=spaces/XYZ) + team + canon + ctx + drive folder
      → membership preflight: all bots in space?  no → ask operator, pause;  yes ↓
      → envelope.project_id = x   (re-scope)
  → cortex: now plans delivery (draft→staging→prod) IN project x
      → delegate edit→engineer / deploy→devops  — routes through spaces/XYZ  ✓
```

## Phases
- **P1 — Origin-space primitive (brain).** Pure resolver `missionOriginSpace(envelope)`; a context
  line when a mission is on an unregistered space; unit-tested.
- **P2 — `project_bootstrap` action (brain).** Handler + schema + router entry + roster email
  resolution + idempotency + membership preflight + re-scope + telemetry. Flag-gated
  (`dispatch.project_bootstrap.enabled`, default off) for a clean canary.
- **P3 — `project-ops` skill (skill).** "Bootstrap a delivery project" procedure: the origin-space
  rule, the spec shape, the membership precondition + escalation wording, idempotency, and the
  "never route through a foreign project's space" rule. Keep it role-generic (installs to any
  PM/lead specialty).
- **P4 — SOUL nudge (organ).** product-architect cortex/prefrontal append (ORGAN_LOCK re-pin,
  `organ-change: intended`): bootstrapping is in-remit; the membership boundary; the foreign-space
  prohibition (kills the earlier "route through tachin-web" hack).
- **P5 — Guards.** Idempotent re-run; `general`-fallback emits a clear "this space isn't linked to a
  project" line; slug/id validation; `project_id` never null (C-15); adopt-existing on space match.
- **P6 — Verify + canary.** Unit tests (origin-space resolver, id/slug, roster resolution,
  membership-preflight decision, re-scope). Live canary: bootstrap `1health-website` from the real
  space via Archie → confirm registry + space link + team + canon + Drive folder → membership
  preflight → auto-continue into draft→staging→prod (with the baton fixes already shipped).
- **P7 — Docs/manifest/contracts/context.** Manifest entries (C-9), contracts flag + comment,
  `.agents/rules` + memory, this plan doc.

## Canon mapping
C-1 (bootstrap *populates* the Project primitive; peer-to-peer, project-rooted) · C-4/C-5 (LLM emits
the spec, the daemon does deterministic writes + re-scope) · C-7 (flag/config in contracts) · C-15
(one flat mission, `project_id` never null) · C-18 (idempotent) · C-27 (all comms via the mouth) ·
C-28 / MODULE_CHARTER (action=deterministic brain, skill=procedure, organ=stance, Project=the area).

## Open follow-up (deferred, not in scope now)
Full membership automation (a `chat.memberships` DWD scope + an add-member tool so the PM adds bots
itself) — a separate infra change gated on Workspace-admin consent and a widening of fleet Chat
authority. Until then, membership stays the operator's setup act with verify-and-ask.
