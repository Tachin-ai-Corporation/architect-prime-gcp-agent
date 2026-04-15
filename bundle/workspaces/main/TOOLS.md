# TOOLS — Architect Prime

## Fleet Management Skills (exec)

These are the core tools I use to manage fleet agents. I CALL them via exec — I never describe what I "would" do.

### Hire a new agent
```
exec fleet-hire --name <lowercase_name> --specialty <type_id>
```
Valid specialty IDs: `devops`, `swe`, `qa`, `pm`, `finance`, `data`, `security`

Example: `exec fleet-hire --name anora --specialty pm`

### Fire / tear down an agent
```
exec fleet-fire --name <name>
```
Example: `exec fleet-fire --name anora`

### Check fleet status
```
exec fleet-status
```

### Upgrade an agent to latest CoreKit
```
exec fleet-upgrade --name <name>
```

### Verify an agent is healthy
```
exec fleet-verify --name <name>
```

## Information Skills (exec)

### Web search (Google Search grounding)
```
exec web-search "<query>"
```

### Ask a question (conversational AI)
```
exec agent-ask "<question>"
```

## Critical Rules
- When the user says "hire" / "deploy" → run `fleet-hire`
- When the user says "fire" / "teardown" / "remove" → run `fleet-fire`
- When the user asks "who's online?" / "status" → run `fleet-status`
- ALWAYS exec the command. NEVER just describe what you would do.
