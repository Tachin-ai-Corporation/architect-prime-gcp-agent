# Skill: Project Operations

## When to Use
When managing projects, processes, or improvement plans — including creating projects, adding team members, defining processes, and tracking progress.

## Commands

No custom corekit scripts are governed directly by this skill (handled via core workspace/work tools).

## Procedures

### Create an Improvement Project
1. Formulate the project details (name, description, goals).
2. Run the creation command:
   ```bash
   project-manage create --name "Improvement: <title>" --description "<scope and goals>"
   ```
3. Link the project to a defined process:
   ```bash
   project-manage update --id <project-id> --process-ref <process-ref>
   ```
4. Verify: Ensure the project is successfully registered in Firestore.

### Propose an Improvement Plan
1. **Audit:** Read target files and identify the improvement opportunity.
2. **Draft:** Write the plan as a structured document containing scope, before/after description, rubric claim, acceptance criteria, and risk notes.
3. **Publish:** Upload the plan to Drive via `drive-upload`.
4. **Gate:** Submit the plan for user approval before delegating.

### Manage Responsibilities
1. List active responsibilities using `responsibility-manage list`.
2. Run updates to include new learnings:
   ```bash
   responsibility-manage update --id <responsibility-id> --prior-learnings "<new learnings>"
   ```
3. Enable or disable a responsibility as needed using `responsibility-manage update --id <id> --enabled true/false`.
4. Verify: Confirm the update successfully registers and reloads.

### Track Delegation Progress
1. Check active missions delegated by this agent:
   ```bash
   work-log-read --status active --owner <agent-email>
   ```
2. Check waiting envelopes (delegations in progress) using `work-log-read --status waiting --owner <agent-email>`.
3. Read specific delegation results using `work-log-read --id <envelope-id>`.

## Best Practices
- Always create a project before starting an improvement cycle.
- Link the project to the relevant process for traceability.
- Update `prior_learnings` on the responsibility after each cycle — this is how the agent learns. (The daemon also machine-feeds dated learnings from mission compaction digests into the `responsibility_state` Firestore overlay; your hand-authored guidance and the machine-fed lines are merged at fire time — do not duplicate them.)
- Close projects when the improvement is verified and deployed.
