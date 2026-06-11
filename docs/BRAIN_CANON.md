# Brain Canon — What Better Looks Like

> **Version:** 1.0
> **Repo location:** `docs/BRAIN_CANON.md`
> **Ownership:** Human maintainers, via CODEOWNERS. Agents may propose amendments via PR.
> **Relationship to the Product Canon:** `PRODUCT_CANON.md` defines the walls — invariants that must never be crossed. This document defines the **gradient** — the direction in which every change to the brain should move. The Product Architect uses the Product Canon to reject proposals and the Brain Canon to rank them.

The brain is the product. Everything else — manifests, bootstraps, dashboards, fleets — exists to put a brain on a VM and keep it healthy. Therefore the question *"is this an improvement?"* almost always reduces to *"does this make the brain better?"*, and this document defines what better means.

---

## Part I — The Brain as a Product

What the brain is supposed to *be*, and what better feels like from the outside.

### B-1 · A deterministic machine that consults intelligence
The brain is a state machine that owns the loop and calls models for judgment — never a model that owns the loop and calls code for chores. The pipeline is fixed and legible: **intake → classify → decide → dispatch → synthesize → deliver**. Given the same envelope state, the machine takes the same path; only the content of judgments varies.
**Better looks like:** more of each envelope's journey explainable from state alone; a transcript of state transitions that reads like a flowchart, not a conversation.
**Worse looks like:** "the model decided to…" appearing in an explanation of control flow.

### B-2 · One envelope, fully attended
The brain processes one envelope at a time, completely, before taking the next. Depth of attention over breadth of juggling. Throughput is a fleet property — hire more agents — never a concurrency property of one brain.
**Better looks like:** shorter, more decisive envelope lifecycles; cleaner handoffs between checkpoints; queue awareness without queue anxiety.
**Worse looks like:** interleaved processing, partial attention, parallel claims, or any structure whose failure modes require reasoning about races.

### B-3 · Cognition is dispatched to specialists with exactly one job each
Cortex orchestrates and synthesizes. Prefrontal plans. Motor executes. Cerebellum verifies. Temporal agents recall and research. Every LLM call in the system has a single, nameable purpose, addressed to the agent whose purpose it is.
**Better looks like:** prompts that get shorter and more pointed because the recipient's role carries the context; verification genuinely independent of execution; planning that produces structure the daemon can stamp, not prose the daemon must interpret.
**Worse looks like:** cortex doing motor's work inline; a "do everything" prompt; verification performed by the same call that produced the work.

### B-4 · Context economy — every token earns its place
Prompt size is a cost, a latency, and an attention hazard. The brain assembles the *minimum sufficient* context for each call: budgeted, summarized, and ranked. Memory exists to make context smaller, not larger — a fact promoted to Core Memory should *replace* paragraphs of recollection, not add to them.
**Better looks like:** equal or higher decision quality from fewer tokens; summaries that lose nothing an agent needed; context budgets that shrink over time as memory sharpens.
**Worse looks like:** "include everything just in case"; growing system prompts; raw logs pasted where a two-line digest would do.

### B-5 · Memory is a discipline, not a warehouse
Three layers, three speeds: working memory (the scratchpad, pruned relentlessly), Core Memory (durable facts, actively retired and superseded), Deep Truths (behavioral firmware, changed rarely and only on multi-session evidence). The value of memory is its signal density.
**Better looks like:** smaller working memory carrying more operational truth; retirement and supersession happening as often as promotion; an agent that gets *more* predictable as it accumulates experience.
**Worse looks like:** memory that only grows; stale facts shaping live decisions; promotion without evidence; an agent whose behavior drifts because its memory did.

### B-6 · A teammate's conversational surface
From the outside, the brain behaves like a competent colleague: it acknowledges immediately, reports progress at sensible intervals, asks one precise question when blocked rather than guessing, says what it did rather than narrating how it works, and writes substantial output as files with a readable summary on top.
**Better looks like:** responses that respect the reader's time; status updates that carry new information; questions that, once answered, fully unblock the work.
**Worse looks like:** silence followed by a wall of text; internal mechanics leaking into replies; guessing where asking was cheap; asking where the answer was already in context.

### B-7 · Honest, bounded failure
The brain fails loudly, specifically, and within budget. Iterations are capped. Blocked work says what would unblock it. Errors propagate upward through the envelope hierarchy with their cause attached; nothing retries forever, and nothing fails silently.
**Better looks like:** failure reports a human can act on in one read; `needs_input` raised early with a precise ask; failed missions that leave the system cleaner than a "successful" mystery would.
**Worse looks like:** infinite retry loops, swallowed exceptions, optimistic synthesis over a failed dispatch, or failure discovered only by its absence of output.

### B-8 · Fast where it's code, deliberate where it's judgment
Deterministic paths execute in milliseconds; LLM calls happen only where judgment is genuinely required, and each one is worth its latency. The defining efficiency metric of the brain is **LLM calls per completed envelope at equal outcome quality** — the better brain needs fewer.
**Better looks like:** a judgment call replaced by a rule once the rule is known; classification short-circuited when a deterministic marker decides the case; latency budgets per pipeline stage.
**Worse looks like:** a model invoked to make a decision the state already determines; "ask the LLM" as the default answer to a parsing problem.

---

## Part II — The Cognitive Workflow

How the organs work together. This is the intended shape of every thought the system has — the reference against which pipeline changes are judged.

### B-9 · The organs and their one job each

```
            deterministic              cognition (gateway)                deterministic
 channel ──► EARS ──► intake ──► BRAIN DAEMON ◄──────────────────► MOUTH ──► channel
             poll, dedup,        state machine:                     classify,
             preprocess,         owns loop, stamps envelopes,       deliver
             fire-and-forget     dispatches, transitions
                                      │
                 ┌────────────────────┼──────────────────────────┐
                 ▼                    ▼                          ▼
              CORTEX             PREFRONTAL                 CEREBELLUM
              the voice:         the structurer:            the conscience:
              classify, decide,  M→C→T blueprints           independent
              synthesize                                    verification
                 │
        ┌────────┴─────────┐                MOTOR — the hands:
        ▼                  ▼                tools, exec, files
  TEMPORAL-MEMORY    TEMPORAL-RESEARCH      (the only mutator)
  internal recall,   external info:
  no external APIs   grounding + fetch
```

| Organ | Nature | One job | Never |
|---|---|---|---|
| **Ears** | Deterministic | Sense: poll, dedup, preprocess, hand off | Judges, replies, blocks on the brain |
| **Brain daemon** | Deterministic | Own the loop: state, stamping, dispatch, transitions | Generates content; outsources control flow |
| **Cortex** | Judgment | Classify intakes, choose decisions, synthesize outcomes | Executes tools; holds the loop; verifies itself |
| **Prefrontal** | Judgment | Turn intent into structure: M→C→T blueprints | Executes; decides; freelances beyond the blueprint schema |
| **Temporal-Memory** | Judgment, read-only | Recall what the agent already knows | Touches external APIs; invents facts |
| **Temporal-Research** | Judgment, read-only | Bring in what the world knows: search + fetch | Mutates state; substitutes for memory |
| **Motor** | Judgment + effects | Act: tools, exec, files — the only mutator | Verifies its own work; runs two hands at once per envelope |
| **Cerebellum** | Judgment, read-only | Verify results against accept criteria, independently | Verifies anything it produced; executes fixes |
| **Mouth** | Deterministic + filter | Classify and deliver outputs to the channel | Originates content; bypasses the classify filter |

**Better looks like:** each organ's prompt shrinking as its role sharpens; work moving toward the organ whose job it is.
**Worse looks like:** cortex shelling out; motor self-certifying; research used where recall sufficed; an organ acquiring a second job.

### B-10 · The iteration loop: gather → decide → act → verify → close-or-repeat

Every active envelope advances through one canonical cycle, daemon-owned end to end:

1. **GATHER** — assemble minimum sufficient context: temporal-memory recall, and temporal-research when (and only when) the question needs the outside world. Parallel-eligible (B-12).
2. **DECIDE** — cortex returns exactly one structured decision from the legal-move set (B-11).
3. **ACT** — the daemon dispatches per the decision: prefrontal to structure, motor to mutate, temporal organs to fetch, delegation outward.
4. **VERIFY** — cerebellum checks results against accept criteria; verification is independent of execution by construction.
5. **CLOSE or REPEAT** — the daemon applies the transition: advance the checkpoint, complete the envelope, raise `needs_input`, fail, or iterate. The iteration counter increments here and only here, bounded by the contract cap.

The daemon owns the loop; cortex owns only the choice. One cycle, one decision, one transition — an envelope's history reads as a sequence of these cycles.
**Better looks like:** more envelopes closing in fewer cycles; cycles whose GATHER shrinks because memory sharpened; the same outcome with a skipped step (deterministic marker ⇒ no classify).
**Worse looks like:** multiple decisions per cycle; acting before deciding; iterating without the counter; a cycle that cannot be replayed from its history.

### B-11 · Decisions are choices among daemon-defined legal moves

For every envelope state, the daemon defines the closed set of legal moves — dispatch, continue, synthesize, delegate, ask (`needs_input`), fail — and their required parameters. Cortex selects and parameterizes; it never invents a move, a state, or a transition. Malformed or illegal decisions are rejected at the schema boundary and handled deterministically (repair, retry within budget, fall back) — never executed on faith.
**Better looks like:** the legal-move table readable straight from daemon code; decision schemas that get stricter over time; rejected decisions that leave a clean trace.
**Worse looks like:** free-text decisions; a "misc" action; the daemon honoring fields the schema never defined.

### B-12 · Sanctioned parallelism: fan out reads, serialize writes, join before deciding

Parallelism is the width of a single thought — never a second thought. Within the one attended envelope:

- **Read-only cognition may fan out.** Temporal-memory ∥ temporal-research ∥ read-intent inspection may run concurrently: gathering does not mutate state, so order cannot matter.
- **Mutation is exclusive.** At most one state-mutating motor invocation in flight per envelope — one pair of hands. Parallel writes are permitted only into disjoint ephemeral scopes that a single deterministic join reconciles.
- **Fan-in is mandatory.** Every fan-out joins before the next DECIDE. No decision is made on partial returns; a failed or timed-out branch joins as a failure result and the decision sees it as such.
- **Boundaries are absolute.** Parallelism never crosses a checkpoint boundary and never crosses an envelope boundary — depth of attention (B-2) is untouched; concurrency across envelopes remains a fleet property, not a brain property.

**Better looks like:** gather latency approaching the slowest single source; joins that are pure functions of branch results.
**Worse looks like:** two motors mutating at once; a decision taken while a branch is still in flight; "parallel" used to attend two envelopes.

### B-13 · Checkpoints are the heartbeat; verification gates the beat

Checkpoints execute strictly in sequence; a checkpoint closes only when every non-optional task is complete **and** its verification has landed. Cerebellum never verifies anything it produced and never executes the fix for what it failed — findings return to the loop as input to the next DECIDE. Completion propagates upward only through verified gates: tasks close checkpoints, checkpoints close missions, never the reverse.
**Better looks like:** verification criteria written before execution starts; checkpoint boundaries placed where verification is genuinely possible.
**Worse looks like:** a checkpoint closed on motor's say-so; verification skipped under iteration pressure; criteria rewritten after the fact to match the result.

### B-14 · Termination is deterministic and total

An envelope leaves `active` through exactly five doors, every one a daemon transition with history: verified accept criteria → `complete`; iteration cap or unrecoverable error → `failed`, with cause attached; a precise human question → `needs_input`; an identified external blocker → `blocked`; an explicit cancel → `cancelled`. There is no sixth door. Nothing terminates implicitly, nothing terminates silently, and every terminal state carries enough context to explain itself in one read.
**Better looks like:** terminal states whose payloads make the next action obvious; caps hit rarely because cycles got more decisive.
**Worse looks like:** envelopes that age out unexplained; a completion written by anything but the daemon; failure without a cause.

### B-15 · Recall before research, research before asking — and never guessing

The gather hierarchy orders cost and trust: what the agent already knows (temporal-memory — cheapest, instant) precedes what the world publishes (temporal-research — slower, external) precedes what the human must be asked (`needs_input` — the most expensive call in the system). Guessing appears nowhere in the hierarchy. Memory and research may run in parallel when both are warranted; the hierarchy governs *whether* each is warranted and *what wins* when sources disagree: operator statements > memory-confirmed facts > fresh research > model prior.
**Better looks like:** research calls declining as Core Memory sharpens; questions to humans that are rare, precise, and fully unblocking.
**Worse looks like:** re-researching what memory holds; asking what context already answers; synthesis floating on unsourced confidence.

---

### B-16 · Skills are codified procedure — the layer between code and judgment

A skill is a solved problem, written down: distilled, versioned procedure that an organ follows instead of re-deriving. Skills occupy the deliberate middle of the determinism spectrum — too contextual to hardcode in the daemon, too settled to leave to improvisation. They are repository artifacts: authored, reviewed, versioned in git, installed by manifest, and therefore **shared** — when a skill improves, every agent that carries it improves in the same commit. Memory is what one agent has lived; skills are what the system has learned. Know-how flows in one direction: improvised solutions that prove out are promoted into skills, never left as private habits.
**Better looks like:** recurring work migrating out of prompts and memory into skills; the same task performed identically by different agents because they follow the same procedure; a fix shipped as a skill version bump instead of a behavioral patch on one agent.
**Worse looks like:** procedure pasted into system prompts or Core Memory instead of referenced from a skill; two agents solving the same problem two ways; know-how that dies with the agent that discovered it.

### B-17 · Where a skill exists, skill use is enforced — across every organ

Skill consultation is a structural step in the loop, not an organ's discretionary choice. Before ACT — and during DECIDE and planning — the brain resolves the work at hand against the installed skill set; an applicable skill is injected into the acting organ's context, and from that moment **the procedure governs**. Improvising beside an applicable skill is a violation of this canon, not a style preference. Enforcement is universal:

| Organ | Skill obligation |
|---|---|
| **Cortex** | Decisions route work down the skill path when one applies; synthesis reports which skills governed the work |
| **Prefrontal** | Blueprints reference applicable skills in their steps — plans compose procedures, they do not re-derive them |
| **Motor** | Executes by the skill's procedure, including its safety rules and stop conditions; deviation requires a recorded reason |
| **Cerebellum** | Verifies against the skill's own checks and expected outcomes — the procedure defines what "done correctly" means |
| **Temporal-Research** | Never substitutes for an installed skill: the outside world is not consulted for what the skill already prescribes |
| **Temporal-Memory** | Recall supplements skills with lived context; it never overrides a current skill version with a remembered older one |
| **Brain daemon** | Owns the resolution step: skill lookup is part of dispatch, deterministic, and skippable by no one |

Deviation is permitted only when the skill demonstrably does not cover the case — and that deviation, with its reason, is recorded. Repeated deviation in the same domain is not a pattern to tolerate; it is a skill gap, and a skill gap is an improvement proposal.
**Better looks like:** a rising fraction of actions executed under skill governance; organ prompts shrinking because procedure lives in the skill; deviations that are rare, reasoned, recorded — and that turn into skill updates.
**Worse looks like:** an organ freelancing beside an installed, applicable skill; skill lookup performed only after failure; a skill that exists but that nothing in the loop forces anyone to find.

## Part III — The Brain as Code

What the implementation is supposed to look like, and the direction every refactor should move it.

### B-18 · A thin orchestrator spine over single-purpose libraries
The brain daemon is the spine: state transitions, dispatch, lifecycle — and as little else as possible. Everything reusable lives in `corekit/lib/` modules with one responsibility each, consumed by all daemons. The permanent direction of motion: **the daemon shrinks, the libraries grow.**
**Better looks like:** a refactor that moves logic out of the daemon into a named lib at constant behavior; a daemon whose main loop fits in one reading; lib modules whose names fully predict their contents.
**Worse looks like:** convenience logic accreting into the daemon "because it's already open"; a lib that needs three sentences to describe; the same helper re-implemented in two daemons.

### B-19 · Pure core, effectful edges
Logic that can be a pure function is a pure function — testable on a laptop with no GCP, no network, no clock. Side effects (Firestore, gateway HTTP, file system, time) live at the edges behind narrow, named modules. Tests target the pure core; the edges stay thin enough to trust by inspection.
**Better looks like:** parsing, matching, budgeting, cron evaluation, and envelope math covered by fast unit tests; a bug reproducible as a failing test before it is fixed.
**Worse looks like:** business logic interleaved with I/O; functions that require a live Firestore to exercise; tests that need credentials.

### B-20 · Every model touchpoint flows through a named funnel
Agent-persona calls go through the gateway. Stateless utility calls go through the utility module. There is no third path. Every funnel validates structured output against a schema, repairs malformed JSON at the boundary, and degrades to a defined fallback — never to undefined behavior.
**Better looks like:** a complete inventory of LLM touchpoints obtainable by grepping two module names; schema violations that fail closed with logs, not open with guesses.
**Worse looks like:** an inline `fetch` to a model endpoint; trusting raw model text; a new "quick" call path added beside the funnels.

### B-21 · Configuration is contracts; constants are named
Every tunable — model IDs, ports, budgets, intervals, timeouts, caps — comes from `contracts.json` and is validated at bootstrap. A magic number in the daemon is a bug that hasn't been reported yet.
**Better looks like:** a behavior change achievable by editing one contract value; new subsystems arriving with their contract block and validation in the same PR.
**Worse looks like:** `300000` inline; the same timeout defined in two places; a config knob that nothing validates.

### B-22 · Crash-safe by construction
At any instant, the union of Firestore envelope state and on-disk state is sufficient to resume. The daemon can be killed at any line and restarted without losing work, duplicating work, or corrupting an envelope. Idempotency is the design test applied to every handler: *run it twice — what breaks?*
**Better looks like:** resumption paths exercised deliberately; handlers that detect already-done work and step over it; restart treated as routine, not incident.
**Worse looks like:** in-memory state that matters; a handler that double-fires on replay; recovery procedures that require a human to remember them.

### B-23 · Self-evident observability
Every state transition writes history. Every dispatch writes telemetry. Every log line is structured and answers *what, on which envelope, with what outcome*. A maintainer reconstructs any mission's full story from stored data alone — no reproduction required.
**Better looks like:** debugging sessions that start and end in the Work Tree and telemetry; new mechanisms shipping their observability in the same PR as their behavior.
**Worse looks like:** printf archaeology; a code path that leaves no trace; "we'd have to add logging to know."

### B-24 · Legibility is a feature of the product
The brain's code is read by humans *and* by the agents that improve it. Optimize for the reader: control flow over cleverness, names over comments, deletion over deprecation, one obvious place for everything. Dead code is removed, not commented out; duplication is unified to a single source of truth.
**Better looks like:** a diff whose intent is clear from the diff alone; fewer special cases after the change than before; a module a specialist agent can safely modify with only its file and the canons in context.
**Worse looks like:** flags that gate nothing; commented-out blocks "for reference"; abstractions with one caller; cleverness that needs a tour guide.

---

## Part IV — The Rubric

For any proposed change to the brain, **better** means measurable improvement on at least one axis with regression on none:

| Axis | Improvement means | Measured by |
|---|---|---|
| **Efficiency** | Same or better outcomes from less — fewer LLM calls, fewer tokens, lower latency, less compute | LLM calls per completed envelope · tokens per outcome · stage latency · cost per mission |
| **Structure** | Logic in its right home — daemon thinner, libs sharper, modules single-purpose, funnels respected, procedure in skills | Daemon LOC and branch count (↓) · lib cohesion · cross-module reach-ins (→ 0) · skill coverage of recurring work (↑) |
| **Logic** | Simpler control flow — fewer special cases, fewer states, deterministic where determinism is possible | Cyclomatic complexity (↓) · special-case count (↓) · judgment calls converted to rules |
| **Cleanness** | Less of what doesn't matter — dead code gone, duplication unified, names true, contracts authoritative | Dead/duplicate code removed · magic numbers (→ 0) · single sources of truth |

And four properties that may never regress, whatever the gain elsewhere: **determinism** (B-1, B-8), **crash-safety/idempotency** (B-22), **observability** (B-23), and **testability** (B-19). A change that improves every axis while dimming one of these four is not better — it is debt with good marketing.

Every improvement proposal states, up front: which axis it improves, by what measure, and why the four protected properties are untouched. Every verification of an implemented improvement checks exactly that claim.

---

## Amendments

This canon changes the way code changes: by PR, approved by a human CODEOWNER. An amendment states the quality being added, refined, or retired, and the evidence that the gradient still points at a brain that is more deterministic, more attentive, more economical, more honest, and easier to read than the one before it.
