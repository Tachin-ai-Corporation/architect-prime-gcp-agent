# Skill: Google Chat

## When to Use
When the task involves sending messages to Google Chat spaces or direct messages, or reading recent message history from a space.

## Commands

### Read
- `chat-read --space <space-id> [--limit <n>]` — Read recent messages from a Chat space.
  Output: JSON array of message objects containing message ID, sender, and text.

### Write
- `chat-send --to <space-or-email> --text <message>` — Send a message to a Google Chat space or direct message.
  Output: Success confirmation with message details.

## Procedures

### Send a message to a space or user
1. Resolve the target space ID (e.g., `spaces/AAAA...`) or the user's email.
2. Run `chat-send --to "<space-or-email>" --text "<message>"` to send the message.
3. Verify: Confirm the output displays a success state with the message ID.

### Read message history from a space
1. Resolve the space ID.
2. Run `chat-read --space "<space-id>" --limit 10` to retrieve recent messages.
3. Verify: Confirm the output contains a list of message objects, showing text and sender details.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account is not a member of the space | Ask the user to add the agent's Google Workspace email to the Google Chat space. |
| `404 notFound` | Invalid space ID or user email | Check the format of the space ID (must start with `spaces/`) or verify the recipient's email address. |
| `400 invalidArgument` | Empty message text or missing required argument | Ensure `--text` is not empty, and both `--to` and `--text` are specified correctly. |
