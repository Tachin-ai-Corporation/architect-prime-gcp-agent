# Skill: agent-ask

## What this skill does
Answers questions using real-time knowledge from Google Search via Vertex AI grounding.
This is a read-only skill — it does not modify any state or infrastructure.

## When to use
Dispatch to the `temporal-research` sub-agent when you need current, real-time
information from the web. This is the ONLY sanctioned web-search path.

## How it works
Invoked via `exec agent-ask "<question>"` by the temporal-research sub-agent.
Uses Vertex AI with Google Search grounding (model and region read from contracts.json).
**Do NOT call agent-ask directly from Cortex** — route web research through
the temporal-research pipeline step in your dispatch plan.

## Behavior
- Answer accurately and concisely
- Use markdown formatting sparingly (bold, bullet points)
- Keep responses under 3800 characters (truncated to fit Chat limit)
- If you don't know something, say so honestly
- Include source citations when available from grounding
