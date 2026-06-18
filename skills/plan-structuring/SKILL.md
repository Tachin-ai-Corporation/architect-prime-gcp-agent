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
          "step_type": "standard|delegation|approval_gate|ask",
          "brief_part": "Which Brief part this task addresses"
        }
      ]
    }
  ]
}
```

## Rules

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
