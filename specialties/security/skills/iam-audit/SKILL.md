# Skill: IAM Security Audit Operations

Use these procedures when performing IAM security audits via `exec`.

## IAM Policy Dump

| What | Command |
|------|---------|
| Project IAM policy | `gcloud projects get-iam-policy PROJECT --format=json` |
| Flat member/role view | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)"` |
| Filter to service accounts | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:serviceAccount"` |
| Filter to users | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:user:"` |
| Roles for specific member | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role)" --filter="bindings.members:MEMBER_EMAIL"` |
| List custom roles | `gcloud iam roles list --project=PROJECT --format="table(name,title,stage)"` |

### High-Risk Roles to Flag
- `roles/owner` — full project control
- `roles/editor` — broad write access
- `roles/iam.securityAdmin` — can modify IAM policies
- `roles/iam.serviceAccountTokenCreator` — can impersonate SAs
- `roles/storage.admin` — full GCS access
- `roles/bigquery.admin` — full BQ access

## Service Account Key Audit

```bash
# List all service accounts
gcloud iam service-accounts list --project=PROJECT --format=json

# List keys for a service account
gcloud iam service-accounts keys list \
  --iam-account=SA@PROJECT.iam.gserviceaccount.com \
  --format="table(name.basename(),validAfterTime,validBeforeTime,keyType)"

# Find user-managed keys (security risk)
gcloud iam service-accounts keys list \
  --iam-account=SA@PROJECT.iam.gserviceaccount.com \
  --filter="keyType=USER_MANAGED" \
  --format=json

# Audit ALL service accounts for user-managed keys
for sa in $(gcloud iam service-accounts list --project=PROJECT --format="value(email)"); do
  keys=$(gcloud iam service-accounts keys list --iam-account=$sa --filter="keyType=USER_MANAGED" --format="value(name)" 2>/dev/null)
  if [ -n "$keys" ]; then
    echo "⚠️  $sa has user-managed keys:"
    echo "$keys"
  fi
done

# Find keys older than 90 days
gcloud iam service-accounts keys list \
  --iam-account=SA@PROJECT.iam.gserviceaccount.com \
  --filter="keyType=USER_MANAGED AND validAfterTime<'-P90D'" \
  --format="table(name.basename(),validAfterTime)"
```

## Public Resource Scanning

### Firewall Rules
```bash
# List all firewall rules
gcloud compute firewall-rules list --project=PROJECT --format=json

# Find rules allowing 0.0.0.0/0 (open to internet)
gcloud compute firewall-rules list --project=PROJECT \
  --filter="sourceRanges:0.0.0.0/0 AND direction=INGRESS" \
  --format="table(name,allowed[].map().firewall_rule().list():label=ALLOWED,sourceRanges)"

# Find rules with broad port ranges
gcloud compute firewall-rules list --project=PROJECT \
  --filter="sourceRanges:0.0.0.0/0 AND allowed.ports:*" \
  --format=json

# SSH/RDP open to internet
gcloud compute firewall-rules list --project=PROJECT \
  --filter="sourceRanges:0.0.0.0/0 AND (allowed.ports:22 OR allowed.ports:3389)" \
  --format="table(name,allowed,sourceRanges)"
```

### Public Storage
```bash
# List buckets
gsutil ls -p PROJECT

# Check bucket IAM for public access
gsutil iam get gs://BUCKET_NAME | grep -i "allUsers\|allAuthenticatedUsers"

# Scan all buckets for public access
for bucket in $(gsutil ls -p PROJECT); do
  public=$(gsutil iam get $bucket 2>/dev/null | grep -c "allUsers\|allAuthenticatedUsers")
  if [ "$public" -gt 0 ]; then
    echo "⚠️  PUBLIC: $bucket"
  fi
done
```

### Public Cloud Run Services
```bash
# Find unauthenticated Cloud Run services
gcloud run services list --project=PROJECT --format=json | \
  python3 -c "
import json, sys
services = json.load(sys.stdin)
for s in services:
    name = s['metadata']['name']
    # Check IAM for allUsers
    import subprocess
    result = subprocess.run(['gcloud', 'run', 'services', 'get-iam-policy', name,
                           '--project=PROJECT', '--format=json'], capture_output=True, text=True)
    if 'allUsers' in result.stdout:
        print(f'⚠️  PUBLIC: {name}')
"
```

## External Principal Detection

```bash
# Find external (non-org) principals in IAM
gcloud projects get-iam-policy PROJECT --format=json | \
  python3 -c "
import json, sys
policy = json.load(sys.stdin)
org_domains = ['your-org.com']  # Set your org domain(s)
for binding in policy.get('bindings', []):
    for member in binding.get('members', []):
        if member.startswith('user:') or member.startswith('serviceAccount:'):
            email = member.split(':', 1)[1]
            domain = email.split('@')[-1]
            if not any(domain.endswith(d) for d in org_domains + ['iam.gserviceaccount.com']):
                print(f'⚠️  External: {member} → {binding[\"role\"]}')
"

# Find domain-wide delegation enabled on service accounts
gcloud iam service-accounts list --project=PROJECT \
  --format="table(email,displayName)" \
  --filter="oauth2ClientId:*"
```

## Role Recommendation Check

```bash
# Get IAM recommender insights
gcloud recommender recommendations list \
  --project=PROJECT \
  --recommender=google.iam.policy.Recommender \
  --location=global \
  --format="table(name,description,primaryImpact.category)"

# Get IAM insights (unused permissions)
gcloud recommender insights list \
  --project=PROJECT \
  --insight-type=google.iam.policy.Insight \
  --location=global \
  --format=json

# Detailed recommendation
gcloud recommender recommendations describe RECOMMENDATION_ID \
  --project=PROJECT \
  --recommender=google.iam.policy.Recommender \
  --location=global \
  --format=json
```

## Organization Policy Audit

```bash
# List org policies on project
gcloud org-policies list --project=PROJECT --format="table(constraint,listPolicy,booleanPolicy)"

# Check specific policy
gcloud org-policies describe CONSTRAINT_NAME --project=PROJECT

# Key policies to check
# - constraints/iam.disableServiceAccountKeyCreation
# - constraints/compute.requireShieldedVm
# - constraints/storage.uniformBucketLevelAccess
# - constraints/iam.allowedPolicyMemberDomains
# - constraints/compute.restrictPublicIP

for policy in \
  "constraints/iam.disableServiceAccountKeyCreation" \
  "constraints/storage.uniformBucketLevelAccess" \
  "constraints/compute.restrictPublicIP" \
  "constraints/iam.allowedPolicyMemberDomains"; do
  echo "=== $policy ==="
  gcloud org-policies describe $policy --project=PROJECT 2>&1 || echo "NOT SET"
done
```

## Finding Report Template

Structure audit findings using this format:

```markdown
## IAM Security Audit Report

**Project:** PROJECT_ID
**Date:** YYYY-MM-DD
**Auditor:** agent-name

### 🔴 Critical Findings
- FINDING — Description, impact, remediation

### 🟡 Warnings
- FINDING — Description, recommendation

### ✅ Passing Checks
- CHECK — Status

### 📊 Summary
| Category | Count |
|----------|-------|
| Service accounts | N |
| User-managed keys | N |
| Public firewall rules | N |
| External principals | N |
| Overprivileged roles | N |

### Recommendations
1. ACTION — Priority, effort estimate
2. ACTION — Priority, effort estimate
```

## Safety Rules
- **Read-only operations only** — never modify IAM policies during audit
- Always include `--project=PROJECT` to avoid cross-project confusion
- Use `--format=json` for machine-readable output when chaining commands
- Redact sensitive data (key IDs, email addresses) in external reports
- Never output service account key material
- Flag but don't delete — all remediation requires explicit approval
