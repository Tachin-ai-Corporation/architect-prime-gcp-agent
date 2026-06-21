# Skill: Cross-Agent Delegation

## When to Use
When work should be assigned to a teammate agent on a shared project instead of done locally (e.g., when the work belongs to another agent's specialty or role).

## Two Delegation Paths

### Path 1: Direct Delegation (simple, one-off)
Use the `action: "delegate"` cortex decision. This is best for single tasks that need a teammate.

```json
{
  "action": "delegate",
  "target_email": "devops-agent-stan@tachin.ag",
  "instruction": "Investigate the sync-service health and report status",
  "accept_criteria": "Report with status and any logs",
  "project_id": "tachin-website"
}
```

### Path 2: Checkpoint Plan Delegation (multi-step, mixed)
Use `action: "checkpoint_plan"` with `type: "delegation"` on specific tasks. This is best when you need a mix of local and delegated work in one plan.

```json
{
  "action": "checkpoint_plan",
  "checkpoints": [
    {
      "step": 1,
      "label": "Delegate health check to DevOps",
      "tasks": [
        {
          "id": "1.1",
          "type": "delegation",
          "target_email": "devops-agent-stan@tachin.ag",
          "agent": "devops",
          "task": "Verify the sync-service Cloud Run status and last sync timestamp",
          "accept_criteria": "Report confirming service status and recent sync time"
        }
      ]
    }
  ]
}
```

**Important**: Set `type: "delegation"` on the task. The checkpoint executor reads this to route the task to the delegation pipeline instead of Motor.

## Target Resolution

**Always pull the target email from the project team array** in the project registry.
The project data includes a `team` field with each member's:
- `email` — the full workspace email (use this for `target_email`)
- `role` — their role on the project (lead, devops, designer, etc.)
- `name` — display name
- `type` — `agent` or `human`

## Communication Rules

> **Agents NEVER email, DM, or call each other directly.**

All inter-agent communication flows through **shared project GChat spaces**.
Motor must never use `gmail-send`, `chat-send`, or shell commands for delegation.
Only `action: "delegate"` in the cortex decide response triggers delegation.

- ❌ `gmail-send` to another agent
- ❌ `chat-send` to DM another agent
- ❌ Shell commands (`mail`, `sendmail`, etc.)
- ✅ `action: "delegate"` with `target_email` from the project team
- ✅ `type: "delegation"` task in `checkpoint_plan`

## Delegation vs Motor Tasks

| Situation | Use |
|-----------|-----|
| Work you can do with your own tools | `checkpoint_plan` with motor tasks |
| Work that needs another agent's specialty | `delegate` or `checkpoint_plan` with `type: "delegation"` |
| Work that needs a human decision | `needs_input` |
| Following a defined playbook | `follow_process` |

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Target agent not found | Email address is malformed or guessed | Always copy the exact email from the project registry `team` roster; do not shorten or invent email addresses. |
| Target agent lacks space membership | Target is not in the project GChat space | Mouth will auto-add them before delivering. If it fails, ask the user to manually add the agent to the space. |
| Delegation fails to dispatch | Invalid project ID | Verify that the `project_id` field in the delegation payload matches an active project in Firestore. |
| Delegation task dispatched to Motor instead of GChat | Missing `type: "delegation"` on task | Set `type: "delegation"` on the task object when using checkpoint_plan path. |
| Mission stuck in waiting | Delegate agent hasn't completed or result not received | Check delegate agent's brain logs. The waiting mission resumes when checkWaitingEnvelopes detects all children complete. |

## Lifecycle

```
Delegator                                     Delegate
─────────                                     ────────
1. Cortex decides: delegate                   
2. Creates T envelope (waiting)               
3. Mouth sends [DELEGATION] marker            
                              ──────→         
                                              4. Ears detects delegation marker
                                              5. Brain creates mission (no LLM classify)
                                              6. Executes work (motor/cerebellum)
                                              7. Sends [DELEGATION-RESULT] marker
                              ←──────         
8. Ears picks up result
9. Brain resumes waiting mission
10. Synthesizes with delegation results
```
