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
Cortex returns structured JSON decisions. The `agent-brain` daemon handles all dispatching via HTTP.

```json
{ "action": "dispatch", "agent": "motor", "intent": "execute", "task": "...", "accept_criteria": "..." }
```

Brain dispatches to the sub-agent, collects the result, and calls Cortex again with the result in `prior_results`.
Cortex then synthesizes the final response.

## Fleet
```
exec fleet-hire --name <n> --specialty <type>
exec fleet-fire --name <n>
exec fleet-status
exec fleet-upgrade --name <n>
exec fleet-verify --name <n>
```
Specialties: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`
