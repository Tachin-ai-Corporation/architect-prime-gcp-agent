# Skill: Fleet Verify

## When to Use
When verifying, pinging, or checking if a deployed fleet agent is online, alive, and responding to dispatches.

## Commands

### Read
- `fleet-verify --name <name>` — Ping the specified fleet agent to check responsiveness.
  Output: Verification status confirmation showing if the agent is reachable.

## Procedures

### Verify a fleet agent's responsiveness
1. Identify the name of the fleet agent to verify (e.g., `stan`).
2. Run `fleet-verify --name stan`.
3. Verify: Ensure the command returns a success response confirming that the agent is online and responding.
