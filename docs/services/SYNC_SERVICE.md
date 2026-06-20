# Sync Service — Architecture & Operations

## Overview

The sync service keeps the **tachin-website** Firebase Hosting deployment in sync with changes made to the Google Drive source folder. It operates as a **Cloud Run service** that watches for Drive changes and automatically propagates them to the live site.

## Pipeline

```
Google Drive            →  sync-service  →  GCS Bucket              →  proxy-service  →  Firebase Hosting
(root folder)              (Cloud Run)       (tachin-website-assets)     (Cloud Run)       (tachin-website.web.app)
1s5yUdEH5M5ugISHG9o...                      /public/ prefix
```

### How It Works

1. **Drive Watch**: On startup, the sync-service auto-registers [Drive API `files.watch()`](https://developers.google.com/drive/api/reference/rest/v3/files/watch) channels on **both** the root website folder AND the `public/` subfolder, pointing notifications to its own `/sync-all` endpoint. ⚠️ `files.watch()` only monitors the watched item itself — NOT its children. That's why both folders must be watched individually.
2. **Change Detection**: When a file is added, updated, or deleted in a watched folder, Google sends an HTTP POST notification to the sync-service's `/sync-all` endpoint
3. **Full Sync**: The sync-service traverses the entire Drive folder tree, syncing files from **subdirectories only** (root-level files are ignored by design) to the `tachin-website-assets` GCS bucket under the `public/` prefix
4. **Deletion Reconciliation**: Files in GCS that no longer exist in Drive subfolders are automatically deleted
5. **Proxy Service**: The proxy-service Cloud Run instance serves files from the GCS bucket
6. **Firebase Hosting**: Firebase rewrites route requests through the proxy to serve the synced content

### ⚠️ Root Files Are Ignored

The sync-service **only syncs files in subdirectories** (e.g., `public/`, `images/`). Files placed directly in the root Drive folder are intentionally skipped. To sync a file, place it in a subfolder.

### Expected Latency

Drive push notifications have a built-in delay of ~60-90 seconds. Combined with potential Cloud Run cold starts, end-to-end sync typically takes **60-90 seconds**.

### ⚠️ min-instances=1 Required

The sync-service **must** run with `min-instances=1`. If the service scales to zero, the Drive watch channel dies and new file uploads are never synced. This is a permanent infrastructure requirement.

### Firebase Hosting Rewrite

Firebase Hosting uses a Cloud Run rewrite (`/public/**` → `proxy-service`) to serve GCS files. The hosting config is stored in `services/hosting/firebase.json`. After any change, deploy with:
```bash
firebase deploy --only hosting --project=tachin-website
```

## Infrastructure

| Component | Type | URL | Project |
|-----------|------|-----|---------|
| sync-service | Cloud Run | `https://sync-service-m32774wz2q-uc.a.run.app` | tachin-website |
| proxy-service | Cloud Run | `https://proxy-service-85486025845.us-central1.run.app` | tachin-website |
| GCS Bucket | Cloud Storage | `gs://tachin-website-assets` | tachin-website |
| Firebase Hosting | Hosting | `https://tachin-website.web.app` | tachin-website |
| Drive Root Folder | Google Drive | `1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV` | — |
| Drive Public Folder | Google Drive | `1mdirwpy-ecggSAh6dExXVfFSTSBv7FJt` | — |

### Service Account

`drive-sync-sa@tachin-website.iam.gserviceaccount.com` — used by the Cloud Run service. Needs:
- Google Drive read access to the root folder
- `roles/storage.objectAdmin` on the GCS bucket

### Environment Variables (sync-service)

| Variable | Value | Description |
|----------|-------|-------------|
| `DRIVE_FOLDER_ID` | `1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV` | Root website folder in Google Drive |
| `GCS_BUCKET_NAME` | `tachin-website-assets` | Target GCS bucket |
| `GCS_PREFIX` | `public` | Prefix for synced files in GCS |
| `FIREBASE_PROJECT` | `tachin-website` | Firebase project ID |
| `SERVICE_URL` | `https://sync-service-m32774wz2q-uc.a.run.app` | Self-URL for Drive watch registration |

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync-all` | POST | Receives Drive webhook notifications; traverses folder tree and syncs to GCS |
| `/renew-watch` | POST | Re-registers the Drive API watch channel (call when watch expires) |
| `/health` | GET | Health check endpoint |
| `/syncService` | POST | Legacy: sync a single file by `fileId` |
| `/pubsub/drive-event` | POST | Pub/Sub push handler (triggers syncAll) |

### Source Code

Source code is version-controlled in the architect-prime repo at `services/sync-service/`.

## ⚠️ Important: Drive Watch Expiration

The Drive API watch channel expires every **~24 hours**. The sync-service auto-registers the watch on startup, but if the Cloud Run instance scales to zero and no requests arrive, the watch may not be renewed.

### Automated Watch Renewal
- A nightly responsibility (`r-sync-health-nightly`) checks the watch status at 2:00 AM CT
- If the watch is expired, the health check process (`p-sync-health-check`) automatically renews it

### Manual Watch Renewal
```bash
curl -X POST https://sync-service-m32774wz2q-uc.a.run.app/renew-watch
```

## Relationship to Full Website Deploy

| | Sync Service | Full Website Deploy (`p-deploy-website`) |
|---|---|---|
| **Scope** | Individual file changes in Drive subfolders | Complete rebuild from Drive to Firebase Hosting |
| **Trigger** | Automatic (Drive push notification) | Manual (GChat request or process invocation) |
| **Pipeline** | Drive → sync-service → GCS → proxy → Hosting | Drive → download → firebase deploy |
| **Speed** | ~60-90 seconds | Minutes (full download + deploy cycle) |
| **Use Case** | Day-to-day content updates | Initial deployment, major restructuring, disaster recovery |

## Monitoring

### Nightly Health Check
- **Responsibility**: `r-sync-health-nightly` (cron: `0 7 * * *` UTC = 2am CT)
- **Process**: `p-sync-health-check` (5 steps)
- **Checks**: Cloud Run status, Drive watch active, GCS bucket freshness
- **Auto-remediation**: Renews expired Drive watch

### Manual Diagnostics
Use Stan's `firebase-hosting-diagnostics` skill for ad-hoc troubleshooting:

```
@Devops-Agent Stan diagnose the sync service for tachin-website
```

This runs a 6-step diagnostic walkthrough covering every stage of the pipeline.

### Key Log Commands

```bash
# Sync service logs
gcloud run services logs read sync-service --project=tachin-website --region=us-central1 --limit=20

# Check watch status
gcloud run services logs read sync-service --project=tachin-website --region=us-central1 --limit=30 | grep -E 'watch|expir|renew'

# GCS bucket contents
gsutil ls gs://tachin-website-assets/public/

# Renew watch manually
curl -X POST https://sync-service-m32774wz2q-uc.a.run.app/renew-watch
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| File in Drive subfolder but not in GCS | Watch expired | Call `/renew-watch` endpoint |
| File in Drive root but not in GCS | By design | Move file to a subfolder (e.g., `public/`) |
| Sync-service returning 503 | Cloud Run instance cold start | Wait 30s, retry |
| File in GCS but 404 on site | Proxy rewrite misconfigured | Check firebase.json rewrites |
| Watch renewal returns error | Service account permissions | Verify SA has Drive API access |
| Stale content on live site | CDN cache | Clear Firebase Hosting cache |
| Sync takes >2 minutes | Drive notification delay + cold start | Normal; check logs for processing time |

## Change Log

| Date | Change |
|------|--------|
| 2026-06-20 | **Fixed watch address bug**: changed from Pub/Sub topic URL to sync-service Cloud Run URL. Added auto-registration on startup. |
| 2026-06-20 | Added source code to `services/sync-service/` in the repo |
| 2026-06-20 | Created nightly health monitoring (`r-sync-health-nightly` + `p-sync-health-check`) |
