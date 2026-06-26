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
4. Decompose each checkpoint into atomic tasks, identifying the target `agent`, task instructions (referencing specific skills), and task `accept_criteria`.
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
          "task": "Specific, atomic instruction. Name the skill(s) to use.",
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

### Skill references
When writing motor task instructions, name the specific skill(s) motor should consult.

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
          "target_email": "designer-agent-dot@tachin.ag",
          "task": "Audit the website UX and provide improvement recommendations",
          "accept_criteria": "Report with specific UX improvement recommendations"
        },
        {
          "agent": "devops",
          "type": "delegation",
          "target_email": "devops-agent-stan@tachin.ag",
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
          "task": "Read the project context and current website structure. Skill: workspace-drive",
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
          "target_email": "designer-agent-dot@tachin.ag",
          "task": "Apply UX improvements to the website",
          "accept_criteria": "Updated design files or mockups"
        }
      ]
    }
  ]
}
```
