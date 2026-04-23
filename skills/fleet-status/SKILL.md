# Skill: fleet-status

## What this skill does
Shows the current status of deployed fleet agents. Reads live data from Firestore — always gives current state.

## When to use
- User asks about fleet status, active agents, or "who is deployed"
- User asks "how's anora doing?" or "what agents do we have?"

## Commands
```
fleet-status                   # All agents summary
fleet-status --name <name>     # Single agent detailed view
fleet-status --json            # Machine-readable JSON output
fleet-status --name <name> --json
```

## Output
Shows deploy progress steps, current status, and any actions still required.
