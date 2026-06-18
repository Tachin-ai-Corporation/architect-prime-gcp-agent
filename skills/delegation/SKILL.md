# Skill: Cross-Agent Delegation

## When to Use
When work should be assigned to a teammate agent on a shared project instead of done locally (e.g., when the work belongs to another agent's specialty or role).

## Commands

No executable commands are governed directly by this skill (cortex-only action).

## Procedures

### Delegate a task to a project teammate
1. Retrieve the project configuration and locate the `team` array.
2. Find the target agent's role and email (e.g., `devops-agent-stan@tachin.ag` for devops).
3. In your cortex `decide` response, format a delegation action:
   ```json
   {
     "action": "delegate",
     "target_email": "devops-agent-stan@tachin.ag",
     "instruction": "Investigate the sync-service health and report status",
     "accept_criteria": "Report with status and any logs",
     "project_id": "project-123"
   }
   ```
4. Verify: Ensure the brain daemon creates the delegation envelope and outputs a `[DELEGATION]` message to the project's shared space.

### Handle delegation completion
1. Wait for the target agent to deliver a `[DELEGATION-RESULT]` message in the shared project space.
2. The brain daemon will automatically resume your mission with the target's output.
3. Verify: Check that the incoming result satisfies the delegation's acceptance criteria before proceeding.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Target agent not found | Email address is malformed or guessed | Always copy the exact email from the project registry `team` roster; do not shorten or invent email addresses. |
| Target agent lacks space membership | Target is not in the project GChat space | Mouth will auto-add them before delivering. If it fails, ask the user to manually add the agent to the space. |
| Delegation fails to dispatch | Invalid project ID | Verify that the `project_id` field in the delegation payload matches an active project in Firestore. |

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
