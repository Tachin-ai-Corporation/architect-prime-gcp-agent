# The Analyze Phase

> **Amends:** `docs/BRAIN_CANON.md` — B-10 (the iteration loop) and B-9 (organ roles).
> **Supersedes:** the deterministic gate that lived in the old planning-and-delegation guide (Change 1), which has since been removed. The Brief and the step taxonomy below replace it; see [TEAM_AND_DELEGATION.md](TEAM_AND_DELEGATION.md) and [DELEGATION_PROTOCOL.md](DELEGATION_PROTOCOL.md) for what remains current.
> **Ownership:** Human maintainers via CODEOWNERS. This is a canon amendment — it lands by PR with human approval.
> **Status:** Normative once merged. Describes what the loop *is becoming*.

A turn is not simple or complex; it is a plan, and a plan is made of steps that each have a nature. An agent cannot know whether work is simple before it has decomposed the work, so any mechanism that asks it to pre-judge complexity — to route trivial-vs-hard before analysis — is asking for a guess in place of the analysis that would answer the question. The brain stops guessing: **every execution-bound intake is decomposed first, unconditionally, and the decomposition is what reveals the shape.**

---

## Why the gate is removed, not fixed

The prior design gated the planning pass behind a turn-level classifier — *synthesize · simple_local · multi_phase · delegation · risk*. It is withdrawn for three reasons, and no parameterization of the enums survives them:

1. **It is circular.** Complexity is the *output* of decomposition, not an input. To decide whether to skip the analysis you would need the analysis. A gate on a complexity estimate defeats the organ it gates.
2. **It labels the wrong unit.** *Simple*, *delegable*, and *risky* are properties of **parts of the work**, never of a turn. One mission routinely carries a one-line local step, a handoff to a teammate, and a risky deploy together. Assigning one of those labels to the whole turn is a category error.
3. **It inverts the precedence order.** The gate traded correct, reflected decomposition (**Correctness**, **Human Trust**) for fewer LLM calls (**Efficiency**). The order is Correctness & Safety → Reliability → Human Trust → Efficiency → Simplicity. Unconditional analysis restores it.

The flaw predates the gate. B-10 as written places prefrontal in **ACT** — *"the daemon dispatches per the decision: prefrontal to structure"* — so cortex already decides *whether structuring is needed* before any structure exists. The amendment moves that judgment to where it belongs: after the analysis, not before it.

---

## Amendment to B-10 — insert ANALYZE

> ### B-10 · The iteration loop: gather → analyze → decide → act → verify → close-or-repeat
>
> Every active envelope advances through one canonical cycle, daemon-owned end to end:
>
> 1. **GATHER** — assemble minimum sufficient context: temporal-memory recall, and temporal-research when (and only when) the question needs the outside world. Parallel-eligible (B-12).
> 2. **ANALYZE** — for any intake that requires execution, prefrontal decomposes the work into a **Brief**: the work broken into its true parts, each annotated with its nature (local, or a teammate's specialty), its risk, its dependencies, its unknowns, and any matching stored process. Analysis is **unconditional** for work and **judges nothing about the turn as a whole** — it is the step that reveals the work's shape. Prefrontal proposes; it does not commit a move.
> 3. **DECIDE** — cortex commits exactly one plan from the legal-move set (B-11), assembling the Brief's parts into an ordered set of **typed steps**: local execution, delegation, approval gate, ask. When the Brief flags a matching playbook, its narrative is recalled into the planning context as a prior — it shapes the plan, it is never itself a step. A plan is heterogeneous by nature; **no step's type is the turn's type**.
> 4. **ACT** — the daemon dispatches per step: motor to mutate, temporal organs to fetch, delegation outward, approval gates to the operator. Verification it adds itself where a step carries accept criteria.
> 5. **VERIFY** — cerebellum checks results against accept criteria; verification is independent of execution by construction.
> 6. **CLOSE or REPEAT** — the daemon applies the transition: advance the checkpoint, complete the envelope, raise `needs_input`, fail, or iterate. The iteration counter increments here and only here, bounded by the contract cap.
>
> The daemon owns the loop; prefrontal owns the decomposition; cortex owns the commitment. One cycle, one plan, one transition.

---

## Amendment to B-9 — propose vs. commit

Today both organs can plan: cortex "plans work as checkpoints," prefrontal produces "M→C→T blueprints." That overlap is the ambiguity that let designation become a reflex. The amendment removes it — **prefrontal understands the work; cortex commits to how it will be done.**

| Organ | Current (B-9) | Amended |
|---|---|---|
| **Cortex** · one job | Classify intakes, choose decisions, synthesize outcomes | Classify intakes, **commit the plan from the Brief**, synthesize outcomes |
| **Cortex** · never | Executes tools; holds the loop; verifies itself | *(unchanged)* |
| **Prefrontal** · one job | Turn intent into structure: M→C→T blueprints | **Decompose and assess execution-bound work into a Brief** |
| **Prefrontal** · never | Executes; decides; freelances beyond the blueprint schema | Executes; **commits or selects a move**; **judges the turn as simple or complex**; freelances beyond the Brief schema |

Diagram line, under B-9:

> ```
>               CORTEX             PREFRONTAL                 CEREBELLUM
>               the voice:         the analyst:               the conscience:
>               classify,          decompose & assess         independent
>               commit the plan,   → the Brief                verification
>               synthesize
> ```

The split is clean because prefrontal *cannot* commit (it never decides — preserved from the current canon) and cortex *must* (its job). Propose and dispose are two jobs, not one shared one.

---

## What the phases produce

**The Brief (prefrontal, ANALYZE).** A structured decomposition — daemon-owned schema, injected at analyze time, never in prefrontal's SOUL:

```jsonc
Brief ::= {
  "objective": "the real outcome, stated once",
  "parts": [
    { "id": "p1",
      "summary": "what this part is",
      "ownership": "local" | "teammate",
      "specialty": "<role>",          // when ownership = teammate
      "risk": "none" | "mutating" | "destructive_or_public",
      "depends_on": ["…part ids"],
      "unknowns": ["…what must be resolved before this part can proceed"] },
    …
  ],
  "process_match": "<processId>" | null   // a stored playbook whose narrative to recall as a planning prior
}
```

The Brief judges parts, never the turn. A trivial intake yields one part; that is how "simple" is *discovered*, not declared.

**The Plan (cortex, DECIDE).** Cortex reads the Brief and commits one move per part, producing an ordered set of typed steps. The step types are properties of steps; the rails already exist:

| Step nature | Maps to | From the Brief |
|---|---|---|
| **Local execution** | motor / research / recall / verification task (`step_type: standard`) | `ownership: local` |
| **Delegation** | the delegation envelope + handoff (objective · scope · inputs · accept · expected artifact), delivered to the shared space | `ownership: teammate` → cortex selects the target from the project team |
| **Approval / risk-escalation** | `step_type: approval_gate` — operator gate before the step runs | `risk: destructive_or_public` |
| **Ask** | `needs_input` raised for the part | a part whose `unknowns` only the operator can resolve |

When the Brief's `process_match` is set, the matched playbook's narrative is recalled into the planning
context as a **prior** — it informs how cortex composes the steps above. It is not a step type of its
own; there is no `follow_process`, and the agent always plans its own checkpoints (C-15).

Sequencing follows `depends_on`: independent steps fan out (**B-12**), dependents serialize, all join before the next DECIDE.

---

## The one judgment that remains before analysis

Classify still runs first and still belongs to cortex, but its question is narrowed to the one thing that is not a complexity estimate: **does this intake request an outcome in the world, or is it conversational / answerable from knowledge?** Work → ANALYZE, always. Conversation or recall → synthesize, no Brief. There is no "is this simple" anywhere in the path; the only pre-analysis fact is "is an action requested," which is robust and is cortex's stated classify job.

---

## Honest cost

Mandatory analysis adds one call per work intake — the path is now **classify → analyze → decide** (cortex → prefrontal → cortex) where it was classify → decide. This is accepted under the precedence order: it buys correct, reflected decomposition and the operator's trust that work is always understood before it is committed or handed off. The cost is bounded — a trivial Brief is a single part returned cheaply — and analyze and decide are deliberately *not* merged, because merging them recreates the reflex this amendment exists to remove.
