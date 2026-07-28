# Skill: Secret Manager

## When to Use
When the task requires reading API keys, tokens, or credentials from Google Cloud Secret Manager.

## Commands

### Read
- `secret-read --name <secret-id> [--version latest]` — Read a secret value from Secret Manager.
  Output: Raw secret value (printed directly to stdout).

**`--name` takes the FULL Secret Manager id — nothing is prepended for you.**
Secrets created through the dashboard are stored as `aps-secret-<label>`, so the
secret shown as `github-token` is read with `--name aps-secret-github-token`.
Passing the bare label returns "not found".

## Safety Rules
- ⚠️ **NEVER** print, echo, log, or save secret values to files, chat responses, or environment variables.
- **Command Substitution:** Only retrieve secrets via inline command substitution in shell executions:
  `TOKEN=$(secret-read --name my-api-key) && curl -H "Authorization: Bearer $TOKEN" https://api.example.com`

## Procedures

### Retrieve a secret for an API call
1. Identify the full Secret Manager id (dashboard secrets carry the `aps-secret-` prefix).
2. Construct a command using inline command substitution (e.g. `TOKEN=$(secret-read --name aps-secret-api-token) && curl ...`).
3. Verify: Ensure the curl command succeeds without logging the token value itself.

### Verify access to a secret
1. Run `secret-read --name <secret-id> > /dev/null` to check accessibility without outputting the secret.
2. Verify: Ensure the exit code is 0, which confirms authorization.

## Error Recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `Secret '<x>' ... not found` | Bare label passed instead of the full id | Retry with the `aps-secret-` prefix: `--name aps-secret-<x>`. |
| `Access denied to secret` | VM service account lacks the role | Grant `roles/secretmanager.secretAccessor` on that secret to this VM's SA, or request access via the dashboard. |
