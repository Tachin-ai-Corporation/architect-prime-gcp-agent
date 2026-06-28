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
| Sync Service      | `https://sync-service-<hash>.run.app`                              |
| Proxy Service     | `https://proxy-service-<hash>.run.app`                             |
| GCS Bucket        | `your-website-assets`                                              |
| Drive Source Folder | `YOUR_DRIVE_PUBLIC_FOLDER_ID`                                    |
| Service Account   | `drive-sync-sa@your-gcp-project.iam.gserviceaccount.com`           |

---

## How It Works

### Watch Registration

- The sync-service auto-registers a Google Drive watch on startup.
- The watch monitors the source folder for any file changes (create, update, delete).
- Watch notifications are sent to the sync-service's `/sync-all` endpoint.

### Sync Behavior

- When a watch notification arrives, the sync-service scans all files in the Drive folder.
- **Root files are IGNORED** — only files inside subdirectories of the source folder are synced.
- Files are uploaded to the GCS bucket preserving the subdirectory structure.
- Example: Drive path `source-folder/images/logo.png` → GCS path `images/logo.png` → URL `/public/images/logo.png`

### Deletion Reconciliation

- After syncing, the service compares GCS contents against Drive contents.
- Any GCS file that no longer has a corresponding Drive file is **automatically deleted**.
- This keeps the public bucket clean and prevents stale assets.

### Watch Renewal

- Drive watches expire after approximately 24 hours.
- The nightly responsibility `r-sync-health-nightly` renews the watch automatically.
- Manual renewal: `POST` to the sync-service `/renew-watch` endpoint.

---

## Operational Procedures

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

### Manual Watch Renewal

If the watch has expired and auto-renewal hasn't fired:

```
POST {sync-service-url}/renew-watch
```

---

## Important Boundaries

| Concern                     | Rule                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| **Public file service**     | Serves `/public/**` on `your-project.web.app`                         |
| **Marketing website**       | Serves everything else at the root (`/`, `/about`, etc.)              |
| **Firebase rewrite**        | The `/public/**` rewrite in `firebase.json` **MUST be preserved** by all website deploys |
| **GCP Projects**            | These are two separate *work-management* projects (`your-public-files` vs `your-website-project`) but share the same GCP project (`your-website-project`) |
| **Source of truth**         | Drive folder is source of truth for public files; git is source of truth for the website |
