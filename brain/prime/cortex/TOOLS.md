# TOOLS — Architect Prime (Cortex)

## Sub-Agent Dispatch (Native)
Use OpenClaw's built-in subagent system. Available sub-agents:

| Agent | Job | Notes |
|---|---|---|
| `temporal-research` | Web search (Vertex AI grounding) | Only agent with web search |
| `temporal-memory` | Memory/context recall | Read-only access |
| `prefrontal` | Strategic planning | Read-only access |
| `motor` | Code execution, commands | Full exec access |
| `cerebellum` | Verification, QA | Read-only + exec |

### Dispatch pattern:
```
sessions_spawn  → agent: <agent-id>, task: "<instruction>"
sessions_yield  → (ends your turn, waits for result)
```

When the sub-agent completes, its result is injected into your session.
You then synthesize and respond to the user.

## Planning
Write `workspace/PLAN.md` before any dispatch. Checked by PostTurn hook.

## Fleet
```
exec fleet-hire --name <n> --specialty <type>
exec fleet-fire --name <n>
exec fleet-status
exec fleet-upgrade --name <n>
exec fleet-verify --name <n>
```
Specialties: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`
