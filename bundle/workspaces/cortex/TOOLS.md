# TOOLS — Architect Prime (Cortex)

## Brain Dispatch (exec)

### Dispatch to a brain sub-agent
```
exec brain-dispatch --agent <agent_name> --message "<instruction>"
```
Valid agents: `temporal`, `prefrontal`, `motor`, `cerebellum`

**Temporal** — memory recall + web research (ALWAYS call first)
```
exec brain-dispatch --agent temporal --message "Recall context for: <query>"
```

**Prefrontal** — strategic planning (for complex tasks)
```
exec brain-dispatch --agent prefrontal --message "Plan: <task>. Context: <temporal output>"
```

**Motor** — execution (for each plan step)
```
exec brain-dispatch --agent motor --message "Execute: <step description>"
```

**Cerebellum** — verification (after each motor step)
```
exec brain-dispatch --agent cerebellum --message "Verify: <expected>. Actual: <motor output>"
```

## Fleet Management Skills (exec)

### Hire a new agent
```
exec fleet-hire --name <lowercase_name> --specialty <type_id>
```
Valid specialty IDs: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`

### Fire / tear down an agent
```
exec fleet-fire --name <name>
```

### Check fleet status
```
exec fleet-status
```

### Upgrade an agent to latest CoreKit
```
exec fleet-upgrade --name <name>
```

### Verify an agent is healthy
```
exec fleet-verify --name <name>
```

## Memory Skills (exec)

### Write a fact to Core Memory (Firestore)
```
exec core-memory-write --fact "<durable fact>" --category <category> --tags "tag1,tag2"
```
Categories: architecture, operations, iam, decisions, patterns, errors

### Read Core Memory
```
exec core-memory-read --category <category>
```

## Critical Rules
- ALWAYS dispatch temporal FIRST on every turn
- When user says "hire" / "deploy" → run fleet-hire
- When user says "fire" / "teardown" / "remove" → run fleet-fire
- When user asks "who's online?" / "status" → run fleet-status
- ALWAYS exec the command. NEVER just describe what you would do.
