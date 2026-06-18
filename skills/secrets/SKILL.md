# Skill: Secret Manager

## When to Use
When the task requires reading API keys, tokens, or credentials from Google Cloud Secret Manager.

## Commands

### Read
- `secret-read --name <secret-id>` — Read a secret value from Secret Manager.
  Output: Raw secret value (printed directly to stdout).

## Safety Rules
- ⚠️ **NEVER** print, echo, log, or save secret values to files, chat responses, or environment variables.
- **Command Substitution:** Only retrieve secrets via inline command substitution in shell executions:
  `TOKEN=$(secret-read --name my-api-key) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com`

## Procedures

### Retrieve a secret for an API call
1. Identify the name of the secret in Secret Manager.
2. Construct a command using inline command substitution (e.g. `TOKEN=$(secret-read --name api-token) && curl ...`).
3. Verify: Ensure the curl command succeeds without logging the token value itself.

### Verify access to a secret
1. Run `secret-read --name <secret-id> > /dev/null` to check accessibility without outputting the secret.
2. Verify: Ensure the exit code is 0, which confirms authorization.
