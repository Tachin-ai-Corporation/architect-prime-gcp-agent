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

1. **Drive Watch**: The sync-service registers a [Drive API push notification channel](https://developers.google.com/drive/api/reference/rest/v3/changes/watch) on the root website folder
2. **Change Detection**: When a file is added, updated, or deleted in the Drive folder, Google sends a push notification to the sync-service
3. **GCS Sync**: The sync-service downloads the changed file from Drive and uploads it to the `tachin-website-assets` GCS bucket under the `public/` prefix
4. **Proxy Service**: The proxy-service Cloud Run instance serves files from the GCS bucket
5. **Firebase Hosting**: Firebase rewrites route requests through the proxy to serve the synced content

## Infrastructure

| Component | Type | URL | Project |
|-----------|------|-----|---------|
| sync-service | Cloud Run | `https://sync-service-m32774wz2q-uc.a.run.app` | tachin-website |
| proxy-service | Cloud Run | `https://proxy-service-85486025845.us-central1.run.app` | tachin-website |
| GCS Bucket | Cloud Storage | `gs://tachin-website-assets` | tachin-website |
| Firebase Hosting | Hosting | `https://tachin-website.web.app` | tachin-website |

### Environment Variables (sync-service)

| Variable | Value | Description |
|----------|-------|-------------|
| `DRIVE_FOLDER_ID` | `1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV` | Root website folder in Google Drive |
| `GCS_BUCKET_NAME` | `tachin-website-assets` | Target GCS bucket |
| `GCS_PREFIX` | `public` | Prefix for synced files in GCS |
| `FIREBASE_PROJECT` | `tachin-website` | Firebase project ID |

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/renew-watch` | POST | Re-registers the Drive API watch channel (call when watch expires) |

## ⚠️ Important: Drive Watch Expiration

The Drive API watch channel expires every **~24 hours**. When it expires, the sync service stops receiving change notifications. The `/renew-watch` endpoint must be called periodically.

### Automated Watch Renewal
- A nightly responsibility (`r-sync-health-nightly`) checks the watch status at 2:00 AM CT
- If the watch is expired, the health check process (`p-sync-health-check`) automatically renews it

## Relationship to Full Website Deploy

| | Sync Service | Full Website Deploy (`p-deploy-website`) |
|---|---|---|
| **Scope** | Individual file changes in Drive | Complete rebuild from Drive to Firebase Hosting |
| **Trigger** | Automatic (Drive push notification) | Manual (GChat request or process invocation) |
| **Pipeline** | Drive → GCS → proxy → Hosting | Drive → download → firebase deploy |
| **Speed** | Near-instant (~seconds) | Minutes (full download + deploy cycle) |
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
| File in Drive but not on live site | Watch expired | Call `/renew-watch` endpoint |
| Sync-service returning 503 | Cloud Run instance cold start | Wait 30s, retry |
| File in GCS but 404 on site | Proxy rewrite misconfigured | Check firebase.json rewrites |
| Watch renewal returns error | Service account permissions | Verify SA has Drive API access |
| Stale content on live site | CDN cache | Clear Firebase Hosting cache |
