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

---

### Write-Command Blocklist (Read-Only Enforcement)

Audit missions are strictly read-only. NEVER execute any of the following — refuse and return the recommended command for human operator approval instead:

- `gcloud projects add-iam-policy-binding` / `remove-iam-policy-binding` / `set-iam-policy` — modifies or replaces IAM policy
- `gcloud iam service-accounts create|delete|enable|disable` — modifies service accounts
- `gcloud iam service-accounts keys create|delete` — creates or deletes SA keys
- `gcloud compute firewall-rules create|update|delete` — modifies firewall
- `gcloud org-policies set-policy|reset` — modifies org policy
- `gcloud storage buckets update` — modifies bucket config
- `gsutil iam set|ch` — modifies bucket IAM
- Any binding mutation containing both `--member=` and `--role=`
- Any `terraform apply` or `terraform destroy`

Refusal message: "Blocked: Security motor cannot execute write operations. Returning recommended command for human operator approval."

Verification (cerebellum): scan motor output for the patterns `add-iam-policy-binding`, `remove-iam-policy-binding`, `set-iam-policy`, `keys create`, `keys delete`, `firewall-rules create|update|delete`, `set-policy`, `buckets update` — any hit taints the finding set and must be flagged as a compliance violation.

### Extended Discovery Reference

| What | Command |
|------|---------|
| Full IAM policy snapshot (JSON, for diffing) | `gcloud projects get-iam-policy PROJECT --format=json > iam-policy.json` |
| Org-level IAM policy | `gcloud organizations get-iam-policy ORG_ID` |
| IAM policy on a service account | `gcloud iam service-accounts get-iam-policy SA_EMAIL` |
| Role definition | `gcloud iam roles describe ROLE` |
| Networks / subnets | `gcloud compute networks list --project=PROJECT` / `gcloud compute networks subnets list --project=PROJECT` |
| Resource inventory | `gcloud compute instances list`, `gcloud run services list`, `gcloud sql instances list`, `gcloud functions list`, `gcloud storage ls` (all with `--project=PROJECT`) |
| Audit logs | `gcloud logging read "FILTER" --project=PROJECT --limit=50` |
| Log sinks / alert policies | `gcloud logging sinks list --project=PROJECT` / `gcloud monitoring policies list --project=PROJECT` |
| Org policies in effect | `gcloud org-policies list --project=PROJECT` / `gcloud org-policies describe CONSTRAINT --project=PROJECT` |
| Asset inventory — IAM | `gcloud asset search-all-iam-policies --scope=projects/PROJECT` |
| Asset inventory — resources | `gcloud asset search-all-resources --scope=projects/PROJECT --asset-types=TYPE` |

### Check for External Principals
1. List all members outside the expected domain:
   ```bash
   gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="value(bindings.members)" | grep -v "@EXPECTED_DOMAIN" | sort -u
   ```
2. Verify: cross-check each external principal against known exceptions before flagging.

### Audit Service Account Key Age
1. List every SA's user-managed keys with validity dates:
   ```bash
   for sa in $(gcloud iam service-accounts list --project=PROJECT --format="value(email)"); do
     echo "=== $sa ==="
     gcloud iam service-accounts keys list --iam-account=$sa --managed-by=user --format="table(KEY_ID,validAfterTime,validBeforeTime)"
   done
   ```
2. Verify: flag keys older than 90 days, citing the exact `validAfterTime`.

### Check Cloud Run Public Ingress
1. Identify services whose ingress is not internal:
   ```bash
   gcloud run services list --project=PROJECT --format=json | jq '.[] | select(.spec.template.metadata.annotations["run.googleapis.com/ingress"] != "internal")'
   ```
2. Verify: document each non-internal service and whether public exposure is intended.

### Check Bucket Public-Access Prevention
1. Inspect each bucket's IAM configuration and public-access-prevention setting:
   ```bash
   for bucket in $(gcloud storage ls --project=PROJECT); do
     gcloud storage buckets describe $bucket --format=json | jq '{bucket: .name, iamConfiguration: .iamConfiguration, publicAccessPrevention: .iamConfiguration.publicAccessPrevention}'
   done
   ```
2. Verify: flag any bucket without `publicAccessPrevention: enforced` that holds sensitive data.

### Remediation Recommendation Format

Never execute remediation commands — always return them as recommendations:

```
RECOMMENDED REMEDIATION (requires human approval):
  Command: gcloud projects remove-iam-policy-binding PROJECT \
    --member=MEMBER --role=ROLE
  Rollback: gcloud projects add-iam-policy-binding PROJECT \
    --member=MEMBER --role=ROLE
  Risk: [Low/Medium/High] — description of what this changes
```

Every recommendation must include a rollback command and a risk statement.
