# Skill: fleet-hire

## What this skill does
Deploys a new fleet agent. Creates the VM, service account, and all infrastructure. Returns in seconds — the actual deployment runs in background (3-5 minutes).

## When to use
- User asks to hire, deploy, create, or spin up a new agent
- User says something like "I need a devops agent" or "hire a pm named anora"

## Command
```
fleet-hire --name <name> --specialty <specialty>
```

### Arguments
- `--name` — Agent name, lowercase, no spaces (e.g. "stan", "anora", "quinn")
- `--specialty` — Agent type: devops, swe, qa, pm, finance, data, security

### Example
```
fleet-hire --name anora --specialty pm
```

## Hiring flow
1. If the user hasn't specified a specialty, show available types by running:
   ```
   cat ~/.openclaw/corekit/agent-types.json
   ```
2. Once you have **name** and **specialty**, run `fleet-hire` immediately
3. The output includes the admin setup instructions — share these with the user

## After hiring — walk the user through setup
The output from `fleet-hire` contains exact names and email. Always share these steps:

1. **Create the Workspace user** at https://admin.google.com/ac/users → Add new user
   - First Name, Last Name, and Email come from the output
   - ⚠️ Names MUST match exactly (including capitalization and hyphens)
2. **Add the email to the Google Chat space**
3. **Verify** by sending `@FirstName LastName hello` in Chat

Be warm and helpful — you're onboarding a new team member, not running a script.
Use the agent's name naturally: "I'll get anora set up for you!"
