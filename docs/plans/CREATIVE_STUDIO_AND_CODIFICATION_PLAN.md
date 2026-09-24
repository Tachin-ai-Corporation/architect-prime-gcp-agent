# Creative Studio & Codification — Diverge, then Converge

**Status:** Proposal (for review — not yet implemented)
**Canon:** [C-4/C-5](../PRODUCT_CANON.md) deterministic spine consults intelligence · [C-14/C-15](../PRODUCT_CANON.md) closed CoW set, R→M→C→T · [C-28/C-29](../MODULE_CHARTER.md) layer + plane · [C-37](../PRODUCT_CANON.md) posture · [C-38/B-37](../BRAIN_CANON.md) graded verdict · [B-18](../BRAIN_CANON.md) thin spine over single-purpose libraries · [B-26](../BRAIN_CANON.md) resourceful breadth

> The outcome we want: an agent can **creatively establish a format/process the first time** (as a strong model did for the weekly exec brief), then **turn that into a responsibility cleanly**. Today the pipeline only supports the second half, so agents skip the creative phase and encode a mediocre standard.

---

## Problem

Agents jump straight to a rigid repeatable process and get a mediocre "exact" one. Concrete evidence in-house: Millie's weekly executive summary hardened into a flat `DECISIONS / PROGRESS / BLOCKERS / ACTION ITEMS` dump — seven near-identical drafts produced within minutes on one day, garbled names ("Sock 2", "Paragrin 3", "TEFLA"), zero altitude. The good path is the reverse order: **first produce an excellent artifact from the inputs, then codify *that* into the standard.**

The brain has no first-class mode for the first half:

- **No divergent/generative organ exists.** The six organs are all convergent or read-only: `cortex` returns exactly one decision/synthesis per call; `prefrontal` decomposes; `motor` executes a *known* skill and is explicitly barred from self-decomposition (`platform/organ-firmware/prime/motor/SOUL.md`) and turn-capped (`brain.max_iterations`, default 25); `cerebellum` verifies; `temporal-*` read. The action set (`platform/runtime/actions/index.mjs`) has no creative action.
- **The dispatch machine is convergent-delivery-shaped.** `CAPABILITY_POSTURE_PLAN.md` already names this: the mission machine is "optimised for structured delivery, not open-ended" work.
- **Posture widens cognition, not loop shape.** `unbound` (prime) buys stronger execution models + budget headroom, but still inside the classify→plan→dispatch→verify loop — not the divergent generate→self-critique→revise loop that produced the exec brief.

## Principle — two phases, one spine

**DIVERGE, then CONVERGE.**

- **Diverge (Studio):** a frontier model, a wide turn budget, warm sampling, and tool access, running an open-ended loop — *understand intent → gather inputs → draft → self-critique against a rubric → re-render/verify → iterate* — to an emergent artifact. Expensive, **gated**, human-attended.
- **Converge (Codify):** distil the successful run into a **Responsibility** (recurrence) + **Process** (narrative playbook) + a **template / brand scaffold**, so the fleet reruns it **cheaply on Flash**.

The daemon still owns the outer loop (C-4); Studio is a single-purpose library it invokes (B-18); `cerebellum` still grades the artifact (C-38/B-37); a human gate stands before anything outward or expensive. Creativity widens judgment inside the **same walls** (C-37) — it never touches the deterministic spine, the capability fence, or the honesty/verification floor.

The economic point is the whole point: **creativity is spent once (frontier, attended) and its output is a cheap, repeatable process.** If a task cannot be codified down to Flash + scaffold, that is a signal — not a failure — that it needs the creative tier recurring.

---

## Part 1 — Millie's weekly executive update (the first codified output)

This is the *converge* half applied to the artifact already produced. It ships with **no new mechanism** — the responsibility scheduler, the process registry, and the doc toolchain all exist.

### Layering (C-28/C-29 — keep the platform template-clean)

| Piece | Layer / plane | Where |
|---|---|---|
| Generic weekly-exec-update **responsibility** (recurrence + generic instruction) | Skill/spec content, Fleet Definition, template-clean | `specialties/assistant/responsibilities-assistant.json` (empty stub today; manifest already maps it → `corekit/responsibilities-job.json`, `infra/manifests/job-assistant.txt:80`) |
| Operator-specific **process** (the method + the exact 30-min structure) | Process, Fleet Definition, operator-specific | `operator/processes/p-weekly-exec-update.json` |
| The **which-meetings + folder IDs + brand-guide id** | Project resource refs / core memory, Runtime State | Millie's Project context (not the repo — these are operator data, C-8) |
| The **brand guide** (teal palette) + section scaffold | An ordinary Google Doc referenced by id | Drive ("Master Templates") |

No real folder IDs or meeting names go into `specialties/` or `platform/` — the responsibility recalls the operator process by intent-keyword and reads the bindings from Millie's project/memory.

### The responsibility (generic, template-clean) — v2 shape

```json
{
  "id": "r-weekly-exec-update",
  "name": "Weekly Executive Update",
  "schedule": "30 15 * * 4",
  "timezone": "America/Chicago",
  "enabled": true,
  "singleton": true,
  "min_spacing_minutes": 1440,
  "triggerable": true,
  "instruction": "Produce this week's Weekly Executive Update to structure the 30-minute weekly exec sync. Recall the weekly-executive-update process, gather the most recent notes for each of this project's designated weekly source meetings, and synthesize a time-boxed briefing (agenda-at-a-glance, state of the week, per-area status with inline blocker flags, decisions to lock, and an owner/action/due table). Deliver it as a branded doc in the exec-summaries folder and post the link.",
  "success_criteria": "A single dated Weekly Executive Update doc exists in the exec-summaries folder, sourced ONLY from the most recent version of each designated weekly meeting, structured as a 30-minute agenda (agenda table, State of the Week, per-area status, Decisions to Lock, Blockers, Action Items with owners), with acronyms normalized. The doc link is reported.",
  "context": {
    "purpose": "Leadership runs a 30-minute weekly exec sync; they need one reliable, skimmable briefing built the same way every week.",
    "process": [
      "RECALL: load the 'Weekly Executive Update' process narrative and this project's source-meeting + folder + brand bindings.",
      "GATHER: for each designated weekly meeting, take the MOST RECENT notes/transcript only (drive-ls the meeting folder, pick the latest).",
      "SYNTHESIZE: distill into the fixed 30-min scaffold; flag blockers inline; collect decisions-to-lock; build the owner/action/due table.",
      "DELIVER: docs-create-branded --content sections.json --folder <exec-summaries> --brand-doc <brand> ; report the link."
    ],
    "reference_files": ["workspace/MEMORY.md"],
    "prior_learnings": ""
  }
}
```

- `30 15 * * 4` = **Thu 15:30 UTC = Thu 10:30 CDT** (dow `4` = Thursday; lands after the week's meetings). **Cron is UTC-only — the `timezone` field is documentation, not honored** (`platform/work/scheduler.mjs`); when DST ends it fires at 09:30 CST, so re-pin to `30 16 * * 4` at the boundary if the exact hour matters. *(Superseded v2026.09.24.1.1: the scheduler now honors `timezone`, and the schedule is `15 10 * * 4` + `America/Chicago` — 10:15 Central year-round, no re-pin; moved to `20 10 * * 4` — 10:20 Central — in v2026.09.24.1.8.)*
- Recall is by **intent-keyword match**, not `processRef` (which is inert) — the instruction deliberately contains "weekly executive update" / "meeting" so the operator process is recalled at plan time (`platform/runtime/actions/checkpoint_plan.mjs`).

### The operator process (Tachin-specific narrative)

`operator/processes/p-weekly-exec-update.json` — `{id, name, description, narrative, intent_keywords, status, version}`, authored at runtime via `process-ops write` or shipped as a seed. The **narrative** carries the method and the exact section scaffold (no tool syntax): the four designated meetings, "most recent of each," the agenda-at-a-glance + State-of-the-Week + per-area status with inline blocker flags + Decisions-to-Lock + Action-Items-table structure, "normalize acronyms," "one doc per week in the exec-summaries folder." `intent_keywords: ["weekly executive update","executive brief","exec sync","meeting notes","weekly update"]`.

### Format parity with the reference artifact

The gold artifact (this session's `Tachin-Weekly-Exec-Update.docx`) becomes the **reference/eval case**. Parity is held by two cheap constraints, not by re-running the creative synthesis each week:
1. a **brand-guide doc** (teal `#0E7490`, the heading/table styling) passed to `docs-create-branded --brand-doc`, and
2. a **fixed section scaffold** described in the process narrative (same sections, same table columns, same order).

### One decision that ties Part 1 to Part 2 — synthesis tier

Millie is fleet/`strict`/Flash. The scaffold + brand keep *formatting* cheap, but *distilling four noisy transcripts into crisp exec bullets* is the quality-sensitive step. Options: **(a)** accept Flash + tight scaffold (cheapest; likely adequate once the format is fixed); **(b)** grant just this responsibility's synthesis task a bounded posture bump to the strong tier; **(c)** keep the frontier "Studio" in the loop weekly (most expensive — only if (a)/(b) underperform against the reference case). Recommend **(a)**, measured against the reference case, falling back to **(b)**.

---

## Part 2 — the creative capability (the *diverge* half, made first-class)

### 2a. Decision — new "Studio" organ vs. a creative mode on motor

**Recommendation: a dedicated creative path — a new `create_artifact` ACT action backed by a new "Studio" organ — sequenced *after* the skill/process/pattern below.** Rationale, from the mapping:

- The disposition genuinely **conflicts with motor**. Motor's SOUL is execution discipline — "stay in your lane," no self-decomposition, turn-capped. Merging high-temperature divergent ideation into motor corrupts the organ that must be reliable. A distinct organ keeps each organ's one job (B-3).
- It needs its **own frontier tier + large turn budget + a loop exempt from the convergent guards** (pass-replan foreclosure, verify-or-fail) *during generation* — the very guards that make delivery reliable are what strangle exploration. That is a different loop, not a knob on the old one.
- Neuro-consistent naming: the generative/associative faculty → working name **`studio`** (alt: `dmn` / "default-mode", `imagination`). Its one job: *produce a candidate artifact via bounded divergent iteration from a set of inputs + an intent.*

The cheaper alternative (motor + a `generate` skill + posture bump, à la `designer`/`web-master`) is viable and is exactly **Stage 1** below — we prove the pattern that way before paying the organ's ~15–18 touchpoints and `ORGAN_LOCK` re-pin.

### 2b. `creative-exploration` skill (Fleet Definition — the meta-method)

A skill that codifies *how to run a studio session well* and *how to codify its output* — the method this session used, generalized:
- **Explore:** restate the intent in one line; gather the real inputs (read them fully, not summaries); identify the audience and the job-to-be-done.
- **Draft → self-critique → iterate:** produce a candidate, critique it against an explicit rubric (fit-to-intent, altitude, correctness, skimmability), revise; **render and look at the real output** (the docx→pdf→image loop here) before declaring done.
- **Verify for real:** hand the artifact to `cerebellum` against acceptance criteria; never self-certify.
- **Codify:** distil the successful run into a Process narrative (`process-ops write`), a Responsibility, and a template/brand scaffold; then **parity-check** by re-running the codified path on the same inputs and diffing against the gold artifact.

Analogous to the `operator-forensics` skill already proposed in `CAPABILITY_POSTURE_PLAN.md` — a methodology skill, not a tool wrapper.

### 2c. `p-artifact-then-standardize` process (Fleet Definition — the narrative)

The reusable playbook for the whole pattern: "When asked for a recurring output with no good standard yet, first produce one excellent instance and get it signed off, *then* encode it — never encode an unproven format." Recalled by intent-keywords like `["new process","establish format","standardize","recurring report","codify"]`.

### 2d. The diverge→converge mission pattern (R→M→C→T — no new primitive, C-14)

A Mission with three checkpoints:
1. **Produce a satisfactory artifact** — Studio generates; `cerebellum` grades against the rubric; **human sign-off** gate.
2. **Codify** — motor writes the Process (`process-ops`), the Responsibility, and the template/brand scaffold.
3. **Parity dry-run** — fire the codified path on the same inputs; diff against the signed-off artifact; report deltas.

This is the *only* new "workflow," and it is expressed in the existing closed set — a mission pattern, not a tenth primitive.

### 2e. Codification surface — the real gap: authoring a responsibility *cleanly*

- **Process authoring: solved.** `process-ops {list,get,write,retire}` (`corekit/brain/process-ops`) PATCHes the global Firestore `processes/{id}` at runtime. ~~The temporal-memory post-mission reflex already refines recalled playbooks.~~ *(Superseded v2026.09.24.1.2 — memory is a closed set (BRAIN_CANON B-5): the reflex now records a lesson about a playbook into working memory and never rewrites the playbook; process-ops moved out of `corekit/memory/`.)*
- **Responsibility authoring: missing.** Responsibilities are manifest-managed files (`specialties/*/responsibilities-*.json`); `processRef` is inert; there is no `responsibility-ops`. So "turn it into a responsibility cleanly" today means a repo edit + redeploy — not something an agent does in-loop. **Propose a `responsibility-ops` capability** (author/enable/disable a responsibility as **Fleet Definition** via the registry→`compiler.mjs` path + Firestore, honoring C-29: Prime authors within policy, human-gated), plus a dashboard control. This is the missing rung that makes the converge step first-class.
- **Templates:** there is no template registry — templates and brand guides are plain Google Docs in "Master Templates," referenced by id. A light **template/brand-guide convention** (a Project resource ref to the master + brand doc) is enough; no new mechanism.

### 2f. Model / budget / posture wiring (Foundation — small)

- Add a `creative` model tier to `vertex.models` (frontier, e.g. the opus tier cortex uses) and select it for `studio` in `corekit/brain/config.mjs` (`loadAgentConfig`, lines 66–79); add `studio` to `EXECUTION_AGENTS` or `maxSteps` is pinned to 1.
- Give it its own turn budget (a `brain.creative_max_iterations` well above 25) and a warmer registry `temperature`/`top_p`; respect the hard storage ceilings (`dispatch.context_token_budget ≤ 125000`).
- **Gating:** Studio is expensive + high-latitude, so it is a **prime/`unbound`** capability by default; a fleet agent reaches it only inside an explicit, human-gated authoring mission — the same posture logic that keeps fleet `strict` for autonomous work (C-37).

---

## What this must not touch

Non-negotiable (C-37 + C-21), identical to the posture plan:

- The **deterministic spine** — state transitions, dedup, routing, scheduling, the envelope machine. The daemon still owns the loop; Studio is invoked, it does not drive.
- The **capability fence** — C-1, C-8 (secrets), C-27 (mouth is the sole fleet egress), C-33/C-34 (self-grant / repo authorship). A creative organ gets latitude of *thought*, not new reach.
- The **honesty / verification floor** — the artifact still passes `cerebellum` + the human gate before codification. "More creative" must never mean "more likely to pass unverified work as done" (C-38/B-37).

---

## Sequencing

1. **Now, cheap, reversible (Fleet Definition):** ship `creative-exploration` skill + `p-artifact-then-standardize` process + the diverge→converge mission pattern, run on a **prime under `unbound`**. Use it to produce and codify **Part 1** as the first worked example. This delivers value immediately and *proves the workflow before hardening it* — the plan practicing its own principle.
2. **Foundation increment:** the `studio` organ + `create_artifact` ACT path + `creative` model tier + budget/gating. Justified once Stage 1 shows the loop-exemption and frontier-budget needs concretely.
3. **Close the converge gap:** `responsibility-ops` + dashboard control so agents author responsibilities cleanly, not via repo edits.

## Open decisions

- **Organ vs. mode / name:** approve a dedicated `studio` organ (Stage 2), or stay on motor+skill+posture indefinitely? Name: `studio` / `dmn` / `imagination`?
- **Fleet access to Studio:** prime-only, or fleet-under-human-gate?
- **Millie synthesis tier:** Flash + scaffold (recommended) vs. bounded posture bump vs. weekly Studio.
- **Millie output substrate:** branded **Google Doc** in the folder (native, recommended) vs. a `.docx` artifact via `docs-export-docx` + `work-publish`.
- ~~**Cron/timezone**~~ **Decided:** Thu 10:30 CT (`30 15 * * 4`, UTC-baked for CDT; re-pin to `30 16 * * 4` when DST ends).

## Follow-ups

- A reference-case **eval** (this session's exec brief) wired into the skill regression suite, so codified output is graded against the gold artifact.
- Let the temporal-memory reflex refine `p-weekly-exec-update` from each week's run (it already does this for recalled playbooks).
- Revisit whether `processRef` should be wired (bind a responsibility to a process directly) or formally retired in favor of intent-keyword recall — today it is inert and misleads authors.
