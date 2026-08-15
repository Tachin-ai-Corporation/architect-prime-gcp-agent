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
Cortex orchestrates and synthesizes. Prefrontal plans. Motor executes. Cerebellum verifies. Temporal-Memory curates the agent's memory — recall and consolidation are two modes of one job (retrieve, record), not two jobs — and Temporal-Research brings in the world. Every LLM call in the system has a single, nameable purpose, addressed to the agent whose purpose it is, and **each organ owns and executes the skills of its one job** — across the board: the memory skills are Temporal-Memory's to run, just as the docs/drive skills are Motor's.
**Better looks like:** prompts that get shorter and more pointed because the recipient's role carries the context; verification genuinely independent of execution; planning that produces structure the daemon can stamp, not prose the daemon must interpret.
**Worse looks like:** cortex doing motor's work inline; a "do everything" prompt; verification performed by the same call that produced the work.

### B-4 · Context economy — every token earns its place
Prompt size is a cost, a latency, and an attention hazard. The brain assembles the *minimum sufficient* context for each call: budgeted, summarized, and ranked. Memory exists to make context smaller, not larger — a fact promoted to Core Memory should *replace* paragraphs of recollection, not add to them.
**Better looks like:** equal or higher decision quality from fewer tokens; summaries that lose nothing an agent needed; context budgets that shrink over time as memory sharpens.
**Worse looks like:** "include everything just in case"; growing system prompts; raw logs pasted where a two-line digest would do.

### B-5 · Memory is a discipline, not a warehouse
Three layers, three speeds: working memory (the scratchpad, pruned relentlessly), Core Memory (durable facts, actively retired and superseded), Deep Truths (behavioral firmware, changed rarely and only on multi-session evidence). The value of memory is its signal density — achieved by **weighting memory by value**: record the high-value learnings, retire the rest, and surface the best first. **Temporal-Memory owns this discipline** for the whole brain — the single organ that records, reconciles, and ranks memory so every other organ receives the good stuff, pruned. The live conversation is none of these layers — it is deterministic context (B-32), present while the transcript holds it and persisted only through the same consolidation gate as everything else.
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
               the voice:         the analyst:               the conscience:
               classify,          decompose & assess         independent
               commit the plan,   → the Brief                verification
               synthesize
                 │
        ┌────────┴─────────┐                MOTOR — the hands:
        ▼                  ▼                tools, exec, files
  TEMPORAL-MEMORY    TEMPORAL-RESEARCH      (the only mutator
  memory authority   external info:          of external state)
  recall + record    grounding + fetch
```

| Organ | Nature | One job | Never |
|---|---|---|---|
| **Ears** | Deterministic | Sense: poll, dedup, preprocess, hand off | Judges, replies, blocks on the brain |
| **Brain daemon** | Deterministic | Own the loop: state, stamping, dispatch, transitions | Generates content; outsources control flow |
| **Cortex** | Judgment | Classify intakes, commit the plan from the Brief, synthesize outcomes | Executes tools; holds the loop; verifies itself |
| **Prefrontal** | Judgment | Decompose and assess execution-bound work into a Brief | Executes; commits or selects a move; judges the turn as simple or complex; freelances beyond the Brief schema |
| **Temporal-Memory** | Judgment + memory-scoped effects | Curate the agent's memory: recall high-value knowledge on demand; record & reconcile it in consolidation (one job, two modes) | Reaches beyond memory — web (Research), arbitrary/Workspace mutation (Motor); invents facts |
| **Temporal-Research** | Judgment, read-only | Bring in what the world knows: search + fetch | Mutates state; substitutes for memory |
| **Motor** | Judgment + effects | Act: tools, exec, files — the only mutator of external/world state | Verifies its own work; runs two hands at once per envelope; sends messages or communicates with agents/humans — outbound is the mouth's alone (C-27) |
| **Cerebellum** | Judgment, read-only | Verify results against accept criteria, independently | Verifies anything it produced; executes fixes |
| **Mouth** | Deterministic + filter | Classify and deliver outputs to the channel — the sole outbound egress (C-27) | Originates content; bypasses the classify filter; is bypassed by any other outbound path |

**Better looks like:** each organ's prompt shrinking as its role sharpens; work moving toward the organ whose job it is.
**Worse looks like:** cortex shelling out; motor self-certifying; research used where recall sufficed; an organ acquiring a second job.

### B-10 · The iteration loop: gather → analyze → decide → act → verify → close-or-repeat

Every active envelope advances through one canonical cycle, daemon-owned end to end:

1. **GATHER** — assemble minimum sufficient context: temporal-memory recall, and temporal-research when (and only when) the question needs the outside world. Parallel-eligible (B-12).
2. **ANALYZE** — for any intake that requires execution, prefrontal decomposes the work into a **Brief**: the work broken into its true parts, each annotated with its nature (local or a teammate's specialty), its risk, its dependencies, its unknowns, and any matching stored process. Analysis is unconditional for work and judges nothing about the turn as a whole — it is the step that reveals the work's shape. Prefrontal proposes; it does not commit a move.
3. **DECIDE** — cortex commits exactly one plan from the legal-move set (B-11), assembling the Brief's parts into an ordered set of typed steps: local execution, delegation, approval gate, ask (a recalled process narrative may inform the plan as a prior, but is never itself a dispatched step).
4. **ACT** — the daemon dispatches per step: motor to mutate, temporal organs to fetch, delegation outward, approval gates to the operator.
5. **VERIFY** — cerebellum checks results against accept criteria; verification is independent of execution by construction.
6. **CLOSE or REPEAT** — the daemon applies the transition: advance the checkpoint, complete the envelope, raise `needs_input`, fail, or iterate. The iteration counter increments here and only here, bounded by the contract cap.

The daemon owns the loop; prefrontal owns the decomposition; cortex owns the commitment. One cycle, one plan, one transition — an envelope's history reads as a sequence of these cycles.
**Better looks like:** more envelopes closing in fewer cycles; cycles whose GATHER shrinks because memory sharpened; the same outcome with a skipped step (deterministic marker ⇒ no classify).
**Worse looks like:** multiple decisions per cycle; acting before deciding; iterating without the counter; a cycle that cannot be replayed from its history.

### B-11 · Decisions are choices among daemon-defined legal moves

For every envelope state, the daemon defines the closed set of legal moves — dispatch, continue, synthesize, **delegate** (via output envelope → Mouth delivery, never direct chat-send; the durable coordination record is the shared work envelope — C-27), ask (`needs_input`), **wait** (a duration-bounded pause; see B-27), fail — and their required parameters. Cortex selects and parameterizes; it never invents a move, a state, or a transition. Malformed or illegal decisions are rejected at the schema boundary and handled deterministically (repair, retry within budget, fall back) — never executed on faith. The legal-move set is enforced structurally: the `decide` output schema enum and the deterministic validator are the single source of which moves exist — a move wired into the dispatch table but absent from the schema is unreachable.
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

An envelope leaves `active` through exactly six doors, every one a daemon transition with history: verified accept criteria → `complete`; iteration cap or unrecoverable error → `failed`, with cause attached; a precise human question → `needs_input`; an identified external blocker → `blocked`; an explicit cancel → `cancelled`; or a duration-bounded pause → `waiting`. There is no seventh door. Nothing terminates implicitly, nothing terminates silently, and every terminal state carries enough context to explain itself in one read.
**Better looks like:** terminal states whose payloads make the next action obvious; caps hit rarely because cycles got more decisive.
**Worse looks like:** envelopes that age out unexplained; a completion written by anything but the daemon; failure without a cause.

### B-15 · Recall before research, research before asking — and never guessing

The gather hierarchy orders cost and trust: what the agent already knows (temporal-memory — cheapest, instant) precedes what the world publishes (temporal-research — slower, external) precedes what the human must be asked (`needs_input` — the most expensive call in the system). Guessing appears nowhere in the hierarchy. Memory and research may run in parallel when both are warranted; the hierarchy governs *whether* each is warranted and *what wins* when sources disagree: operator statements > memory-confirmed facts > fresh research > model prior. Episodic recall — querying the agent's own work ledger by cue-driven search — is part of the recall tier, not a fourth consolidated memory layer. The work ledger serves as a retrieval mechanism over the system's audit trail (B-23), and facts surfaced from it are promoted into Core Memory through the normal triage process (B-5 preserved). Recall depth is proportional to stakes: the ambient pass that precedes classification is deterministic candidate assembly only — working memory and Core Memory, no work-ledger queries, no synthesis — while the full ladder (episodic search, digest, temporal-memory synthesis) is spent only once the turn is known to be mission-bound; a greeting never buys a research budget.

**Better looks like:** research calls declining as Core Memory sharpens; questions to humans that are rare, precise, and fully unblocking; episodic hits from the work ledger reinforcing recall without growing a separate memory store.
**Worse looks like:** re-researching what memory holds; asking what context already answers; synthesis floating on unsourced confidence; the work ledger accumulating without ever feeding back into Core Memory promotion.

---

### B-16 · Skills are codified procedure — the layer between code and judgment

A skill is a solved problem, written down: distilled, versioned procedure that an organ follows instead of re-deriving. Skills occupy the deliberate middle of the determinism spectrum — too contextual to hardcode in the daemon, too settled to leave to improvisation. They are repository artifacts: authored, reviewed, versioned in git, installed by manifest, and therefore **shared** — when a skill improves, every agent that carries it improves in the same commit. A skill may contain tool documentation, usage references, and links to the corekit scripts it governs — tools live inside the skill that teaches their use, not as undocumented standalone scripts. Memory is what one agent has lived; skills are what the system has learned. A skill's sibling is the **process** (`docs/primitives/05-PROCESS.md`): a skill teaches **HOW to drive a tool** — tool syntax, flags, generic procedure; a process narrates **WHAT has worked for a recurring kind of work** — a contextual pattern carrying no tool syntax, which the agent *recalls into its own plan* rather than executes. Skills are shipped by the repo and improve in a commit; processes are captured and evolved by the agents themselves. Know-how flows in one direction: improvised solutions that prove out are promoted into skills, never left as private habits.
**Better looks like:** recurring work migrating out of prompts and memory into skills; the same task performed identically by different agents because they follow the same procedure; a fix shipped as a skill version bump instead of a behavioral patch on one agent; tools documented within their governing skill.
**Worse looks like:** procedure pasted into system prompts or Core Memory instead of referenced from a skill; two agents solving the same problem two ways; know-how that dies with the agent that discovered it; a corekit tool that exists without a skill documenting its usage.

**The daemon boundary:** Daemon functions — tools, modules, and capabilities that exist to run the pipeline itself — are invisible to brain agents. Brain agents discover tools exclusively through installed skills; the `runCommand` surface exposes nothing that a skill does not govern. A daemon tool appearing in a brain agent's context is a B-16 violation: it invites improvisation where procedure should govern, and couples agents to implementation details they must not depend on.

**The five layers of a complete skill:** A skill's SKILL.md serves five distinct moments in the organ's execution. Not every skill needs all five — a single-command skill needs Layers 1–2 and an error table; a multi-command workflow skill needs all five.

| Layer | Name | What it contains | When the organ reads it |
|-------|------|-----------------|------------------------|
| 1 | **Header** | What the skill does, when to use it | Before deciding whether to read further |
| 2 | **Command Reference** | Exact syntax: command name, arguments, flags, output format | Before the first tool call |
| 3 | **Procedures** | Multi-step workflows for the 3–5 most common tasks | Instead of reasoning from scratch on the 80% case |
| 4 | **Error Recovery** | Failure-mode table: symptom → cause → recovery action | When a command fails, instead of retrying blindly |
| 5 | **Examples** | 2–3 concrete task→tool-sequence→output pairs | To anchor chain-of-thought on a known-good pattern |

A skill with only Layers 1–2 is a reference manual — it tells the organ what tools exist but not how to use them for real work. A skill with Layers 1–5 is a training program — it teaches the organ the procedure, the failure modes, and the patterns that experienced practitioners follow. The difference is measurable: per-skill telemetry (success rate, stuck rate, tool count) distinguishes reference-manual skills from training-program skills. The goal is for every high-traffic skill to reach Layer 4 or 5.

See `docs/primitives/08-SKILL.md` for the full primitive definition and `docs/guides/SKILL_STANDARD.md` for the completeness grading criteria.


### B-17 · Where a skill exists, skill use is enforced — across every organ

Skill consultation is a structural step in the loop, not an organ's discretionary choice. Before ACT — and during DECIDE and planning — the brain resolves the work at hand against the installed skill set; an applicable skill is injected into the acting organ's context, and from that moment **the procedure governs**. Improvising beside an applicable skill is a violation of this canon, not a style preference. Enforcement is universal:

| Organ | Skill obligation |
|---|---|
| **Cortex** | Decisions route work down the skill path when one applies; references skills by name in dispatch instructions — never embeds tool syntax in decisions or SOUL docs; synthesis reports which skills governed the work |
| **Prefrontal** | Blueprints reference applicable skills in their steps — plans compose procedures, they do not re-derive them |
| **Motor** | Executes by the skill's procedure, including its safety rules and stop conditions; deviation requires a recorded reason |
| **Cerebellum** | Verifies against the skill's own checks and expected outcomes — the procedure defines what "done correctly" means |
| **Temporal-Research** | Never substitutes for an installed skill: the outside world is not consulted for what the skill already prescribes |
| **Temporal-Memory** | Owns and executes the memory skills — recall (retrieval strategy) and consolidation (recording) — for the whole brain; recall supplements other skills with lived context and never overrides a current skill version with a remembered older one |
| **Brain daemon** | Owns the resolution step: skill lookup is part of dispatch, deterministic, and skippable by no one |

Deviation is permitted only when the skill demonstrably does not cover the case — and that deviation, with its reason, is recorded. Repeated deviation in the same domain is not a pattern to tolerate; it is a skill gap, and a skill gap is an improvement proposal. Specific tool syntax — command names, argument formats, flag values — lives exclusively in skill documents, never in SOUL files, IDENTITY files, or workspace documentation. SOUL files teach cognitive patterns; skills teach procedures.
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

### B-25 · The Outcome Contract
Every mission carries an immutable `accept_criteria` field, pinned at activation.
Delegator criteria propagate verbatim. Self-originated criteria are derived by
the classify phase. The synthesize action is a *proposal of completion*; an
independent cerebellum pass verifies it against the pinned criteria before the
envelope closes. Transport carries references, not full output — the
`work-output-read` atom provides deterministic recovery.

This canon changes the way code changes: by PR, approved by a human CODEOWNER. An amendment states the quality being added, refined, or retired, and the evidence that the gradient still points at a brain that is more deterministic, more attentive, more economical, more honest, and easier to read than the one before it.

### B-26 · Prime Unbound — cognitively broad, structurally bounded
The Prime agent is the deployment's **Fleet Architect and Operator**. It interacts only with the sys-admin through the dashboard, which is what makes broad system-level power safe to carry: a real shell, cloud administration, and the ability to write and run scripts. Its value is resourcefulness — solving open problems in its domain without a pre-authored command for every case.

What it is unbound *from* is rigid command sets, not the Foundation boundary. Prime authors what this deployment's agents **are** — roles, soul overlays, declarative skills, playbooks, responsibilities, policies — through the Fleet Definition lifecycle, and operates the fleet through lifecycle APIs. It does not author **how the product works**: schemas, state machines, providers, installers and security boundaries change through a platform release by human maintainers, and Prime holds no credential that could push to the product repository (C-34). A genuine platform need becomes a Platform Finding.

The two halves are one design, not a compromise. Prime's *character* is fully authorable and its reasoning deliberately unconstrained precisely because its *mechanism* is structurally out of reach — content it authors cannot grant itself power it was not given (C-33, B-36). Narrow the cognition and you get a button-pusher; narrow nothing and you get drift. The wall goes in exactly one place.
**Better looks like:** a failure pattern fixed as a validated, canaried, reversible definition change with the rollback target named before promotion; a platform gap escalated as a reproducible finding rather than worked around by widening an agent's raw reach.
**Worse looks like:** deployment-specific learning arriving as a pull request against the generic repository; a hand-patched file under the installed platform root; a promotion nobody can undo in one command.

### B-27 · Timed waits are daemon-owned; the model never sleeps
A brain may pause an in-flight mission for a bounded duration via the `wait` action, and
resume automatically. The pause is a `waiting` envelope state (B-14) carrying a
`wait_resume_at` timestamp and a `resume_instruction`; the daemon poll loop
(`checkWaitingEnvelopes`) owns resumption, re-queuing the envelope when the clock elapses
and surfacing the instruction via `context_forward`. The LLM never sleeps, polls, or
busy-waits — it emits one decision and yields. Waits are bounded by `contracts.json`
(`wait_min_minutes`/`wait_max_minutes`); anything longer or recurring is a Responsibility,
not a wait. Suspension does not count against the iteration budget.
**Better looks like:** a mission that pauses for deployment settle time and resumes on its
own with the intended next step, no tokens burned mid-wait.
**Worse looks like:** an LLM told to "wait" by looping tool calls or sleeping inside a
command; an in-process timer that dies on daemon restart; unbounded waits; the resume clock
stored anywhere but the envelope.

### B-28 · Verification is re-derivation, not recognition
"Sounds right" is the pattern-matcher voting on surface features; it is how confident
wrong answers pass. A claim is verified only by rebuilding it from ground truth via a
path that does not share the original's assumptions: recompute by a different route,
run the code, locate the exact source, construct the counterexample. The tool log is
ground truth over any narrative. Where in-band re-derivation is impossible, cerebellum
requests a **verification probe** — a fresh motor session given only the claim and the
probe instruction, never the original transcript — and the daemon owns the dispatch,
the context stripping, and the single re-verdict round. Probe depth follows stakes:
routine work gets evidence-checking; consequential and irreversible work gets
re-derivation.
**Better looks like:** two independent paths agreeing; a probe that overturns a fluent
claim before it ships.
**Worse looks like:** a PASS justified by plausibility; a verifier that reads only what
the executor wrote; probes burned on trivia while the kill-shot claim rides through
unexamined.

### B-29 · Every claim carries its epistemic bin
Three bins, claim-level, visible end-to-end: **verified** (checked; the check can be
shown), **inferred** (follows from verified claims by stated reasoning), **assumed**
(needed to proceed; not checked). A blanket disclaimer launders guesses into the same
currency as facts and is forbidden. Bins ride the envelope from motor output through
verification into synthesis and delivery; surviving assumptions surface at the top of
the risk section, never a footnote. The vocabulary is constant everywhere: "confirmed,"
"likely, because X," "assumption — verify before relying." An honest `assumed` label is
never a verification failure; an unlabeled guess always is.
**Better looks like:** a reader who can discount exactly what the writer couldn't check.
**Worse looks like:** a number in a table reading as fact regardless of pedigree;
unlabeled uncertainty becoming someone else's unearned confidence.

### B-30 · Answer, then reasoning, then risk — that order, always
Delivered output leads with the answer in actionable form; then the compressed
load-bearing chain a checker would need; then risk — what would change the answer, the
labeled assumptions, what to check before acting. Hedges are information and live in
the risk section where they can be acted on, never smeared across the answer as
qualifiers. Scale to stakes: one line each for a lookup, full treatment for anything
signed. The first line must be safe to act on alone, or carry its own warning in the
same breath.
**Better looks like:** a reader who acts correctly having read only three lines.
**Worse looks like:** the mystery-novel synthesis; the naked answer whose risks are
discovered in production.

### B-31 · The impostor test
Named anti-patterns that photograph as competence and fail under load, run against
every substantial output: fluency-as-accuracy · comprehensiveness-as-rigor ·
speed-as-capability · hedging-as-calibration · precision-as-accuracy ·
citation-as-verification · agreement-as-helpfulness · structure-as-thought ·
activity-as-progress. Each organ owns the counters for the impostors it is positioned
to catch (the registry with counters lives in `docs/guides/EPISTEMIC_DISCIPLINE.md`).
Two are load-bearing enough to state here: output precision matches the coarsest
input, and every action must move a belief or it is theater.
**Better looks like:** the passage that came out easiest getting audited hardest.
**Worse looks like:** review passing the costume because review is what the costume is
dressed for.

### B-32 · The conversation is deterministic context, not memory

The recent conversation is sliding-window situational context, never represented as agent memory. The deterministic daemons assemble it from the channel's durable transcript — directly, or through the prime-scoped **thread ledger** that caches that transcript per (channel, thread) key — trim it to a character budget, and inject it as a structured turn transcript at exactly four points: intake, classify, decide, and delivery voicing. The ledger is a rebuildable cache, upserted idempotently by the deterministic daemons (brain at intake claim, ears as channel backfill, mouth at delivery); it is never authored, fetched, or queried by a cognitive organ — organs operate within the situational context constructed for them by the harness. When a thread outgrows its window, the daemon — on a code-triggered threshold, never a model decision — compacts the overflow into a labeled thread summary via one stateless utility call; the summary is thread-scoped context that rides the same injection points, ranks below operator statements and memory-confirmed facts (B-15), and enters memory only through the B-5 consolidation gate — never promoted as-is. Sub-agent dispatches do not inherit the conversation (B-4): motor receives instructions, not chatter — and verification never sees it (B-28). In multi-channel environments (such as Google Chat), the transport adapter (ears) still serializes thread-scoped context onto the intake document at poll-time; the ledger accumulates what the poll window would otherwise forget.
**Better looks like:** organs focusing purely on decision-making and execution using the provided context; thread continuity that survives beyond the channel's poll window; a voice grounded on the thread as it is at delivery time; a clean separation between conversational context and long-term memory.
**Worse looks like:** cognitive organs fetching Firestore message collections directly; a thread summary auto-promoted to MEMORY.md; the model deciding when to compact; a voicing call grounded on a snapshot older than the thread it speaks into.

### B-33 · One outbound funnel

Every token an agent emits to the outside world exits through the mouth's classify-and-deliver funnel, exactly as every model touchpoint flows through the gateway/utility funnel (B-20). The mouth holds the channel credentials and owns the send primitive; other organs request a send by producing an output envelope with a delivery address, never by delivering. This is the brain-side mirror of the product wall C-27 — where B-20 funnels what comes *in* from the model, B-33 funnels what goes *out* to the world.
**Better looks like:** an agent's complete outbound-send inventory obtainable by grepping one delivery path; delegation, operator-notify, and any future email sharing that path; the send primitive importable only by the mouth process.
**Worse looks like:** a second send path added beside the mouth "just for pings" or "just for email"; a marker delivered verbatim around the classify filter; a motor that reaches a channel API directly.

### B-34 · Failures inform; they never foreclose
A past failure is a time- and condition-bound episode that carries a lesson — the recurring obstacle and what to try differently — never a verdict on what is possible. Tools, code, and skills change between attempts, so a prior failure does not bound what can be done now; feasibility is decided at execution against current tools, not pre-judged from history. The rule rides every layer that touches the past: temporal-memory frames recalled failures as lessons and never carries "consistently fails / infeasible / the tool can't" into the packet (and consolidation never hardens a failure into a durable capability verdict or bare-incapacity deep truth); prefrontal reserves `premise: flawed` for a false frame — a wrong assumption about the world or current state — never for a task that merely failed before; cortex decides against what is available now and never generalizes a tally of stumbles into a "capability limitation." When history is discouraging, the lesson is carried into the plan and execution is allowed to try. This is the complement of honest, bounded failure (B-7): B-7 is how a *real* attempt reports a *real* shortfall; B-34 forbids skipping the attempt because prior ones fell short.
**Better looks like:** a task that failed eight times attempted a ninth, the ninth shaped by the eight lessons; a doc edit retried against re-derived text after a miss.
**Worse looks like:** "this consistently fails" foreclosing a task the current tools can do; a premise marked flawed because the memory is discouraging; a capability verdict manufactured from a count of past attempts.

### B-35 · One compiled spec, not N overlapping authorities
A brain reads exactly one deterministic, immutable **Effective Agent Spec** — role, personas, skills, responsibilities, capabilities, secret handles, model policy and memory policy, plus the digest that identifies it. It does not independently resolve overlapping role metadata, install manifests, SOUL appends, skill indexes and local config files and hope they agree. Composition happens once, off the hot path, as a pure ordered function: foundation firmware + deployment defaults + role + project overlay + agent overlay → bundle + digest. The spec is pinned per mission (C-32), so what the brain read is always recoverable.
**Better looks like:** one file the daemon loads to know everything it is; a mission whose behavior can be reproduced from its digest alone; a persona rendered by a pure function into a staging directory and swapped atomically.
**Worse looks like:** the daemon reading role identity from three sources at startup and reconciling them itself; a persona built by appending text to a live file in place; two agents on the same release behaving differently because one's local file drifted.

### B-36 · Protected firmware is not overlayable
Some cognitive content is the machine, not the personality: organ topology, the legal action schemas, routing, prompt assembly, the model/provider ABI and the verification protocol. Those fields are declared protected and the compiler refuses any overlay that would replace them — a deployment may add disposition, never redefine the wiring. The rule is what makes B-26's breadth safe: an agent's *character* is fully authorable precisely because its *mechanism* cannot be reached.
**Better looks like:** a role overlay that changes decision posture, collaboration style and domain judgment, and is structurally incapable of changing what actions exist; a compiler error naming the protected field an overlay tried to touch.
**Worse looks like:** an overlay that introduces a new action name; tenant text that redefines the verification protocol; "don't edit this section" as a comment rather than a compiler rule.
