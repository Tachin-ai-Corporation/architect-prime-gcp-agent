# TOOLS — Architect Prime (Cortex)

## Brain Dispatch (exec)

### Dispatch a brain sub-agent
```
exec brain-exec <agent-id> "<instruction>" [timeout]
```
Runs the sub-agent synchronously via `brain-exec` (wraps `openclaw agent`,
strips infrastructure warnings). Returns clean text output to synthesize.

### Available agents:
| agentId | Job | When to use |
|---|---|---|
| `temporal-research` | Web search (agent-ask) | Current info, prices, news, URLs |
| `temporal-memory` | Memory recall | Past decisions, context, history |
| `prefrontal` | Strategic planning | Complex multi-step tasks |
| `motor` | Execution (code, commands) | Implementing plan steps |
| `cerebellum` | Verification (QA) | Checking motor's output |

### Timeout budgets (MANDATORY — always include):
| agentId | Timeout |
|---|---|
| `temporal-research` | `150` |
| `temporal-memory` | `60` |
| `prefrontal` | `90` |
| `motor` | `150` |
| `cerebellum` | `60` |

## Planning (write)

### Write dispatch plan (MANDATORY before dispatch)
```
write workspace/PLAN.md
```
Content format:
```
TASK: [summary]
CATEGORY: [classification]
DISPATCHES:
1. [agent-id] — [task]
EXPECTED OUTCOME: [result description]
```
This file is checked by the PostTurn compliance hook. If you dispatch
brain agents without writing PLAN.md first, a compliance violation
is logged.

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

## Response Delivery (exec)

### Deliver response to the user's channel
```
exec channel-respond "Your response text"
```
Routes automatically to Dashboard (Firestore) or Google Chat depending
on which channel the message came from. **Use for all dispatch results.**
Do NOT use for non-dispatch turns (identity, fleet commands).

For intermediate progress updates during long work:
```
exec channel-respond "🔄 Research complete. Synthesizing..."
```

## Rules
- ALWAYS use `exec brain-exec <agent-id> "<task>" <timeout>` for brain dispatch.
- ALWAYS write PLAN.md before any brain dispatch.
- ALWAYS include the timeout argument from the dispatch budget table.
- ALWAYS use `exec channel-respond` to deliver results after dispatch.
- Fleet operations: exec directly. No brain dispatch or PLAN.md needed.
- The `brain-exec` wrapper is on PATH at `~/.openclaw/bin/brain-exec`.
- The `channel-respond` script is on PATH at `~/.openclaw/bin/channel-respond`.
