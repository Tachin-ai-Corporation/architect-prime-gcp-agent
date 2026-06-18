# Skill: Fleet Hire

## When to Use
When hiring, deploying, creating, or spinning up a new fleet agent inside the GCP infrastructure.

## Commands

### Write
- `fleet-hire --name <name> --specialty <specialty>` — Deploy a new fleet agent VM, service account, and infrastructure.
  Output: Deployment status JSON containing VM setup info.

## Procedures

### Deploy a new fleet agent
1. Read `/opt/corekit/corekit/agent-types.json` if the user hasn't specified a specialty to see all valid types.
2. Run the deployment command:
   ```bash
   fleet-hire --name anora --specialty pm
   ```
3. Verify: Ensure the command returns a success confirmation JSON.
4. Walk the user through G Workspace setup:
   - Create the Workspace user at `https://admin.google.com/ac/users` (name must match output).
   - Add the email to the project's Google Chat space.
   - Send `@FirstName LastName hello` in Chat to verify connectivity.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `400 invalidArgument` | Alphanumeric or casing violations in name, or invalid specialty | Ensure the name is lowercase, alphanumeric, and check `agent-types.json` for the exact specialty key. |
| GCP VM creation fails | CPU or IP address quota exceeded in GCP project | Ask the user to check and increase GCE quotas in the GCP Console. |
| `409 conflict` | Agent with that name already exists | Pick a unique name for the new agent and retry the command. |

## Examples

### Example: Hiring a PM agent named 'anora'
```
Task: "Hire a pm named anora"

Step 1: fleet-hire --name anora --specialty pm
→ Result: {"status":"deploying","agent":"anora","specialty":"pm","vmStatus":"creating","email":"anora-pm@domain.com"}

Outcome: Deployment started. VM is being provisioned in GCE.
```
