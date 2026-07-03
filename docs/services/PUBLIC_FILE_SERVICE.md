# Public File Service

## Overview

Ad-hoc public file hosting service. Files placed in a designated Google Drive folder are automatically mirrored to GCS and served at public URLs.

> **This is NOT the marketing website.** It is infrastructure plumbing for hosting arbitrary public assets (PDFs, images, documents) at stable URLs under `/public/**`.

---

## Architecture

```
Google Drive  →  sync-service (Cloud Run)  →  GCS Bucket  →  proxy-service (Cloud Run)  →  Firebase Hosting (/public/**)
```

1. Files are placed in a designated Google Drive folder (or its subdirectories).
2. Drive sends a watch notification to the sync-service.
3. The sync-service mirrors files from Drive into GCS.
4. The proxy-service reads from GCS and serves files over HTTP.
5. Firebase Hosting rewrites `/public/**` requests to the proxy-service.

---

## Components

| Component         | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| GCP Project       | `tachin-website`                                                   |
| Sync Service      | `https://sync-service-m32774wz2q-uc.a.run.app`                    |
| Proxy Service     | `https://proxy-service-m32774wz2q-uc.a.run.app`                   |
| GCS Bucket        | `tachin-website-assets`                                            |
| Drive Root Folder | `1s5yUdEH5M5ugISHG9oqauQzDXuMszKjV` (contains images/, public/)  |
| Drive /public Folder | `1mdirwpy-ecggSAh6dExXVfFSTSBv7FJt`                            |
| Service Account   | `drive-sync-sa@tachin-website.iam.gserviceaccount.com`             |
| Sync SA (actual)  | `92079628910-compute@developer.gserviceaccount.com` (default compute SA) |
| Firebase Hosting  | `https://tachin-website.web.app`                                   |
| Public URL Base   | `https://tachin-website.web.app/public/`                           |

---

## How It Works

### Watch Registration

- The sync-service auto-registers a Google Drive watch on startup.
- Watches are registered on BOTH the root folder AND the /public subfolder.
- Reason: `files.watch()` only monitors the watched item itself, NOT children.
- Watch webhook points to `{SERVICE_URL}/sync-all`.
- Channel token is set to the ROOT folder ID so sync-all always traverses from root.

### Sync Behavior

- When a watch notification arrives, the sync-service scans all files in the Drive folder.
- **Root files are IGNORED** — only files inside subdirectories of the source folder are synced.
- Files are uploaded to the GCS bucket preserving the subdirectory structure.
- Example: Drive path `source-folder/public/report.html` → GCS path `public/report.html` → URL `/public/report.html`

### Deletion Reconciliation

- After syncing, the service compares GCS contents against Drive contents.
- Any GCS file that no longer has a corresponding Drive file is **automatically deleted**.
- This keeps the public bucket clean and prevents stale assets.

### Watch Renewal

- Drive watches expire after approximately 24 hours.
- **Automatic renewals** happen via:
  1. Cloud Scheduler `drive-sync-all-job` runs daily at midnight UTC (GCP-level)
  2. Nightly responsibility `r-sync-health-nightly` at 7am UTC (agent-level)
  3. Sync-service auto-registers watches on startup
- Manual renewal: `POST https://sync-service-m32774wz2q-uc.a.run.app/renew-watch`

---

## Operational Procedures

### Trigger a Sync

Use process **`p-sync-trigger`** to manually sync all files from Drive to GCS:
- POST to `/sync-all` endpoint
- Returns list of synced, ignored, and deleted files
- This is the lightweight option — use when someone just wants to sync

### Health Check

Use process **`p-publicfile-health`** to verify the service is operating correctly:
- Confirm the Drive watch is active
- Verify sync-service is responding
- Verify proxy-service is serving files
- Check for GCS/Drive drift

### Publish a File

Use process **`p-publicfile-publish`** to add a new public file:
1. Place the file in a subdirectory of the Drive source folder (never at root).
2. Wait for auto-sync (triggered by watch) or manually trigger sync.
3. Verify the file is accessible at its public URL.

### Manual Operations

| Operation      | Command |
|----------------|---------|
| Trigger sync   | `POST https://sync-service-m32774wz2q-uc.a.run.app/sync-all` |
| Renew watch    | `POST https://sync-service-m32774wz2q-uc.a.run.app/renew-watch` |
| Health check   | `GET https://sync-service-m32774wz2q-uc.a.run.app/health` |

---

## Important Boundaries

| Concern                     | Rule                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| **Public file service**     | Serves `/public/**` on `tachin-website.web.app`                       |
| **Marketing website**       | Serves everything else at the root (`/`, `/about`, etc.)              |
| **Firebase rewrite**        | The `/public/**` rewrite in `firebase.json` **MUST be preserved** by all website deploys |
| **GCP Projects**            | These are two separate *work-management* projects (`tachin-public-files` vs `tachin-website`) but share the same GCP project (`tachin-website`) |
| **Source of truth**         | Drive folder is source of truth for public files; git is source of truth for the website |
| **min-instances**           | sync-service MUST have min-instances=1 — if it scales to zero, the Drive watch channel dies |
