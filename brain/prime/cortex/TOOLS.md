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

## Fleet
```
exec fleet-hire --name <n> --specialty <type>
exec fleet-fire --name <n>
exec fleet-status
exec fleet-upgrade --name <n>
exec fleet-verify --name <n>
```
Specialties: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`

## Response Delivery (after yield only)
After yielding and receiving a sub-agent's result, deliver the synthesized response:
```
exec channel-respond "Your full synthesized response text"
```
- Routes to the correct channel (dashboard/Firestore or Google Chat)
- Reads channel metadata from `workspace/TASK.json` (written by daemon)
- **MUST be called** after yield+synthesis — without it, the user never sees the response
- **Do NOT use** for direct responses (identity, fleet) — those are auto-delivered
- Handles long responses — pass the full text as a single quoted argument
