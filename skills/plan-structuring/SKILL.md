# Skill: Checkpoint Plan Structuring

## When to Use
When the brain daemon asks the prefrontal organ to structure a checkpoint plan from a goal and Brief.

## Commands

No executable commands are governed directly by this skill (prefrontal-only planning).

## Procedures

### Structure a checkpoint and task plan
1. Read the input goal, Brief parts, and available skill index.
2. Define checkpoints based on risk boundaries, specialty handoffs, or verification checkpoints.
3. For each checkpoint, define the `instruction` and `accept_criteria`.
4. Decompose each checkpoint into atomic tasks, identifying the target `agent`, task instructions (describing the desired outcome), and task `accept_criteria`.
5. Format the plan into the final JSON structure containing `checkpoints` and `tasks`.
6. Verify: Ensure the output plan conforms strictly to the schema, has no missing fields, and does not contain execution commands.

---

## Output Schema
Return a JSON object with a `checkpoints` array:

```json
{
  "checkpoints": [
    {
      "instruction": "Human-readable checkpoint goal",
      "accept_criteria": "Observable evidence that this checkpoint succeeded",
      "tasks": [
        {
          "agent": "motor|temporal-research|temporal-memory",
          "task": "Specific, atomic instruction describing the desired outcome.",
          "accept_criteria": "Evidence this specific task completed correctly",
          "type": "standard|delegation|approval_gate|ask",
          "brief_part": "Which Brief part this task addresses"
        }
      ]
    }
  ]
}
```

## Rules

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
| `motor` | Execute commands, read/write files, call any skill tool, modify state | — (full capability) |
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

### Task atomicity
Each task must be completable within motor's step budget (~50 tool calls, 300s timeout). If a task would require more, split it.

### Checkpoint boundaries
A new checkpoint starts when:
- Prior work must be verified before continuing
- Risk level changes (read-only → mutating → destructive)
- A different agent specialty is needed
- An approval gate is required

### Task instructions describe outcomes
Write task instructions that describe WHAT should happen, not HOW. Sub-agents
are specialists — they know their own tools. Say "read the project context"
not "read the project context using workspace-drive."

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
