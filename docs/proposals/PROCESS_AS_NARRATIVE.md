# RFC: Processes as Narratives — dissolve the step-machine into a remembered playbook

**Status:** IMPLEMENTED — shipped + proven fleet-wide (8/8 VMs, 2026-08-14). **Supersedes** `PROCESS_MODEL_REDESIGN.md` (removed). This document is retained as the design record of the migration.
**Date:** 2026-08-14
**Trigger:** processes are over-defined step-machines, and that rigidity *is* the bug class. Operator
direction: water a process down to a **NAME + SHORT DESCRIPTION + PROCESS NARRATIVE** — "like a
skill, except instead of teaching how to use tools, a contextual narrative relating to prime-projects
that the agent uses to *remember* or *share* what works." Goals: agents keep **maximum iterative
control** over their own checkpoints/tasks; capture **core patterns that worked**; and let agents
**update/upgrade** those patterns and **discuss + take feedback** from the user.

**Extended scope (operator, mid-review):** every agent can create/edit **both processes and
prime-projects** (not just a PM/architect), and a **temporal-memory skill + personality automatically
maintains the context** of any process or project a recent mission actually used — see §6b.

---

## 1. Why this supersedes the last RFC

The previous RFC proposed to *validate + reconcile the step schema*. That treats the symptom. The
root cause is that a process is an **executable step-machine at all**: each step carries an agent, a
type, a checkpoint boundary, accept-criteria, an approval gate — so a step can name an illegal agent
(the `p-web-content` block), drift from the repo, orphan in Firestore, or fight the agent's own
planning. **Dissolve the machine and the entire class is gone**: a narrative has no steps to be
invalid, no agent to reject, no schema to drift.

And it serves the real goal directly. The agent should *own* its checkpoints; a template that
pre-bakes the steps is the opposite of iterative control. Today the brain even injects *"Prefer
follow_process over checkpoint_plan"* (agent-brain.mjs:1601) — literally biasing the agent away from
its own planning. That inverts once processes stop being programs.

> **The thesis:** a process stops being a program the daemon *executes* and becomes a narrative the
> agent *consults*. Name + short description + narrative. Nothing else.

---

## 2. The new shape

```json
{
  "id": "p-investigate",
  "name": "Investigation",
  "description": "How we diagnose an issue or answer a question — read-only, evidence-first.",
  "narrative": "An investigation examines; it never fixes. Frame the precise question and scope first, then gather the real evidence — logs, code paths, config, live state — without touching anything. Weigh it against your hypotheses, separating what you verified from what you are still guessing. Close with findings, the root cause if you have it, and a recommendation. Keep the read-only line: diagnosing is not deploying.",
  "scope": { "project_id": null, "tags": ["diagnosis", "read-only"] },
  "version": 4, "updated_at": "…", "updated_by": "tom"
}
```

Compare the current `p-investigate`: ~60 lines of `steps[]` each with `agent`/`type`/`intent`/
`accept_criteria`/`checkpointBoundary`, plus `parameters`, `contextTemplate`, `pre_flight`,
`visibility`, `execution_count`. **All of that is dropped.** What survives is the wisdom in prose
(read-only, evidence-first, verified-vs-guessed) — and none of the machinery that broke.

This makes a process the true sibling of a skill, exactly as you framed it:

| | **Skill** | **Process (playbook)** |
|---|---|---|
| Teaches | HOW to drive a tool / do a generic task | WHAT has worked for a recurring kind of work |
| Content | tool syntax, flags, procedure | a contextual narrative — no tool syntax |
| Scope | role-generic | project / context specific |
| Author | the repo (shipped) | the agent (remembered, evolved) |

---

## 3. The new mechanism — a process is planning CONTEXT, not an execution path

**Today:** cortex matches a process → `follow_process` → the process-engine runs the steps → the
checkpoint-executor dispatches each step's agent. Two competing ways to structure work
(`follow_process` vs `checkpoint_plan`), with the rigid one preferred.

**New:** there is **one** way work gets structured — the agent's own `checkpoint_plan`. When a
mission resembles a known pattern, that process's **narrative is recalled and injected into the
planning context** as a prior ("here's how we've done this well before — adapt it"). The cortex then
plans its own checkpoints and tasks, with the iterative control it already has (re-plan, adjust,
manage the spine). The narrative **guides**; it never dispatches.

Consequences:
- **Retire** the `follow_process` action, the process-engine step execution, the *"prefer
  follow_process"* bias, and `required_processes` **mandates**. A project may still *suggest* a
  relevant playbook, but it can never force a rigid execution.
- The cortex still sees a lightweight **registry** (name + one-line description) so it knows what
  playbooks exist; the full narrative loads on demand when the work is relevant.
- **Maximum iterative control falls out for free** — the only path that structures work is the
  agent's own planning.

---

## 4. The living lifecycle (the heart of the ask)

Processes become an **agent-owned, evolving knowledge tier**, modeled on Core Memory (agents already
write/retire facts via `core-memory-*` and curate them nightly). Five verbs:

- **Capture** — after work that went well, the agent records the pattern as a new/updated playbook
  ("this is how we successfully did X"). Triggered by the agent's own reflex on a clean success, by a
  curation pass in the nightly memory-consolidation cycle, and/or by the user saying "remember how we
  did this."
- **Recall** — when planning similar work, the relevant narrative surfaces (through the same recall
  path that already surfaces memory) and is injected into the plan.
- **Update / upgrade** — the agent refines a playbook when a later run improves the pattern, or a
  correction lands (bump `version`, stamp `updated_at`/`updated_by`).
- **Discuss** — the agent answers "what processes do you have?" by listing name + description, and
  narrates one on request. A first-class conversational surface.
- **Take feedback** — the user says "for deploys, always do X" → the agent updates the relevant
  playbook's narrative and confirms. Feedback becomes a durable pattern, not a one-off correction.

---

## 5. Where they live — a new memory tier

A named narrative pattern sits beside the tiers that already exist:

| Tier | What it holds | Lifetime |
|---|---|---|
| Working memory (`MEMORY.md`) | transient scratchpad | the day |
| Core memory | atomic durable facts | weeks+ |
| Deep truths (`SOUL`) | behavioral constraints | rare, evidence-gated |
| **Playbooks / processes (NEW)** | **named "how we do X well" narratives** | **evolve with the work** |

Source of truth = the **living store** (Firestore), agent-writable like Core Memory — because agents
evolve them and take feedback on them. The repo **seeds a few starter narratives** (a first library)
but does not own the living set; agents curate it. (Deliberate reversal from the last RFC's "repo =
source of truth" — necessary for agents to update, upgrade, and discuss them.)

**Scope = one GLOBAL library for the whole deployment.** A single tenant-wide `processes` collection
at the database **root**, visible to and writable by **every agent across every prime** — so a
pattern one agent learns is a pattern the whole fleet can reuse ("share what works"). This also
collapses today's root-vs-prime duplication into the one shared library. A playbook may be **tagged**
to a specific prime-project for context, but it lives in the single shared library. Curation (dedupe,
retire stale, keep few) rides the nightly consolidation so the global library stays lean.

---

## 6. The surfaces to build

- **Brain recall hook** — add playbooks to the recall corpus so relevant narratives inject into
  planning; keep the lightweight registry listing (name + description) for the cortex.
- **A `process-ops` skill + CRUD tool** (modeled on `core-memory-*` / `project-ops`) — list / read /
  write / update playbooks, so capture / update / discuss / take-feedback are deterministic. The
  skill is the HOW; the narratives are content.
- **Consolidation curation** — extend the nightly memory-consolidation responsibility to review,
  upgrade, and retire playbooks.
- **Dashboard** — the processes view becomes a **read / discuss** surface (name, description,
  narrative, version history). The step editor is removed — there is no machinery to edit.

---

## 6b. Universal authoring + automatic context maintenance

Two additions that make the library — and projects — genuinely self-maintaining.

**Universal authoring — every agent creates/edits processes AND projects.** Playbooks and
prime-projects are both *agent-managed context*, not privileged config, so create/edit is a **base
capability for every role**, not gated to a PM/architect:
- **Processes** — any agent can capture a new playbook, refine a narrative, or retire a stale one in
  the one global library (§5).
- **Projects** — any agent can create a prime-project and keep its context current (team, canon,
  resources, deploy target) — the `project-ops` capability, promoted from a specialty skill to a base
  one available to all roles.
- Guardrail (rides the memory-curation discipline): edits are **additive and curated** — refine,
  dedupe, never clobber; conservative and evidence-based, never invent. The auto-maintenance below is
  what keeps universal write access from drifting into mess.

**Automatic context maintenance — the temporal-memory reflex.** A process's narrative and a project's
context should reflect *what just happened*, not the day they were written. So maintenance becomes an
**automatic post-mission reflex seated in the temporal-memory organ** — a *skill* (the how) plus a
*personality* (the disposition), exactly as framed:
- **Trigger (deterministic):** on mission completion, if the mission **used a process** (recalled its
  narrative into planning) or **touched a project** (`project_id` set / project context referenced),
  a completion hook fires the reflex for *those specific items only* — nothing else is rewritten.
- **Personality (temporal-memory `SOUL_APPEND`, pure disposition — no tool syntax):** *"I keep the
  context of what we use current. When a mission draws on a process or works a project, I refresh what
  we know from what just happened — tightening a narrative that proved out, recording what changed,
  noting what worked — so the library and each project's context track reality, not history. I update
  only what was used, only when something was actually learned, and I refine rather than overwrite."*
- **Skill (the how):** a craft-context procedure — distill the finished mission into a small, honest
  update to the used process narrative and/or the touched project's context, then write it. (Also
  invokable explicitly, e.g. when the user says "remember how we did this.")
- **Mechanism (C-5 / C-4):** temporal-memory (the intelligence) produces the updated narrative /
  context as structured output; the daemon (deterministic) writes it — the organ stays pure. This is
  a *micro-consolidation* tied to mission completion; the nightly consolidation (§6) remains the
  periodic deep pass (dedupe, retire, keep the global library lean).
- **Guardrails:** bounded (only items the mission used), conservative (skip when nothing was learned
  — no busywork edits), honest (B-29 — never fabricate a pattern), additive (refine + keep version
  history), and it **never touches production or ships anything** — it only curates context.

Net effect: the global playbook library and every project's context **improve on their own from real
work**, any agent (not just a PM) can seed or correct them, and the memory organ keeps them honest
and current without anyone having to ask.

## 7. Canon implications (edits to propose)

- **MODULE_CHARTER / C-28** — redefine the *process* layer: from "executable step template" to "named
  narrative pattern (playbook) of how a recurring kind of work is done well," and draw the
  process↔memory boundary (a playbook is a *named, shareable, reusable how-to narrative*; working
  memory is transient, core memory is an atomic fact, a deep truth is a behavioral constraint). A
  process still carries **no tool syntax** — that stays in skills.
- **C-14 / C-15** — one work-structuring path (the agent's `checkpoint_plan`) strengthens the CoW
  primitives: R→M→C→T, always planned by the agent, never by a competing step-machine.
- **B-16 / B-17** — sharpen the skill↔process line you drew (skill = generic tool procedure; process =
  contextual pattern narrative).
- Candidate new invariant: **"Processes are narratives, not programs; the agent always plans its own
  checkpoints."**

---

## 8. Migration

1. **Convert** the existing step-processes to narratives — distill each one's steps into prose (the
   `p-investigate` example above). Keep the good ones as seed playbooks; drop the retired / duplicate /
   zombie ones (the `p-web-*` set, stale root `v1` dupes, the corrupt `p-memory-consolidate`).
2. **Flip the brain** — retire `follow_process`, the process-engine step path, the "prefer
   follow_process" bias, and `required_processes` mandates; add the recall injection; keep the
   registry listing.
3. **Ship the lifecycle** — the `process-ops` CRUD skill/tool + universal process+project authoring
   (§6b), the temporal-memory auto-maintenance reflex + the nightly consolidation curation, and the
   dashboard read/discuss view.
4. **Reconcile once** — clean the Firestore zombies (still worth doing, simpler now); thereafter the
   store is agent-curated.
5. **Canon + docs** stamped.

**Phasing (each provable on tom):**
- **P1 — shape + recall:** convert a couple of playbooks to narratives; add the recall injection;
  prove a mission *recalls* a narrative and plans its *own* checkpoints with it (`follow_process`
  still alive underneath — no gap while the replacement is unproven).
- **P2 — universal authoring + the living verbs:** promote process + project create/edit to a base
  capability for every role; capture / update / discuss / take-feedback; prove tom lists its playbooks
  and upgrades one from user feedback, and a non-PM agent creates/edits a project.
- **P3 — automatic maintenance + curation + retirement:** the temporal-memory auto-maintenance reflex
  (§6b) + the nightly curation keep the global library and project context current; dashboard
  read/discuss; then **hard-retire** the process-engine + `follow_process` (the recall replacement is
  proven, so removing it leaves no gap).

---

## 9. Decisions (operator-confirmed 2026-08-14)

1. **Source of truth → agent-evolved living store.** Firestore is authoritative (the Core-Memory
   model); agents capture / update / take-feedback in the moment; the repo seeds a few starters and
   then gets out of the way.
2. **Engine → hard-retire.** `follow_process` + the process-engine step path + the "prefer
   follow_process" bias are removed; the agent's own `checkpoint_plan` is the sole work-structuring
   path. **Sequenced safely:** the narrative-recall replacement is built and proven FIRST (P1), then
   the engine is deleted (P3) — so there is never a gap where neither path works.
3. **Scope → one GLOBAL library.** A single tenant-wide `processes` collection at the database root,
   visible to and writable by **every agent across every prime**; project-taggable. Collapses the
   root-vs-prime duplication.
4. **Authoring → universal (processes AND projects).** Every role can create/edit both processes and
   prime-projects (§6b), not just a PM/architect.
5. **Maintenance → automatic, seated in temporal-memory.** A skill + personality that, on mission
   completion, refreshes the context of any process or project the mission actually used (§6b) — no
   explicit ask required.
6. **Naming → keep "process"** (revisit if "playbook" reads clearer once the narrative framing lands).
7. **Capture trigger → all three** — the automatic post-mission reflex (§6b) + the nightly curation +
   an explicit "remember this."
