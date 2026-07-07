# Skill: GCP Admin

## When to Use
When a task needs general Google Cloud operations that the fleet-lifecycle scripts
(`fleet-deploy`, `fleet-status`, etc.) don't cover: inspecting any VM, reading Cloud
Logging, checking Cloud Run / Cloud Build, GCS bucket operations, IAM inspection,
Firestore queries via CLI, or anything else `gcloud`/`gsutil`/`bq` can do.

## Authentication
All commands run under the VM's Application Default Credentials (the attached service
account). No keys, no `gcloud auth login`. The project is already the operator's
project. If a command fails with a permission error, the VM's service account lacks
that IAM role — report it; do not attempt to escalate.

## Available Tooling (via runCommand)

### Compute Engine
- `gcloud compute instances list` — all VMs, status, zones
- `gcloud compute instances describe <name> --zone <zone>` — full VM detail
- `gcloud compute ssh <name> --zone <zone> --tunnel-through-iap --command="..."` — run on a VM
- `gcloud compute instances start|stop|reset <name> --zone <zone>`

### Cloud Logging (extremely useful for diagnosis)
- `gcloud logging read "resource.type=gce_instance AND severity>=ERROR" --limit 50 --format json`
- `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="architect-prime"' --limit 50`

### Cloud Run
- `gcloud run services list`
- `gcloud run services describe <svc> --region <region>`
- `gcloud run revisions list --service <svc> --region <region>`

### Cloud Build
- `gcloud builds list --limit 10`
- `gcloud builds log <build-id>`

### Storage (gsutil)
- `gsutil ls gs://<bucket>` / `gsutil ls -r gs://<bucket>/<prefix>`
- `gsutil cat gs://<bucket>/<object>`
- `gsutil cp <src> gs://<bucket>/<dst>` / `gsutil cp gs://... <local>`
- `gsutil du -sh gs://<bucket>` — size

### IAM (inspection)
- `gcloud projects get-iam-policy <project> --format json`
- `gcloud iam service-accounts list`

### Firestore (via gcloud or REST)
- For quick reads, prefer the metadata-token + REST pattern (see below).

### Firestore REST read pattern (works from any VM)
```bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" "https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents/COLLECTION/DOC" | python3 -m json.tool
```

## Procedures

### Diagnose a failing service
1. `gcloud run services describe <svc> --region <region>` — check current revision, status.
2. `gcloud logging read '...service_name="<svc>"... severity>=ERROR' --limit 50` — recent errors.
3. Form a hypothesis, verify against the logs, then act or report.

### Inspect a VM's health
1. `gcloud compute instances describe <name> --zone <zone> --format="value(status)"`.
2. SSH for daemon state: `gcloud compute ssh <name> --zone <zone> --tunnel-through-iap --command="systemctl status <svc> --no-pager"`.

## Safety
- Read/inspect freely. For mutations (stop/reset VMs, delete objects, IAM changes),
  state the intent and blast radius before executing.
- Never grant IAM roles or modify org policy — report the need instead.
- Project context provides real resource names (VM names, bucket names, service names).
  Read it before guessing.

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| `PERMISSION_DENIED` | VM SA lacks the IAM role | Report which role is needed; do not escalate |
| `gcloud: command not found` | PATH missing /snap/bin | Use `/snap/bin/gcloud` explicitly |
| SSH `Permission denied (publickey)` | IAP tunnel or key issue | Ensure `--tunnel-through-iap`; check the target VM allows IAP |
| Empty log results | Filter too narrow / wrong resource type | Broaden the filter, verify `resource.type`, widen the time window |
