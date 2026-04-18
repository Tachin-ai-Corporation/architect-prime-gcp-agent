# TOOLS — Architect Prime (Cortex)

## Brain Dispatch (sessions_spawn)

### Spawn a brain sub-agent (NON-BLOCKING)
```
sessions_spawn(task: "<instruction>", agentId: "<agent_id>")
```

The sub-agent runs in the background. When it finishes, it announces its
result back to my session. I then synthesize and deliver.

### Available agents:
| agentId | Job | When to use |
|---|---|---|
| `temporal-research` | Web search (agent-ask) | Current info, prices, news |
| `temporal-memory` | Memory recall | Past decisions, context, history |
| `prefrontal` | Strategic planning | Complex multi-step tasks |
| `motor` | Execution (code, commands) | Implementing plan steps |
| `cerebellum` | Verification (QA) | Checking motor's output |

### Override model for heavy tasks:
```
sessions_spawn(task: "...", agentId: "prefrontal", model: "google-vertex/gemini-2.5-pro")
```

## Async Response Delivery (exec)

### Write a follow-up response to dashboard
```
exec dashboard-respond "Your synthesized response text"
```
Used after sub-agent announces when the original request-response is complete.

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
- ALWAYS use `sessions_spawn` for brain dispatch. Never exec brain-dispatch.
- ALWAYS use `exec dashboard-respond` for async follow-up delivery.
- Fleet operations: exec directly. No brain dispatch needed.
