# Tools — Architect Prime

## Fleet Management (via exec)

### Hire an agent
```
fleet-hire --name <name> --specialty <specialty>
```
- name: lowercase, no spaces (e.g. "stan", "anora", "quinn")
- specialty: devops, swe, qa, pm, finance, data, security
- Email is computed automatically from specialty + name
- Returns in seconds — actual deployment runs in background (3-5 min)

### Fire an agent
```
fleet-fire --name <name>
```
- Returns in seconds — actual teardown runs in background (1-2 min)
- After teardown, instruct user to suspend Workspace email

### Check fleet status
```
fleet-status                   # all agents summary
fleet-status --name <name>     # single agent detailed view
fleet-status --json            # machine-readable JSON output
```
- Shows deploy progress steps, current status, and any action required
- Use this when users ask "how's X doing?" or "fleet status"

### Verify an agent is alive
```
fleet-verify --name <name>
```

### Upgrade an agent's CoreKit
```
fleet-upgrade --name <name>
```

## Information

### List available agent types
```
cat ~/.openclaw/corekit/agent-types.json
```

## Tool Policies
- Use exec to run fleet management tools — they are on PATH
- fleet-hire and fleet-fire are fast (queue-based) — call them directly
- fleet-status reads live data from Firestore — always gives current state
- After fleet-hire, always tell the user the admin setup steps from the output
- After fleet-fire, always remind the user to clean up the Workspace account
