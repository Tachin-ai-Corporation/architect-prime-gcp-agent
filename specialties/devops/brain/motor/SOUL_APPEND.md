# DevOps Specialty — Motor Operational Procedures

## Infrastructure Discovery (run before major operations)

Before performing infrastructure changes, always discover current state first.
Never assume resource names, service accounts, or project numbers.

### Discovery Commands
```bash
# Service accounts in a project
gcloud iam service-accounts list --project=$PROJECT --format="table(email,displayName,disabled)"

# Enabled APIs
gcloud services list --enabled --project=$PROJECT --format="table(NAME)" | head -30

# IAM policy — who has what role (service accounts only)
gcloud projects get-iam-policy $PROJECT --flatten="bindings[].members" \
  --format="table(bindings.role,bindings.members)" \
  --filter="bindings.members:serviceAccount" 2>/dev/null | head -40

# Cloud Run services
gcloud run services list --project=$PROJECT --format="table(SERVICE,REGION,URL)" 2>/dev/null

# Cloud Build triggers
gcloud builds triggers list --project=$PROJECT --format="table(name,createTime)" 2>/dev/null

# Compute instances
gcloud compute instances list --project=$PROJECT --format="table(NAME,ZONE,STATUS)" 2>/dev/null

# Project number (needed for default SA references)
gcloud projects describe $PROJECT --format="value(projectNumber)"
```

## Service Account Workflow

When a service account is needed for a task:

1. **List existing SAs**: `gcloud iam service-accounts list --project=$PROJECT`
2. **Check if a suitable one already exists** — don't create duplicates
3. **If not, CREATE it**:
   ```bash
   gcloud iam service-accounts create SA_NAME \
     --display-name="Description" \
     --project=$PROJECT
   ```
4. **Grant required roles**:
   ```bash
   gcloud projects add-iam-policy-binding $PROJECT \
     --member=serviceAccount:SA_NAME@$PROJECT.iam.gserviceaccount.com \
     --role=roles/ROLE_NAME
   ```
5. **Report the ACTUAL email** from the create/list output — never fabricate one

## Cloud Run Deployment Checklist

1. Verify Artifact Registry repo exists:
   `gcloud artifacts repositories list --project=$PROJECT --location=$REGION`
2. If needed, create repo:
   `gcloud artifacts repositories create REPO --repository-format=docker --location=$REGION --project=$PROJECT`
3. Build and push image (or use Cloud Build)
4. Deploy:
   ```bash
   gcloud run deploy SERVICE_NAME \
     --image=$REGION-docker.pkg.dev/$PROJECT/REPO/IMAGE:TAG \
     --region=$REGION --project=$PROJECT \
     --allow-unauthenticated  # or --no-allow-unauthenticated
   ```
5. Verify: `gcloud run services describe SERVICE_NAME --region=$REGION --project=$PROJECT`
6. Test endpoint: `curl -s SERVICE_URL/health`

## API Enablement

Before using any GCP API, verify it's enabled:
```bash
# Check
gcloud services list --enabled --project=$PROJECT --filter="NAME:SERVICE_NAME"
# Enable if needed
gcloud services enable SERVICE_NAME.googleapis.com --project=$PROJECT
```

Common APIs for devops tasks:
- `run.googleapis.com` — Cloud Run
- `cloudbuild.googleapis.com` — Cloud Build
- `artifactregistry.googleapis.com` — Artifact Registry
- `cloudfunctions.googleapis.com` — Cloud Functions
- `drive.googleapis.com` — Google Drive API
- `compute.googleapis.com` — Compute Engine

## Error Recovery Patterns

| Error | Discovery | Fix |
|-------|-----------|-----|
| Permission denied (403) | `gcloud projects get-iam-policy $PROJECT` | Report exact SA + missing role to user |
| API not enabled | `gcloud services list --enabled --project=$PROJECT` | `gcloud services enable API --project=$PROJECT` |
| Quota exceeded | `gcloud compute project-info describe --project=$PROJECT` | Report quota name + current usage |
| Resource not found | Appropriate `gcloud ... list` command | Verify name, check correct project/region |
| Scope insufficient | Check what scopes the SA/ADC has | May need a dedicated SA with correct scopes |

## Safety Rules

- **Always verify before modifying**: list resources before deleting/updating
- **Include rollback plan** for any destructive operation
- **Never fabricate resource names** — always discover them first
- **Test in isolation** when possible (use `--dry-run` flags where available)
