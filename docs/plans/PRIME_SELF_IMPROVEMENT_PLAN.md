# Prime as a Working Fleet Architect — and the Screen a Human Uses to Trust It

> **Goal.** An operator opens a chat with a Prime, describes something the fleet does badly, and the
> Prime diagnoses it, drafts the change, tests it on a canary, shows the evidence, asks once, and
> promotes it — with every step visible and reversible from one screen.
>
> Read with [IMPROVEMENT_POLICY](../IMPROVEMENT_POLICY.md) (the rules and the verification ladder),
> [ADR-001](../adr/ADR-001-three-planes-two-loops.md) (why the two loops are separate), and
> [THREE_PLANES_PLAN](THREE_PLANES_PLAN.md) §P4/§P6 (what shipped).

---

## Where we actually are

Being precise about this matters, because the gap is smaller and differently shaped than it looks.

**The substrate exists.** A deployed Prime has `fleet-config` with thirteen commands — `import, list,
get, diff, validate, release, assign, rollback, compile, status, observe, evaluate, finding` — plus
`skill-author`, `process-ops`, `fleet-hire/fire/upgrade/verify/status`, and a 193-line
`fleet-architecture` handbook covering plane classification, role design, evidence-based diagnosis,
eval design, canary and rollback, and Platform Findings. The registry, the compiler, the three
coordinates, the rollout gate and the release view are all built and canary-proven.

**Three things are missing, and only three.**

| Gap | What it means today |
|---|---|
| **G1 — the loop is unproven end to end** | Every piece has been exercised alone. Nobody has driven role → soul → skill → assign → evaluate → approve → promote → rollback *from a chat message*, which is the P4 exit gate. |
| **G2 — the human can watch but not act** | `/p/[id]/studio` answers the seven questions and shows all three coordinates. Every *authoring* and *approval* action is CLI. Chat has no structured cards, so an approval is free text the brain has to interpret. |
| **G3 — nothing turns outcomes into candidates** | Missions produce exactly the evidence an improvement needs — `blocked` reasons, tool-error rates, iteration counts, false-completes — and none of it flows anywhere. Improvement starts when a human notices. |

The plan closes those three, in that order, because each is the prerequisite for the next being
worth anything: a Studio that authors an unproven loop is a faster way to break things, and an
automatic candidate generator feeding a loop nobody has watched is worse still.

---

## The worked example this plan is measured against

Not hypothetical. It happened on 2026-08-16 and is in the log at `v2026.08.16.7.0`:

> Millie was asked to build an ops tracker. She tried `sheets-create`, then `sheets create`, then
> `drive-create --mime-type`, then **read her own SKILL.md**, and correctly concluded no tool creates
> a spreadsheet. Her `report_fail` said: *"Provide the motor agent with a functional tool or command
> to create Google Sheets."* The mission terminated `blocked`. A human read the log, wrote the tool,
> shipped it, upgraded the VM and re-ran the mission.

Every judgement in that paragraph was made correctly by the agent. The only thing missing was a path
from *her diagnosis* to *a fleet change*. **When a Prime can carry that paragraph from "blocked" to
"promoted" with one human approval, this plan is done.** It is used as the acceptance scenario for
every phase below, at increasing levels of autonomy.

---

## Phase A — Prove the loop, conversationally (closes G1)

No new capability. Drive the substrate that exists from chat and fix what the attempt exposes, which
is the only reliable way to find out what a handbook left out.

**Work**

1. **Walk the P4 exit gate as one chat conversation** on the canary Prime, scripted as an operator
   would speak it, not as commands. Nine turns: describe the problem → agree a diagnosis → draft a
   skill change → show a semantic diff → assign to canary → run evals → show evidence → approve →
   promote. Then a tenth: *undo it*.
2. **Record every seam where the Prime needed a human to translate.** Each is either a
   `fleet-architecture` gap (fix the skill) or a missing structured field (fix the tool). Expect the
   `--help`-shaped defects found in QA: a tool whose required flag is documented but not marked
   required costs an iteration every time.
3. **A `blocked` decision must carry a blocker** (IMPROVEMENT_POLICY R-8). Cortex correctly declined
   an impossible mission and left the field empty; the terminal handler can only describe what it was
   handed. Enforce at decision validation, where the schema already lives.
4. **Provenance on every authored definition**: which Prime, which conversation, which mission, which
   evidence. Without it, phase C cannot attribute anything and phase B cannot show a card.

**Exit gate.** A transcript in which a Prime performed all ten steps, with the promoted change live on
a canary agent, the rollback exercised, and **no repository source, Foundation file or raw Firestore
record touched**. Verification ladder rung 4; rung 5 if any install destination moved.

**Anti-goal.** Do not add tools in this phase. A missing tool discovered here is a finding, and a
finding that survives the phase is better evidence for building it than a guess made before.

---

## Phase B — The Studio becomes a place you can act (closes G2)

The read half of P6 shipped and its design rule holds: **an unknown must not look like good news.**
Extend it to writing without losing that.

### B1 — Structured proposal cards in chat

The single highest-value item in this plan. Today an approval is free text and the brain interprets
it; approvals have already been mis-scoped across missions once for exactly this reason.

A card is a rendered work object, not a chat message:

```
┌ PROPOSAL  pr-8f2a · from mission w-qa-msw9i7qo
│ Learning    assistant agents cannot create a spreadsheet
│ Evidence    3 blocked missions, 14 days · motor read SKILL.md and confirmed absence
│ Change      skills/workspace-sheets  v4 → v5   (+1 command, +1 procedure)
│ Diff        + sheets-create --title … [--tab] [--folder]     (semantic, not a patch)
│ Target      canary: millie          Risk  low — additive, no existing command altered
│ Evals       not yet run
└ [ Run canary ]  [ Approve rollout ]  [ Reject ]  [ Pause ]  [ Rollback ]
```

Rules that make it a control and not a decoration:

- **Every button is an authenticated control-plane call**, the same endpoint the CLI uses. No
  free-text approval path remains for a card-bearing proposal.
- **Buttons that cannot be honoured are absent, not disabled-with-a-tooltip.** `Approve rollout` does
  not exist before evals have run.
- **The card carries its own coordinates.** Which `fleetRelease`, which `agentSpecDigest`, which
  `platformVersion` it was drafted against — so an approval a day later against a moved Foundation is
  detectable rather than silently applied.
- **Rejection is a first-class outcome with a reason**, and the reason becomes an eval case (phase C),
  not a deleted message.

### B2 — Authoring surfaces

Roles, souls, skills, processes, responsibilities. Each screen edits the **Definition**, never a file:
form → validate → semantic diff → propose. The diff is the product — a raw patch tells an operator
what bytes changed, and the question they actually have is what the agent will now do differently.

Least-effort ordering, by how often the operator needs it: **skills → responsibilities → roles →
processes → souls.** Souls last on purpose: they are organ content, C-28 soft-locked, and the one
place where a bad edit degrades an agent in ways evals are worst at catching.

### B3 — Make drift impossible to miss

Coordinates are already served desired-vs-actual. Surface *divergence* as a state with a duration —
"millie has been 2 releases behind for 6 days" — rather than as two values a reader must compare.
Nobody compares.

**Exit gate.** From one screen an operator answers the seven questions *and* acts on all five verbs.
A proposal raised in chat is approved by clicking, and the resulting release names the human, the
card, and the evidence. Boundary tests still prove deployed Prime cannot write Foundation paths.

---

## Phase C — Outcomes become candidates (closes G3)

Only after A and B. This is the phase that makes the fleet improve without being asked, and therefore
the one where a wrong design compounds instead of failing.

**The signal already exists.** Every mission emits it and nothing reads it:

| Signal | Improvement it implies |
|---|---|
| `blocked` with an articulated reason | a capability or permission gap — the sheets case exactly |
| Repeated tool error, same command, across agents | a skill documents an invocation wrongly |
| Iteration count above the role's baseline | a plan or a procedure is not converging |
| `needs_input` on the same class of ask | a missing project fact or an unclear responsibility |
| False-complete caught by verification | an accept-criterion or a soul discipline problem |
| Human correction in chat | the highest-quality signal there is |

**The rules that keep this safe** — each one is a lesson already paid for:

1. **A signal becomes an eval case, never a prompt edit.** P5 established this and it does not bend.
   A human correction is evidence about one mission; making it a rule is a separate decision.
2. **Three occurrences, or one with an explicit operator confirmation.** One `blocked` is an anecdote.
   `fleet-architecture` already warns against anecdote-driven change; this is that warning with a
   number.
3. **The Prime drafts and evaluates autonomously; it never fleet-promotes.** Canary is autonomous.
   Fleet-wide is a human click, always.
4. **Anything requiring a new connector, IAM class or egress becomes a Platform Finding**, not a
   workaround. The Finding path is the only way out of the Fleet Definition plane and it must stay
   the only way out.
5. **Attribution or it did not happen.** A candidate names the missions it came from. A promoted
   change names the candidate. A regression names the promotion. Without the chain, phase C generates
   changes nobody can reason about — which is worse than no phase C.

**Exit gate.** Replay the worked example with no human in the diagnosis: three blocked sheet missions
produce a candidate, the Prime drafts `sheets-create`, runs it on a canary, and raises a proposal card
with evidence. The human's entire contribution is reading the card and clicking once.

---

## What this plan will not do

- **No new organ.** Authoring is tools plus a skill. An "eyes" or "author" organ duplicates an
  existing organ's job and trips the C-28 soft-lock for nothing — already rejected in ADR-001.
- **No repository write path for a deployed Prime.** Platform changes go through Findings and a human
  maintainer. This is the boundary the whole three-planes architecture exists to draw.
- **No automatic fleet-wide promotion**, at any confidence level, ever.
- **No prompt self-editing.** Signals become eval cases (C-1 above). A system that rewrites its own
  instructions from its own failures has no fixed point to measure against.

## Sequencing note

A is small and mostly diagnostic; it is the phase most likely to be skipped and the one that
determines whether B builds the right screens. B1 (proposal cards) is separable from B2 (authoring
surfaces) and worth shipping alone — it removes the free-text approval path, which is a live
correctness problem, not only a UX one.

Every phase reports against the verification ladder, and every guard added carries the negative test
that proves it fires (IMPROVEMENT_POLICY R-10).
