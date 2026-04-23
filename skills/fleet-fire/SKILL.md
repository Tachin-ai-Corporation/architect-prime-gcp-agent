# Skill: fleet-fire

## What this skill does
Decommissions a fleet agent. Deletes the VM and stops billing. Returns in seconds — the actual teardown runs in background (1-2 minutes).

## When to use
- User asks to fire, remove, tear down, or delete an agent
- User says "fire stan" or "remove anora"

## Command
```
fleet-fire --name <name>
```

### Arguments
- `--name` — Agent name to remove (e.g. "stan", "anora")

### Example
```
fleet-fire --name anora
```

## After firing — tell the user
- VM deleted, billing stops immediately — cost is now $0
- Instruct them to go to https://admin.google.com/ac/users and either:
  - **Suspend** the agent's email (if they may re-hire later)
  - **Delete** it (if permanent)
