# TOOLS — Architect Prime (Cortex)

## Brain Dispatch
```
exec brain-exec <agent-id> "<instruction>" [timeout]
```
Fire-and-forget. Returns `✅ Dispatched`. Sub-agent delivers via `channel-respond`.

| Agent | Job | Timeout |
|---|---|---|
| `temporal-research` | Web search (Vertex AI grounding) | `150` |
| `temporal-memory` | Memory/context recall | `60` |
| `prefrontal` | Strategic planning | `90` |
| `motor` | Code execution, commands | `150` |
| `cerebellum` | Verification, QA | `60` |

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

## Response Delivery
```
exec channel-respond "text"
```
On dispatch turns: sub-agent handles this. Do NOT call it yourself.
