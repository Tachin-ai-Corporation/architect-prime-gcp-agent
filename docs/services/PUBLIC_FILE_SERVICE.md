# Public File Service

## Overview

Ad-hoc public file hosting. Files placed in a designated Google Drive folder are automatically mirrored to GCS and served at stable public URLs under `/public/**`.

> **This is NOT a marketing website.** It is infrastructure plumbing for hosting arbitrary public assets (PDFs, images, HTML, documents) at stable URLs. For the technical architecture (sync tiers, hardening, endpoints), see [SYNC_SERVICE.md](./SYNC_SERVICE.md).

---

## Architecture

```
Google Drive  →  sync-service (Cloud Run)  →  GCS bucket  →  proxy-service (Cloud Run)  →  Firebase Hosting (/public/**)
```

1. Files are placed in a **subdirectory** of the designated Drive folder (root-level files are ignored).
2. The sync-service **polls Drive every 10 seconds** (delta by `modifiedTime`), backed by a 5-minute full reconciliation and a 15-minute Cloud Scheduler safety net.
3. Changed files are mirrored into the GCS bucket, preserving the subdirectory path.
4. The proxy-service reads from GCS and serves the files over HTTP.
5. Firebase Hosting rewrites `/public/**` to the proxy-service.

> Historical note: the service originally used Drive `files.watch()` webhooks, which never reliably detected child-file changes. It was rewritten to polling on 2026-07-03; a `changes.watch()` webhook remains as an instant-path bonus but is effectively dormant.

---

## Components

Operator-specific values (the real project, bucket, Drive folder IDs, service URLs, and service account) are recorded in the sync service's project context in Firestore (a `projects/*` doc). In this template doc they are placeholders:

| Component            | Value (placeholder)                                   |
| -------------------- | ----------------------------------------------------- |
| GCP Project          | `YOUR_GCP_PROJECT`                                    |
| Sync Service         | `https://your-sync-service.run.app`                   |
| Proxy Service        | `https://your-proxy-service.run.app`                  |
| GCS Bucket           | `YOUR_WEBSITE_ASSETS`                                 |
| Drive Source Folder  | `YOUR_DRIVE_FOLDER_ID` (sync its subfolders, e.g. `public/`, `images/`) |
| Firebase Hosting     | `https://YOUR_SITE.web.app`                           |
| Public URL Base      | `https://YOUR_SITE.web.app/public/`                   |

---

## How It Works

### Sync behavior
- The sync-service **polls every 10 s** and syncs only files whose `modifiedTime` changed; a 5-minute full reconciliation and a 15-minute Cloud Scheduler `POST /sync-all` back it up. See [SYNC_SERVICE.md](./SYNC_SERVICE.md) for the full four-tier design.
- **Root files are IGNORED** — only files inside subdirectories of the source folder are synced.
- Files are uploaded to GCS preserving the subdirectory structure: Drive `source/public/report.html` → GCS `public/report.html` → URL `/public/report.html`.

### Deletion reconciliation
Any GCS file with no corresponding Drive file is automatically deleted, keeping the public bucket clean.

### min-instances
sync-service MUST run with `min-instances=1` — the 10-second poll loop lives inside the container, so if it scales to zero, syncing stops.

---

## Operational Procedures

| Process | Purpose |
|---------|---------|
| **`p-sync-trigger`** | Manually trigger a full sync (`POST /sync-all`); returns synced / ignored / deleted files. |
| **`p-publicfile-health`** | Verify the pipeline end to end: sync-service `/health`, proxy serving, GCS/Drive drift. |
| **`p-publicfile-publish`** | Publish a new file: place it in a Drive subfolder → wait ~10 s (auto-sync) or trigger a sync → verify the public URL. |

### Manual operations

| Operation                | Command                                                 |
| ------------------------ | ------------------------------------------------------- |
| Trigger full sync        | `POST https://your-sync-service.run.app/sync-all`       |
| Health check             | `GET  https://your-sync-service.run.app/health`         |
| Renew Changes-API watch  | `POST https://your-sync-service.run.app/renew-watch`    |

---

## Important Boundaries

| Concern | Rule |
| ------- | ---- |
| **Public file service** | Serves `/public/**` on `YOUR_SITE.web.app`. |
| **Don't co-host a website** | Serve **only** the public file sync on this site. A marketing website belongs in its own GCP/Firebase project — co-hosting a site whose `firebase.json` has a catch-all SPA rewrite (`** → /index.html`) will clobber the `/public/**` proxy rewrite and break the sync's serving. |
| **Firebase rewrite** | The `/public/** → proxy-service` rewrite in `services/hosting/firebase.json` MUST be preserved by any hosting deploy. |
| **De-indexing** | Hosting serves `X-Robots-Tag: noindex` on every path plus `robots.txt: Disallow: /`. Preserve both on any redeploy. |
| **Source of truth** | The Drive folder is the source of truth for public files; `services/sync-service/` is the source of truth for the service code. |
