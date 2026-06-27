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
## Procedures

### Composing a delegation instruction

A good delegation instruction is specific enough that the delegate can start
working immediately without re-planning. Include:

**Tell the delegate WHAT to do, not HOW.** Delegates are specialists — they
know their own tools. Say "read the current index.html from the project Drive
folder" not "use drive-cat with file ID xyz to read index.html." Describe the
desired outcome and the inputs, not the tool invocations.

1. **What to do** — the specific action, not a goal
   Bad: "Improve the website design"
   Good: "Update the hero section of index.html with a new headline and color scheme"

2. **Input files** — by Drive folder ID or file name
   "Download index.html from Drive folder 1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV"

3. **Specific changes** — what to modify
   "Replace the headline text with 'AI Workforce Platform'. Change the primary 
    color from #333 to #1a1a2e. Add a subtitle: 'Deploy AI agents as your workforce.'"

4. **Where to put the output** — Drive folder ID
   "Upload the updated files to the project artifacts folder"

5. **Acceptance criteria** — how to verify
   "Hero section displays new headline. Primary color is #1a1a2e. Files uploaded."

If you can't fill in all 5 fields, you don't understand the task well enough to
delegate it. Read the project context and files first, then delegate.

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

## Cross-Agent Context (File Sharing)

- **NEVER reference local filesystem paths** in delegation instructions. Delegates run on different VMs and cannot access your local files.
- Before delegating, publish any files the delegate needs to the shared project Drive folder. Reference them by Drive file name or ID.
- Use `work-publish` to upload files before delegating, or include the content inline in the delegation instruction if it's short (<2000 chars).
- The brain will also automatically attempt to publish active artifacts before dispatching a delegation, but you must ensure the references in your instructions point to Drive, not local paths.

## Delegation vs Motor Tasks

| Situation | Use |
|-----------|-----|
| Work you can do with your own tools | `checkpoint_plan` with motor tasks |
| Work that needs another agent's specialty | `delegate` or `checkpoint_plan` with `type: "delegation"` |
| Work that needs a human decision | `needs_input` |
| Following a defined playbook | `follow_process` |

## Delegation-First Roles

**Product architects and project managers** should always delegate implementation
work. Their default action is `delegate` — they plan, coordinate, and audit.

| Agent Type | Default for Implementation | Self-Execute |
|-----------|--------------------------|--------------|
| Product Architect | `delegate` to specialist | Plans, reviews, audits, context updates |
| Project Manager | `delegate` to specialist | Plans, status tracking, context updates |
| DevOps | Self-execute with motor | Only delegate when another specialty is needed |
| Designer | Self-execute with motor | Only delegate when another specialty is needed |
| Engineer | Self-execute with motor | Only delegate when another specialty is needed |

## Process-Backed Delegations

When delegating a task that the delegate has a **defined process** for (e.g.,
`p-stage-deploy`, `p-deploy-prod`), specify only the **project and intent**.
Do NOT include deployment commands, file paths, or procedure steps — the
delegate owns those via their processes and project context.

**Correct** delegation for deployment:
> "Deploy the tachin-website to staging for review."

**Wrong** delegation for deployment:
> "Navigate to /opt/corekit/workspace/services/hosting/, download files from
>  Drive folder 1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV, run firebase deploy..."

The delegate's cortex will match the right process (`follow_process:
p-stage-deploy`) and execute it with the correct parameters from project
context. Over-specifying deployment steps pollutes the delegate's context
and can conflict with their process definitions.

## Multi-Agent Orchestration

When work spans multiple specialties, use `checkpoint_plan` with multiple
`type: "delegation"` tasks to fan out to several teammates simultaneously.

### Example: Parallel Delegation to Designer + DevOps

```json
{
  "action": "checkpoint_plan",
  "goal": "Improve tachin-website: UX audit by Designer, health check by DevOps",
  "checkpoints": [
    {
      "step": 1,
      "label": "Parallel specialist work",
      "tasks": [
        {
          "id": "1.1",
          "type": "delegation",
          "target_email": "designer-agent-dot@tachin.ag",
          "agent": "designer",
          "task": "Audit the tachin-website UX: review layout, navigation, visual hierarchy, and mobile responsiveness. Provide specific improvement recommendations.",
          "accept_criteria": "Report with at least 3 specific UX improvement recommendations"
        },
        {
          "id": "1.2",
          "type": "delegation",
          "target_email": "devops-agent-stan@tachin.ag",
          "agent": "devops",
          "task": "Run a health check on the tachin-website sync service and verify deployment status.",
          "accept_criteria": "Report confirming service status and last sync timestamp"
        }
      ]
    }
  ]
}
```

**Key rules for multi-agent delegation:**
- Independent tasks go in the SAME checkpoint (parallel execution)
- Dependent tasks go in SEQUENTIAL checkpoints (serialized execution)
- Each delegation task MUST have `type: "delegation"` and `target_email`
- Pull `target_email` from the project team roster — never guess emails

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| Target agent not found | Email address is malformed or guessed | Always copy the exact email from the project registry `team` roster; do not shorten or invent email addresses. |
| Target agent lacks space membership | Target is not in the project GChat space | Mouth will auto-add them before delivering. If it fails, ask the user to manually add the agent to the space. |
| Delegation silently fails to reach target agent | Archival sweep archived the delegation output before agent-mouth could deliver it | Fixed in CoreKit `v2026.06.25`. Archival sweeper no longer archives envelopes that have `delivery_status: "pending"`. If you encounter this, ensure the fleet is fully upgraded. |
| Delegation fails to dispatch | Invalid project ID | Verify that the `project_id` field in the delegation payload matches an active project in Firestore. |
| Delegation task dispatched to Motor instead of GChat | Missing `type: "delegation"` on task | Set `type: "delegation"` on the task object when using checkpoint_plan path. |
| Mission stuck in waiting | Delegate agent hasn't completed or result not received | Check delegate agent's brain logs. The waiting mission resumes when checkWaitingEnvelopes detects all children complete (including archived/cancelled). |
| Mission stuck in waiting with archived children | Archival sweep archived delegation children before parent resumed | checkWaitingEnvelopes now treats `archived` as terminal (success) and `cancelled` as terminal (failure). |
| Active mission with waiting checkpoint children | Checkpoint-plan delegations dispatched but parent M envelope stays active | Phase B of checkWaitingEnvelopes scans active M envelopes with waiting C children every ~27s. |

## Lifecycle

The return path has two mechanisms (both must work for reliable round-trips):

**Mechanism 1: Firestore polling (primary resumption path)**
- Delegate brain registers its mission as child on delegator's waiting T envelope
- Delegator's `checkWaitingEnvelopes` polls every ~9s
- When all children are terminal, it resumes the mission with results

**Mechanism 2: GChat [DELEGATION-RESULT] marker (notification/audit trail)**
- Delegate mouth sends `[DELEGATION-RESULT]` to the project space
- This is informational — Firestore polling drives actual resumption

```
Delegator                                     Delegate
─────────                                     ────────
1. Cortex decides: delegate                   
2. Creates T envelope (waiting)               
3. Mouth sends [DELEGATION] marker            
                              ──────→         
                                              4. Ears detects delegation marker
                                              5. Brain creates mission (no LLM classify)
                                              6. Registers as child on parent T envelope
                                              7. Executes work (motor/cerebellum)
                                              8. Sends [DELEGATION-RESULT] marker
                              ←──────         
9. checkWaitingEnvelopes finds child complete
10. Resumes waiting mission with context_forward
11. Synthesizes with delegation results
```
