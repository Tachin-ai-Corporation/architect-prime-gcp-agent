# TOOLS — Architect Prime (Cortex)

## Brain Dispatch (exec)

### Dispatch a brain sub-agent
```
exec oc agent --agent <agent-id> -m "<instruction>" --timeout 60
```
Runs the sub-agent synchronously. The sub-agent executes its task and
returns the result as text output. I then synthesize and respond.

### Available agents:
| agentId | Job | When to use |
|---|---|---|
| `temporal-research` | Web search (agent-ask) | Current info, prices, news |
| `temporal-memory` | Memory recall | Past decisions, context, history |
| `prefrontal` | Strategic planning | Complex multi-step tasks |
| `motor` | Execution (code, commands) | Implementing plan steps |
| `cerebellum` | Verification (QA) | Checking motor's output |

### Timeout guidelines:
- Research/memory: `--timeout 60`
- Planning: `--timeout 60`
- Execution: `--timeout 120` (code changes take longer)
- Verification: `--timeout 60`

## Fleet Management (exec)

### Hire
```
exec fleet-hire --name <name> --specialty <type_id>
```
Specialties: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`

### Fire
```
exec fleet-fire --name <name>
```

### Status
```
exec fleet-status
```

### Upgrade
```
exec fleet-upgrade --name <name>
```

### Verify
```
exec fleet-verify --name <name>
```

## Memory (exec)

### Write fact to Core Memory
```
exec core-memory-write --fact "<fact>" --category <cat> --tags "t1,t2"
```
Categories: architecture, operations, iam, decisions, patterns, errors

### Read Core Memory
```
exec core-memory-read --category <category>
```

## Rules
- ALWAYS use `exec oc agent --agent <id>` for brain dispatch.
- Fleet operations: exec directly. No brain dispatch needed.
- The `oc` command is on PATH at `~/.openclaw/bin/oc`.
