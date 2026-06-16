# Skill: delegation

## What this skill does
Cross-agent delegation — assigning work to a teammate agent on a shared project.
Delegation is a **brain-level action**, not a motor tool. Cortex outputs
`action: "delegate"` and the brain daemon handles the rest.

## When to delegate
- The work belongs to another agent's specialty (devops → stan, design → dot)
- The project team structure assigns specific roles
- You're the project lead and need to distribute work

## How to delegate

In the cortex **decide** response, use:

```json
{
  "action": "delegate",
  "target_email": "devops-agent-stan@tachin.ag",
  "instruction": "Investigate the sync-service health and report status",
  "accept_criteria": "Report with service status, last sync timestamp, and any errors",
  "project_id": "tachin-website"
}
```

### Required fields
- `target_email` — The target agent's **full email** from the project `team` array.
  Always use the exact email shown in the team roster (e.g. `devops-agent-stan@tachin.ag`).
  Never guess, shorten, or construct email addresses.
- `instruction` — Clear description of the work to delegate.

### Optional fields
- `accept_criteria` — How to verify the delegated work is done.
- `project_id` — The project this delegation belongs to (auto-filled from envelope if omitted).

## What happens after delegation
1. Brain creates a delegation task envelope (`status: waiting`)
2. Mouth composes a `[DELEGATION]` marker and delivers it to the **project's shared GChat space**
3. Before delivery, Mouth verifies the target agent is a member of the space (adds them if not)
4. Target agent's ears picks up the delegation from the shared space
5. Target agent's brain creates a mission and executes the work
6. When complete, target agent sends a `[DELEGATION-RESULT]` marker back to the project space
7. Delegating agent's brain auto-resumes the waiting mission

## Communication rules

> **Agents NEVER email, DM, or call each other directly.**

All inter-agent communication flows through **shared project GChat spaces**.
Motor must never use `gmail-send`, `chat-send`, or shell commands for delegation.
Only `action: "delegate"` in the cortex decide response triggers delegation.

- ❌ `gmail-send` to another agent
- ❌ `chat-send` to DM another agent
- ❌ Shell commands (`mail`, `sendmail`, etc.)
- ✅ `action: "delegate"` with `target_email` from the project team

## Target resolution
Always pull the target email from the **project team array** in the project registry.
The project data includes a `team` field with each member's:
- `email` — the full workspace email (use this for `target_email`)
- `role` — their role on the project (lead, devops, designer, etc.)
- `name` — display name
- `type` — `agent` or `human`

## Delegation vs motor tasks
| Situation | Use |
|-----------|-----|
| Work you can do with your own tools | `checkpoint_plan` with motor tasks |
| Work that needs another agent's specialty | `delegate` |
| Work that needs a human decision | `needs_input` |
| Following a defined playbook | `follow_process` |
