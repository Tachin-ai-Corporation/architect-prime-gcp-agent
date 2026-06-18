# Skill: IAM Security Audit Operations

## When to Use
When auditing GCP IAM policies, listing service account keys, scanning compute firewall rules for internet exposure, inspecting GCS buckets for public access, or collecting Recommender insights.

## Commands

No custom corekit scripts are governed directly by this skill. Standard `gcloud` and `gsutil` CLI commands are used.

## Procedures

### Conduct a Project IAM Policy and Key Audit
1. Run the command to retrieve the flat member-to-role mappings:
   ```bash
   gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)"
   ```
2. Scan for high-risk roles (e.g. `roles/owner`, `roles/editor`, `roles/iam.securityAdmin`).
3. Scan for user-managed keys across all service accounts:
   ```bash
   for sa in $(gcloud iam service-accounts list --project=PROJECT --format="value(email)"); do
     gcloud iam service-accounts keys list --iam-account=$sa --filter="keyType=USER_MANAGED" --format="value(name)"
   done
   ```
4. Verify: Ensure any user-managed keys or high-risk roles are logged with their expiration dates and owner accounts.

### Scan for Publicly Exposed Resources
1. Identify firewall rules open to the internet (allowing `0.0.0.0/0` ingress):
   ```bash
   gcloud compute firewall-rules list --project=PROJECT --filter="sourceRanges:0.0.0.0/0 AND direction=INGRESS"
   ```
2. Identify public Cloud Storage buckets:
   ```bash
   for bucket in $(gsutil ls -p PROJECT); do
     gsutil iam get $bucket 2>/dev/null | grep -i "allUsers\|allAuthenticatedUsers"
   done
   ```
3. Verify: Document any exposed ports (especially SSH port 22 or RDP port 3389) or public buckets in the audit report.

### Retrieve IAM recommender insights and generate report
1. Query Google's IAM policy recommender:
   ```bash
   gcloud recommender recommendations list \
     --project=PROJECT \
     --recommender=google.iam.policy.Recommender \
     --location=global
   ```
2. Generate the report following the structured findings template, listing Critical Findings, Warnings, Passing Checks, and a metrics summary table.
3. Verify: Confirm the recommendations section outlines specific actions with priority and effort estimates.

---

## Detailed Reference

### Discovery Reference
| What | Command |
|------|---------|
| Flat member/role view | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)"` |
| Filter to service accounts | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:serviceAccount"` |
| List custom roles | `gcloud iam roles list --project=PROJECT --format="table(name,title,stage)"` |

### Key Org Policies to Check
- `constraints/iam.disableServiceAccountKeyCreation`
- `constraints/storage.uniformBucketLevelAccess`
- `constraints/compute.restrictPublicIP`
- `constraints/iam.allowedPolicyMemberDomains`

## Safety Rules
- **Read-only operations only** — never modify IAM policies during audit
- Always include `--project=PROJECT` to avoid cross-project confusion
- Use `--format=json` for machine-readable output when chaining commands
- Redact sensitive data (key IDs, email addresses) in external reports
- Never output service account key material
- Flag but don't delete — all remediation requires explicit approval
