# Skill: Fleet Status

## When to Use
When checking the live status of deployed fleet agents, active agents, or agent health metrics.

## Commands

### Read
- `fleet-status` [--name <name>] [--json] — Query live status and health records of deployed fleet agents from Firestore.
  Output: Table or JSON representation of agent status, details, and active tasks.

## Procedures

### List all active fleet agents
1. Run `fleet-status` to get a summary table of all deployed fleet agents.
2. Verify: Ensure the output list displays status details (e.g., active, idle, offline) for each agent in the fleet.

### Inspect a specific agent's details
1. Identify the name of the fleet agent (e.g., `anora`).
2. Run `fleet-status --name anora` to fetch details.
3. Verify: Confirm the output displays active dispatches, deploy progress steps, and recent task history for the specific agent.
