# Skill: secrets

## What this skill does
Reads secrets from Google Secret Manager. Access is IAM-controlled —
secret grants are managed via the dashboard.

## When to use
When you need API keys, tokens, credentials, or any sensitive values
stored in Secret Manager.

## Tools

### secret-read
```
exec secret-read --name <secret-id>
```

Returns the secret value to stdout.

**Usage pattern — command substitution only:**
```bash
TOKEN=$(secret-read --name my-api-key)
curl -H "Authorization: Bearer $TOKEN" https://api.example.com
```

## Safety Rules
- ⚠️ NEVER echo, log, print, or write secret values to:
  - Chat messages or responses
  - Log files or MEMORY.md
  - Drive artifacts or shared files
  - Environment variable exports
- Use ONLY via command substitution in the same command
- Access is IAM-controlled — request grants via the dashboard
