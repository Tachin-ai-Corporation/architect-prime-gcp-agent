# Skill: Fleet Fire

## When to Use
When firing, removing, tearing down, or deleting a fleet agent from the deployed fleet registry.

## Commands

### Write
- `fleet-fire --name <name>` — Decommission a fleet agent, deleting the VM and stopping billing immediately.
  Output: Teardown status JSON.

## Procedures

### Decommission a fleet agent
1. Identify the name of the fleet agent to decommissioning (e.g., `stan`).
2. Run the fire command:
   ```bash
   fleet-fire --name stan
   ```
3. Verify: Ensure the command returns a decommissioning confirmation JSON.
4. Instruct the user to suspend or delete the agent's Google Workspace email account at `https://admin.google.com/ac/users`.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `404 notFound` | Agent name does not exist in the registry | Verify the spelling of the name and run `fleet-status` to list deployed agent names. |
| Teardown hangs or fails to complete | GCP API connection timeout | Wait 2 minutes, run `fleet-status --name <name>` to check state, and retry `fleet-fire` if still active. |
| Workspace user cannot be suspended | Lacks admin credentials or domain policy | Instruct the user to log in manually as an Org Administrator to suspend the user. |

## Examples

### Example: Decommissioning agent 'stan'
```
Task: "Fire the agent stan"

Step 1: fleet-fire --name stan
→ Result: {"status":"decommissioning","agent":"stan","vmStatus":"deleting","message":"Teardown scheduled."}

Outcome: Teardown scheduled. VM is being deleted in Google Compute Engine.
```
