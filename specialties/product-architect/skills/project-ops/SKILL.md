# Project Operations Skill

Procedures for managing projects, processes, and improvement plans using CoreKit motor tools.

## Tools

| Tool | Purpose |
|------|---------|
| `project-manage` | Create, list, update, close projects |
| `process-manage` | Create, list, update processes |
| `responsibility-manage` | Create, list, update, enable/disable responsibilities |
| `plan` | Create improvement plan documents |

## Procedures

### Create an Improvement Project

```bash
# 1. Create the project
project-manage create --name "Improvement: <title>" --description "<scope and goals>"

# 2. Link process (if using a defined process)
project-manage update --id <project-id> --process-ref p-repo-improve
```

### Propose an Improvement Plan

1. **Audit**: Read target files and identify the improvement opportunity.
2. **Draft**: Write the plan as a structured document:
   - Scope (file globs).
   - Before/after description.
   - Rubric claim (axis, measure, protected properties).
   - Acceptance criteria.
   - Risk notes.
3. **Publish**: Upload the plan to Drive via `drive-upload`.
4. **Gate**: Submit for approval before delegation.

### Manage Responsibilities

```bash
# List all responsibilities
responsibility-manage list

# Update prior_learnings after a cycle completes
responsibility-manage update --id r-repo-improvement --prior-learnings "<new learnings>"

# Enable/disable a responsibility
responsibility-manage update --id r-repo-improvement --enabled true
```

### Track Delegation Progress

```bash
# Check active missions delegated by this agent
work-log-read --status active --owner <agent-email>

# Check waiting envelopes (delegations in progress)
work-log-read --status waiting --owner <agent-email>

# Read delegation results
work-log-read --id <envelope-id>
```

## Best Practices

- Always create a project before starting an improvement cycle.
- Link the project to the relevant process for traceability.
- Update `prior_learnings` on the responsibility after each cycle — this is how the agent learns.
- Close projects when the improvement is verified and deployed.
