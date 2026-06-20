# Skill: GCP DevOps Operations

## When to Use
When performing GCP infrastructure tasks (service accounts, IAM, Cloud Run, Cloud Build) using CLI tools.

## Commands

### Read
- `gcloud` — Google Cloud CLI for resource discovery, checking service status, and listing IAM policy bindings.
- `gsutil` — Google Cloud Storage CLI for listing buckets and viewing object metadata.
- `firebase` — Firebase CLI for querying Hosting sites, channels, and Firestore indexes.

### Write
- `gcloud` — Create service accounts, bind IAM policies, enable services, and deploy Cloud Run applications.
- `gsutil` — Create buckets, copy files, and set bucket permissions.
- `docker` — Build, tag, and push container images to GCP Artifact Registry.
- `firebase` — Deploy preview channels or live deployments, and manage indexes.

## Procedures

### Create and bind a service account
1. Run `gcloud iam service-accounts create NAME --display-name="Display Name" --project=PROJECT`.
2. Grant roles using:
   ```bash
   gcloud projects add-iam-policy-binding PROJECT \
     --member=serviceAccount:SA@PROJECT.iam.gserviceaccount.com \
     --role=roles/ROLE_NAME
   ```
3. Verify: Check service account availability and project IAM policy bindings.

### Build and deploy to Cloud Run
1. Run `docker build -t REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG .`.
2. Run `docker push REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG`.
3. Run `gcloud run deploy SERVICE_NAME --image=REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG --region=REGION --project=PROJECT`.
4. Verify: Confirm deployment returns successfully and the service URL responds.

### Deploy to Firebase Hosting (staging → approval → production)
1. Prepare the deploy directory with all static files (e.g., from `drive-download-folder`).
2. Create `firebase.json` in the deploy directory if it doesn't exist:
   ```bash
   cat > /path/to/deploy-dir/firebase.json << 'EOF'
   {
     "hosting": {
       "public": ".",
       "ignore": ["firebase.json", "**/node_modules/**"],
       "headers": [{ "source": "**", "headers": [{ "key": "Cache-Control", "value": "max-age=3600" }] }]
     }
   }
   EOF
   ```
3. Deploy to a **staging preview channel** first:
   ```bash
   cd /path/to/deploy-dir && firebase hosting:channel:deploy staging --project=PROJECT
   ```
4. Verify the staging URL works — the command output includes the preview URL.
5. **STOP and report the staging URL** to the owner for approval. Do NOT proceed to production without explicit approval.
6. After approval, deploy to production:
   ```bash
   cd /path/to/deploy-dir && firebase deploy --only hosting --project=PROJECT
   ```
7. Verify: Confirm the live site URL responds correctly.

### Deploy to Firebase Hosting preview channel (standalone)
1. Deploy hosting configuration using:
   ```bash
   firebase hosting:channel:deploy CHANNEL_NAME --project=PROJECT
   ```
2. Verify: Ensure the command succeeds and outputs the preview URL.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| API not enabled | The targeted API is disabled in the project | Run `gcloud services enable SERVICE_NAME.googleapis.com --project=PROJECT` to activate it. |
| `403 Forbidden` / Permission Denied | Service account or user lacks IAM permission | Verify the target project ID is correct and check that the agent's account has the required IAM roles assigned. |
| Container image not found | Image does not exist in Artifact Registry or is inaccessible | Check Artifact Registry using `gcloud artifacts docker images list`, build/push the image again with `docker`, and check repository access permissions. |
| `firebase.json` not found | Missing hosting config in deploy directory | Create `firebase.json` with `{"hosting":{"public":"."}}` in the deploy directory. |
| `Error: No site found` | Firebase Hosting not initialized for the project | Run `firebase hosting:sites:list --project=PROJECT` to check. Create a site with `firebase hosting:sites:create SITE_ID --project=PROJECT` if needed. |
| Hosting deploy shows 0 files | `public` path in `firebase.json` is wrong | Ensure `firebase.json`'s `hosting.public` points to the directory containing the files (use `.` if `firebase.json` is in the same dir as the files). |

## Firestore Document Querying

**Important:** `gcloud firestore` does NOT support direct document reads. Use the Firestore REST API via `curl` instead.

### Get an access token (on GCE VMs)
```bash
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
```

### List documents in a collection
```bash
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents"
curl -s -H "Authorization: Bearer $TOKEN" "$FIRESTORE_URL/COLLECTION_PATH" | python3 -m json.tool
```

### Get a single document
```bash
curl -s -H "Authorization: Bearer $TOKEN" "$FIRESTORE_URL/COLLECTION_PATH/DOC_ID" | python3 -m json.tool
```

### Example: List all fleet agents
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$FIRESTORE_URL/primes/chuck/fleet" | python3 -m json.tool
```

## Cloud Logging

`gcloud logging read` uses **Cloud Logging filter syntax**, NOT shell regex or grep patterns. Filters are structured key-value expressions.

⚠️ **Use single quotes around the filter string** to avoid shell escaping issues. Use double quotes ONLY inside the filter for string values.

### Read recent service logs
```bash
# Recent logs for a specific Cloud Run service
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="sync-service"' \
  --project=PROJECT --freshness=1h --limit=20 \
  --format='table(timestamp,textPayload)'
```

### Filter by text content
```bash
# Logs containing "error" (substring match uses ":")
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE" AND textPayload:"error"' \
  --project=PROJECT --freshness=1h --limit=10
```

### HTTP request logs
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE" AND httpRequest.requestUrl:*' \
  --project=PROJECT --freshness=24h --limit=10 \
  --format='table(timestamp,httpRequest.requestUrl,httpRequest.status)'
```

### Freshness flag
Use `--freshness=DURATION` instead of manual timestamp math. Accepted values: `1h`, `6h`, `1d`, `7d`, etc. This is simpler and less error-prone than computing RFC3339 timestamps.

## Infrastructure Discovery
Key commands for discovering current state before making modifications:

| What | Command |
|------|---------|
| Service accounts | `gcloud iam service-accounts list --project=PROJECT` |
| Enabled APIs | `gcloud services list --enabled --project=PROJECT` |
| IAM policy | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:serviceAccount"` |
| Cloud Run services | `gcloud run services list --project=PROJECT` |
| Cloud Build triggers | `gcloud builds triggers list --project=PROJECT` |
| Project number | `gcloud projects describe PROJECT --format="value(projectNumber)"` |
| Firestore documents | `curl -s -H "Authorization: Bearer $TOKEN" "https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents/COLLECTION"` |
| Cloud Run logs | `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' --project=PROJECT --freshness=1h --limit=20` |

## Safety Rules
- Always verify before modifying — list resources before deleting/updating
- Include rollback steps for any destructive operation
- Never fabricate resource names — always discover them first
- Use `--format=json` for machine-readable output when chaining commands
