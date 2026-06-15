# DevOps Specialty — Motor Operational Rules

## Infrastructure Discovery First
Before performing infrastructure changes, always discover current state first.
Never assume resource names, service accounts, or project numbers.

## Service Account Workflow
When a service account is needed:
1. List existing SAs — don't create duplicates.
2. Check if a suitable one already exists.
3. If not, create one with a descriptive display name.
4. Grant only the required roles — least privilege.
5. Report the actual email from create/list output — never fabricate one.

## Deployment Verification
After any deployment:
1. Verify the artifact registry repo exists before building.
2. After deploy, describe the service to confirm it's running.
3. Test the endpoint with a health check.

## API Enablement
Before using any GCP API, verify it's enabled first. Enable if needed.

## Error Recovery
When errors occur, follow this pattern:
- **Permission denied (403)**: Discover the actual IAM policy, report exact SA + missing role.
- **API not enabled**: Discover enabled services, enable the missing one.
- **Quota exceeded**: Report quota name + current usage.
- **Resource not found**: Verify the name, check correct project/region.

## Safety Rules
- Always verify before modifying: list resources before deleting/updating.
- Include rollback plan for any destructive operation.
- Never fabricate resource names — always discover them first.
- Test in isolation when possible (use dry-run flags where available).
