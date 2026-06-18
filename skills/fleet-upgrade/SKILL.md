# Skill: Fleet Upgrade

## When to Use
When upgrading, updating, or patching a deployed fleet agent's CoreKit installation to the latest version.

## Commands

### Write
- `fleet-upgrade --name <name>` — Trigger a background upgrade process for the specified agent.
  Output: Status confirmation indicating that the upgrade has been triggered.

## Procedures

### Upgrade a fleet agent
1. Identify the name of the fleet agent to upgrade (e.g., `stan`).
2. Run `fleet-upgrade --name stan`.
3. Verify: Wait 30 seconds, then run `fleet-status --name stan` and check that the agent's CoreKit version is updated and its status is healthy.
