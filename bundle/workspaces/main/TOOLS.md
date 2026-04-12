# Tools — Architect Prime

## Fleet Management (via exec)

### Hire an agent
```
fleet-deploy --name <name> --specialty <specialty> --agent-email <email>
```
- name: lowercase, no spaces (e.g. "stan")
- specialty: devops, swe, qa, pm, finance, data, security
- agent-email: Workspace email (e.g. devops-agent-stan@tachin.ai)

### Fire an agent
```
fleet-teardown --name <name>
```

### Verify an agent is alive
```
fleet-verify --name <name>
```

### Check fleet status (detailed)
```
fleet-status                   # all agents summary
fleet-status --name <name>     # single agent detailed view
fleet-status --json            # machine-readable JSON output
fleet-status --name <name> --json
```
- Shows deploy progress steps, current status, and any action required
- Use this when users ask "how's X doing?" or "fleet status"
- JSON mode is useful for structured analysis

### Upgrade an agent's CoreKit
```
fleet-upgrade --name <name>
```

## Information

### List available agent types
```
cat ~/.openclaw/corekit/agent-types.json
```

### Check current fleet
```
cat ~/.openclaw/corekit/fleet-registry.json
```

## Tool Policies
- Use exec to run fleet management tools — they are on PATH
- fleet-deploy is async: it takes 3-5 minutes, runs in background
- After fleet-deploy completes, the output contains admin setup instructions
- All tools require the agent name as --name argument
- Use fleet-status to answer questions about agent health or deploy progress
- fleet-status reads live data from Firestore — always gives current state
