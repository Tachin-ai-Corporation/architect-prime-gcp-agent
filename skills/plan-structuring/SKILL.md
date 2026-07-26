# Skill: Checkpoint Plan Structuring

## When to Use
When the brain daemon asks the prefrontal organ to structure a checkpoint plan from a goal and Brief.

## Commands

No executable commands are governed directly by this skill (prefrontal-only planning).

## Procedures

### Re-plan ONE checkpoint (request marked `[PLAN STRUCTURING — SINGLE CHECKPOINT]`)
A mission's checkpoint skeleton is pinned after the first plan: a checkpoint that fails is
re-tasked, the mission is not re-shaped. When the request carries that marker you are being
asked for **tasks only**, for the one checkpoint named in it.

1. **Treat the outcome and the acceptance criteria as FIXED.** They are given as "do not
   reword" for a reason — checkpoints that already passed are keeping their verdicts against
   these exact criteria. Plan tasks that satisfy the criteria *as written*.
2. **Read "why the last attempt did not satisfy them"** and change the approach, not the
   goal. If the previous tasks failed on mechanics (a wrong command, an unread doc), the new
   tasks should be more specific about the *outcome to reach*, not longer.
3. **Cover every unmet clause.** Split the pinned criteria into their separate clauses and
   check your task list against each one. The verifier judges all clauses at once, so a
   plan that satisfies some of them still fails — and because the criteria are pinned, it
   fails the same way every round. A real checkpoint whose criteria read "the draft doc ids
   are identified **and** personal details are extracted" was re-tasked three times with
   extraction tasks only; nothing ever listed the folder, so it could not pass at any point.
   If a clause is already satisfied by earlier evidence, say so in your reasoning rather
   than silently dropping it.
4. **Return exactly one checkpoint** in `checkpoints`. Do not include the other checkpoints,
   even to restate them; anything you add beyond the one asked for is discarded.
5. Only propose different `accept_criteria` if the pinned wording is genuinely
   **unachievable** (it asks for something that cannot exist), not merely awkward. One
   refinement per checkpoint is accepted; after that the pinned wording stands, so spend it
   carefully.

If you conclude the *mission* is mis-shaped — a whole phase is missing, or the goal was
misread — say so plainly in your reasoning rather than smuggling it in as extra checkpoints.
Re-shaping the mission is a decision that belongs to cortex.

### Structure a checkpoint and task plan
1. Read the input goal, Brief parts, and available skill index.
2. Define checkpoints as **verifiable milestones** — each a meaningful state the mission reaches that is worth an independent quality check (a phase gate, a specialty handoff, a deliverable produced). A checkpoint is NOT a task grouping or a tool step; it is the milestone cerebellum will judge.
3. For each checkpoint, write its `instruction` (the milestone) and `accept_criteria` — the observable OUTCOME true when the milestone is reached. This is the contract cerebellum verifies, so it must be a real, checkable end state, not "the tasks ran."
4. Decompose each checkpoint into outcome tasks — each a result a single organ owns end-to-end (it may take many tool calls) — with the target `agent`, an instruction describing the desired outcome (never the tool or API operation), and a light `accept_criteria` the executing organ uses to self-check its own task.
5. Format the plan into the final JSON structure containing `checkpoints` and `tasks`.
6. Verify: Ensure the output plan conforms strictly to the schema, has no missing fields, and does not contain execution commands.

---

## Output Schema
Return a JSON object with a `checkpoints` array:

```json
{
  "checkpoints": [
    {
      "instruction": "The milestone — the meaningful state reached at this checkpoint",
      "accept_criteria": "The observable OUTCOME true at this milestone (what cerebellum verifies) — an end state, not 'the tasks ran'. E.g. 'the agreement reflects every redline and the notes section is gone', not 'each redline applied individually'.",
      "tasks": [
        {
          "agent": "motor|temporal-research|temporal-memory",
          "task": "An outcome a single organ owns end-to-end. Describe WHAT to achieve, never the tool/API.",
          "accept_criteria": "A light self-check the executing organ uses to confirm its own task (cerebellum does NOT gate individual tasks — it judges the checkpoint milestone).",
          "type": "standard|delegation|approval_gate|ask",
          "brief_part": "Which Brief part this task addresses"
        }
      ]
    }
  ]
}
```

## Rules

### Checkpoints are milestones; tasks are steps
A checkpoint is a **verifiable milestone** — a state worth an independent check — and its
`accept_criteria` is the OUTCOME cerebellum judges. Tasks are the steps the owning organ
takes to reach it; the organ self-verifies its own tasks. Do NOT smuggle tool-step language
("apply each X individually", "generate a structured list of instructions") into a
checkpoint's criteria — that makes the milestone unverifiable against how the organ actually
chose to work, and it is the over-specification that strands execution. State the end state;
let the organ choose how to reach it.

**The outcome names a state, never the method that reaches it.** A checkpoint's
`instruction` is pinned for the whole mission — a failure re-tasks it, and the outcome
wording stands. So a method written into the outcome becomes a permanent constraint on
every later attempt, including after that method has already been carried out or has
been proven to be the wrong one. Write "three addendum drafts exist in the In Progress
folder, one per advisor"; not "prepare the drafts *by duplicating the master template*".
The second reads as an outcome and behaves as an instruction: it kept re-tasking a
duplication step in a real mission whose documents had already been created, because
the outcome it was re-planning against still demanded duplication.

**Criteria are format-agnostic unless the requester asked for a format.** The criterion
states what must be TRUE of the content, never the shape it arrives in. If the user asked to
"list", "summarize", or "tell me" something, do NOT require "a JSON array" or a specific
schema — a correct prose answer would fail that check and strand a finished mission (the
verifier FAILs on format, blocking synthesis of a right answer). Demand a specific
serialization ONLY when the requester explicitly asked for it (e.g. "give me a CSV").
Otherwise state the content: "each shared doc is listed with its name, id, and who shared it,
most-recent first" — not "a JSON array of document objects".

### Simplicity first

The best plan is the simplest plan that gets the work done.

**Default: 1 checkpoint.** Most tasks need one checkpoint with 1-3 tasks.
Only add a second checkpoint when the work genuinely requires a phase gate:
- An approval gate (human must approve before continuing)
- A different agent takes over (design phase → deployment phase)
- The first phase must fully complete and be verified before the second can start

Do NOT create a new checkpoint for:
- Risk level changes within the same agent's work (read → write is not a checkpoint boundary)
- Verification steps (the executor handles verification automatically)
- "Analyze then implement" — these are two tasks in one checkpoint, not two checkpoints

**Count your tasks.** If your plan has more than 5 tasks total, it's probably
over-decomposed. Ask: could two adjacent tasks be one task? Usually yes.

**Delegation plans are simple.** A plan that delegates work to one agent is:
1 checkpoint, 1 delegation task. A plan that delegates to two agents in sequence 
is: 2 checkpoints, 1 delegation task each. That's it.

**Delegation is fleet-only and project-scoped.** Only fleet agents working
within a project (one with a team and a GChat space) may use `type: "delegation"`
tasks. Prime agents never delegate — for Prime, structure fleet-related work as
`standard` motor tasks that operate on the fleet directly (SSH via system-shell,
work-log reads, fleet-verify/fleet-upgrade).

**No placeholder instructions.** Every task instruction — especially delegation
tasks — must be concrete and actionable. NEVER write "PLACEHOLDER", "will be
filled later", "TBD", or any deferred content. The executor sends instructions
exactly as written. If you need information before you can write the delegation
instruction, make the information-gathering step its own plan. Cortex will be
called again with the results, and you can write the delegation then.

**No local file references in delegations.** Delegates run on different VMs and
cannot access the delegator's local files. NEVER write a delegation instruction
that says "follow the instructions in design_notes.md" — that file does not
exist on the delegate's VM. Instead, include ALL specific instructions inline
in the delegation task's `task` field: exact CSS selectors, exact HTML changes,
exact colors, exact text. If the content exceeds 4000 chars, publish it to
Drive first and reference the Drive file ID.

### Valid task agents — capabilities and limits

For standard tasks, the `agent` field MUST be exactly one of:

| Agent | Can do | Cannot do |
|-------|--------|-----------|
| `motor` | Execute commands, read/write files, call any skill tool, modify state | Deliver outbound to a human or agent — motor has no send primitive; the mouth is the sole egress (C-27) |
| `temporal-research` | Web search, fetch URLs, read web content | Write files, modify state, execute commands, call non-search tools |
| `temporal-memory` | Recall internal memory, read core memory | Write files, modify state, execute commands, search the web |

**Common mistakes:**
- ❌ "Search the web AND save results to a file" → temporal-research can't write files. Split: temporal-research searches → motor saves the results.
- ❌ "Recall memory AND create a report" → temporal-memory can't write files. Split: temporal-memory recalls → motor creates the report.
- ❌ Assigning any task that says "create", "write", "upload", "deploy", "modify" to temporal-research or temporal-memory. These verbs require motor.
- ❌ `exec` is NOT an agent — it's a skill name. Use `motor` with the exec skill.
- ❌ `system` / `System` is NOT an agent.
- ❌ `cortex`, `prefrontal`, `cerebellum` are organ names, not task agents.

For **delegation** tasks (`type: "delegation"`), the `agent` field is the **delegate specialty** (e.g., `devops`, `engineer`, `product-architect`). You MUST also include `target_email` with the teammate's email from the project team roster.

### Outbound is never a standard motor task
Human- or agent-facing output is never a standard `motor` task — motor cannot deliver to
the outside world (the mouth is the sole outbound egress, C-27). Shape the step as its
matching move or task type instead:
- A reply or completed answer → a `synthesize` move (cortex, not a task in this plan)
- A receipt that queued work was received → a `status_update` move
- Content that must be signed off before it leaves → an `approval_gate` task
- Work handed to a teammate → a `delegation` task

The mouth voices and delivers all of these. NEVER write a `motor` task like "email the
staging URL to the requester" or "send the report to the operator" — reshape it as the
move or task type above.

### Task sizing — outcome tasks, not tool steps
A task is one outcome a single agent owns end-to-end. The executor sequences the tool calls
itself — a task that makes many tool calls is normal execution, not over-scope. Size a task
to fit motor's step budget (~50 tool calls, 300s timeout); split only if the *outcome*
genuinely exceeds that budget, never merely because it is multi-step. Do NOT split
"read → analyze → apply" into separate tasks — that is one outcome (see "Simplicity first").

### Checkpoint boundaries
A new checkpoint starts when:
- Prior work must be verified before continuing
- Risk level changes (read-only → mutating → destructive)
- A different agent specialty is needed
- An approval gate is required

### Task instructions describe outcomes, never tool syntax
Write task instructions that describe WHAT should happen, not HOW. Sub-agents are
specialists — they know their own tools and read the governing SKILL.md themselves. Say
"read the project context" not "read the project context using workspace-drive." Reference a
skill by name at most; NEVER name a command, flag, or API operation. Anti-pattern: "execute
the generated JSON array of Google Docs API batch_update operations" — there is no such
tool, and the planner cannot know the real command surface. Write the outcome instead:
"incorporate the redline changes into the body and remove the redline notes section."

### Never split a task away from the identifier it needs

If task B needs an id that task A has to go and discover, **A and B are one task.** Do not write
"locate the template" and then "duplicate the template (identified in the previous task)" — that
is a single outcome, and splitting it is how the wrong file gets used.

Each task runs as its own dispatch. A back-reference like "identified in the previous task",
"found above", or "from step 1" is not a pointer the executor can resolve — the organ receiving
task B has to work out which id you meant from whatever context came along, and it can pick
wrong. In a real mission task A correctly identified `MASTER_..._Addendum_Retainer_Fixed` and
reported its id as a verified claim; task B took the first row of a folder listing instead
(`MASTER_..._Addendum_Retainer_Royalty`) and built three documents from the
wrong template. Nothing failed loudly — the work just came out wrong.

Write one task that owns the whole outcome: "duplicate the fixed monthly comp addendum master
template from the Master Templates folder once per advisor into the In Progress folder." The
organ resolves the id and uses it inside a single task, where it cannot be lost between steps.

### Identifiers are copied, never retyped

When a request carries a "Known Resources" block, every id in it was read back from a
tool result. If a task needs one, **copy it from that block character for character.**
Never retype an id from memory, never carry one over from an earlier task list, and
never invent one to fill a gap.

An id is not the kind of thing that can be *almost* right. A single wrong character
produces a task that fails instantly and identically on every retry — and because the
checkpoint skeleton is pinned, that task gets re-derived from your own previous wording
each round, so the same wrong id is copied forward indefinitely. One mission spent every
attempt it had this way: the verified id sat in the same prompt as the task that had it
wrong by one letter.

If a resource you need has no id in that block, **do not guess one.** Name the resource
plainly ("the master addendum template in the Master Templates folder") and let the
executing organ resolve it — resolving identifiers is work it can do and you cannot.

### Accept criteria are evidence-bearing
Write accept_criteria a verifier can check against concrete evidence, at the OUTCOME level.
For a task that reads or analyzes an artifact (document, file, dataset), the criteria MUST
demand coverage evidence — e.g. "the complete document was read: chars read equals the
document's total char count, shown in the output" — not merely "content was retrieved".
Partial reads that pass verification are how downstream edits destroy content.

### One-task plans are valid
A simple request yields one checkpoint with one task.

### Constraints
- Do not execute tasks directly.
- Do not decide goal feasibility; cortex handles decisions.

### Multi-Agent Delegation Plans

When the Brief has multiple parts with `ownership: "teammate"`, structure the plan
with `type: "delegation"` tasks targeting different teammates.

**Parallel delegation** — independent parts go in the SAME checkpoint:
```json
{
  "checkpoints": [
    {
      "instruction": "Delegate specialist work in parallel",
      "accept_criteria": "Both agents complete their assigned tasks",
      "tasks": [
        {
          "agent": "designer",
          "type": "delegation",
          "target_email": "designer-agent-dot@example.com",
          "task": "Audit the website UX and provide improvement recommendations",
          "accept_criteria": "Report with specific UX improvement recommendations"
        },
        {
          "agent": "devops",
          "type": "delegation",
          "target_email": "devops-agent-stan@example.com",
          "task": "Run sync-service health check and verify deployment",
          "accept_criteria": "Report confirming service status and sync timestamp"
        }
      ]
    }
  ]
}
```

**Mixed plans** — combine local analysis with delegated implementation:
```json
{
  "checkpoints": [
    {
      "instruction": "Gather context locally",
      "accept_criteria": "Project state documented",
      "tasks": [
        {
          "agent": "motor",
          "task": "Read the project context and current website structure from the project Drive folder",
          "accept_criteria": "Summary of current website state"
        }
      ]
    },
    {
      "instruction": "Delegate specialist improvements",
      "accept_criteria": "All delegates complete their work",
      "tasks": [
        {
          "agent": "designer",
          "type": "delegation",
          "target_email": "designer-agent-dot@example.com",
          "task": "Apply UX improvements to the website",
          "accept_criteria": "Updated design files or mockups"
        }
      ]
    }
  ]
}
```
