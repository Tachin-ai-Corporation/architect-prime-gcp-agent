# Skill: workspace-chat

## What this skill does
Send and read Google Chat messages using Domain-Wide Delegation.

## When to use
When Cortex dispatches you to send a message to a user or read chat history.

## Tools

### chat-send
```
exec chat-send --to <space-or-email> --text <message>
```

Sends a message to a Google Chat space or direct message.

### chat-read
```
exec chat-read --space <space-id> [--limit <n>]
```

Reads recent messages from a Chat space.

## Important
- Uses Domain-Wide Delegation (DWD) for authentication
- Outbound messages are delivered by Mouth, not Motor. `chat-send` and `chat-read` are system tools used by the delivery pipeline. Agents reference this skill to understand message formatting, but do not invoke chat-send directly.
