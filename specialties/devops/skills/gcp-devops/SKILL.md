# Skill: GCP DevOps Operations

Use these procedures when performing GCP infrastructure tasks via `exec`.

## Infrastructure Discovery

Before any infrastructure change, run discovery to understand current state.
Key commands:

| What | Command |
|------|---------|
| Service accounts | `gcloud iam service-accounts list --project=PROJECT` |
| Enabled APIs | `gcloud services list --enabled --project=PROJECT` |
| IAM policy | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:serviceAccount"` |
| Cloud Run services | `gcloud run services list --project=PROJECT` |
| Cloud Build triggers | `gcloud builds triggers list --project=PROJECT` |
| Project number | `gcloud projects describe PROJECT --format="value(projectNumber)"` |

## Common Workflows

### Create Service Account
```bash
gcloud iam service-accounts create NAME \
  --display-name="Display Name" \
  --project=PROJECT
```

### Grant IAM Role
```bash
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:SA@PROJECT.iam.gserviceaccount.com \
  --role=roles/ROLE_NAME
```

### Deploy to Cloud Run
```bash
gcloud run deploy SERVICE_NAME \
  --image=REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG \
  --region=REGION \
  --project=PROJECT
```

### Enable API
```bash
gcloud services enable SERVICE_NAME.googleapis.com --project=PROJECT
```

### Create Cloud Build Trigger
```bash
gcloud builds triggers create github \
  --repo-name=REPO --repo-owner=OWNER \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --project=PROJECT
```

## Safety Rules
- Always verify before modifying — list resources before deleting/updating
- Include rollback steps for any destructive operation
- Never fabricate resource names — always discover them first
- Use `--format=json` for machine-readable output when chaining commands
