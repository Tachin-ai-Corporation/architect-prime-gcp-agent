# Skill: fleet-upgrade

## What this skill does
Upgrades a fleet agent's CoreKit to the latest version. Returns in seconds — the actual upgrade runs in background.

## When to use
- User asks to upgrade, update, or patch an agent
- User says "upgrade stan" or "update anora's corekit"

## Command
```
fleet-upgrade --name <name>
```

### Arguments
- `--name` — Agent name to upgrade (e.g. "stan", "anora")
