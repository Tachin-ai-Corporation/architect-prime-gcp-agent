# gcloud (GCP infrastructure via the Cloud CLI)

## When to Use
GCP infrastructure work driven by the `gcloud` CLI: service accounts & IAM, Cloud Run deploys,
Cloud Build, resource discovery, Cloud Logging, and reading project state from Firestore (via the
REST API). For GCS object/bucket work use the **`gsutil`** skill; for building/pushing container
images use the **`docker`** skill; for Firebase Hosting use the **`firebase`** skill.

## Your tools
| Tool | Use |
|------|-----|
| `gcloud` | The Google Cloud CLI — IAM, Cloud Run, Cloud Build, logging, discovery. |
| `curl` | Firestore REST reads — `gcloud` cannot read Firestore documents directly. |

## Commands

### Read (non-mutating)
- `gcloud <group> list` / `gcloud <group> describe NAME` — discover resources and read state (see Discovery).
- `gcloud projects get-iam-policy PROJECT ...` — read IAM bindings.
- `gcloud logging read '<filter>' --project=PROJECT --freshness=1h` — read logs (filter syntax below).
- `curl -s -H "Authorization: Bearer $TOKEN" "$FIRESTORE_URL/PATH"` — read Firestore docs (below).

### Write (mutating — see Safety)
- `gcloud iam service-accounts create ...` — create a service account.
- `gcloud projects add-iam-policy-binding ...` — grant a role.
- `gcloud services enable SERVICE.googleapis.com --project=PROJECT` — enable an API.
- `gcloud run deploy ...` — deploy a Cloud Run service (build/push the image first — see the **`docker`** skill).

> ⚠️ These do NOT exist: `gcloud run services call` (invoke a service with `curl -X POST <url>/<path>`);
> `gcloud run services logs` (it is `gcloud run services logs read SERVICE --region=REGION`).
> Never build a `gcloud logging read` time bound with `$(date -d ...)` — use `--freshness=1h`.

## Procedures

### Create and bind a service account
1. `gcloud iam service-accounts create NAME --display-name="Display Name" --project=PROJECT`.
2. Grant only the roles the task needs (least privilege):
   ```bash
   gcloud projects add-iam-policy-binding PROJECT \
     --member=serviceAccount:SA@PROJECT.iam.gserviceaccount.com \
     --role=roles/ROLE_NAME
   ```
3. Verify: re-read the SA and the project IAM policy (Discovery); report the real identifier from tool output — never one inferred from a naming convention.

### Deploy to Cloud Run
0. Verify the target Artifact Registry repo exists (`gcloud artifacts repositories list --project=PROJECT --location=REGION`) — a push to a missing repo fails only after a full build.
1. Build and push the image — see the **`docker`** skill.
2. `gcloud run deploy SERVICE --image=REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG --region=REGION --project=PROJECT`.
3. Verify: the deploy returns success AND the service URL actually answers (`curl` it).

### Read Cloud Logging
`gcloud logging read` uses **Cloud Logging filter syntax** (structured key=value), NOT grep/regex.
Single-quote the whole filter; double-quote string values inside it.
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' \
  --project=PROJECT --freshness=1h --limit=20 --format='table(timestamp,textPayload)'
```
- Substring match on a field: add `AND textPayload:"error"`.
- HTTP request logs: `AND httpRequest.requestUrl:*`, format `table(timestamp,httpRequest.requestUrl,httpRequest.status)`.
- Time bound: `--freshness=1h|6h|1d|7d` — never manual RFC3339 math.

### Read Firestore documents (REST)
`gcloud firestore` cannot read documents; use the REST API with a metadata token (on a GCE VM):
```bash
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents"
curl -s -H "Authorization: Bearer $TOKEN" "$FIRESTORE_URL/COLLECTION_PATH" | python3 -m json.tool          # list
curl -s -H "Authorization: Bearer $TOKEN" "$FIRESTORE_URL/COLLECTION_PATH/DOC_ID" | python3 -m json.tool   # one doc
```

## Infrastructure Discovery
Discover current state before you modify anything — never fabricate resource names.

| What | Command |
|------|---------|
| Service accounts | `gcloud iam service-accounts list --project=PROJECT` |
| Enabled APIs | `gcloud services list --enabled --project=PROJECT` |
| IAM policy | `gcloud projects get-iam-policy PROJECT --flatten="bindings[].members" --format="table(bindings.role,bindings.members)" --filter="bindings.members:serviceAccount"` |
| Cloud Run services | `gcloud run services list --project=PROJECT` |
| Cloud Build triggers | `gcloud builds triggers list --project=PROJECT` |
| Artifact Registry repos | `gcloud artifacts repositories list --project=PROJECT --location=REGION` |
| Project number | `gcloud projects describe PROJECT --format="value(projectNumber)"` |
| Firestore documents | `curl -s -H "Authorization: Bearer $TOKEN" "https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents/COLLECTION"` |
| Cloud Run logs | `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="SERVICE"' --project=PROJECT --freshness=1h --limit=20` |

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `API [X] not enabled` | The targeted API is disabled | `gcloud services enable SERVICE.googleapis.com --project=PROJECT`, then retry. |
| `403 Forbidden` / Permission Denied | SA/user lacks the IAM role | Verify the project is correct; check the caller's roles (Discovery); grant the exact missing role. |
| Quota exceeded | Project/regional quota exhausted | Report the exact quota name + current usage from the error; request an increase or switch region — do not retry blindly. |
| Resource not found (404) | Wrong name, project, or region | Re-discover with the relevant list command; verify `--project`/`--region` match the target. |
| `gcloud run services call` / `... logs` "not a command" | Invented subcommand | Invoke a service with `curl -X POST <url>/<path>`; read logs with `gcloud run services logs read SERVICE --region=REGION`. |

## Safety
- **Discover before you modify** — list/describe resources before create/update/delete.
- Least privilege: grant only the roles a task requires; report the real identifier from tool output.
- Include a rollback step for any destructive change.
- Use `--format=json` when chaining machine-readable output.
