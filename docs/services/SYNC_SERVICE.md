# Sync Service — Architecture & Operations

## Overview

The **sync-service** is a Cloud Run service that continuously mirrors a Google Drive source folder into a GCS bucket, which the **proxy-service** serves through Firebase Hosting under `/public/**`. It keeps the public bucket in lock-step with Drive: new and changed files appear within ~10–30 seconds, and deletions are reconciled automatically.

> This is the **public file sync**, not a website deploy. See [PUBLIC_FILE_SERVICE.md](./PUBLIC_FILE_SERVICE.md) for the service-level overview and operator procedures.

## Pipeline

```
Google Drive          →  sync-service   →  GCS bucket            →  proxy-service  →  Firebase Hosting
(source folder,          (Cloud Run,        (YOUR_WEBSITE_ASSETS,     (Cloud Run)       (/public/** on
 subfolders only)         polling loop)      subfolder paths)                             YOUR_SITE.web.app)
```

## How It Works — Four Sync Tiers

The service is **polling-first**. `files.watch()` webhooks proved unreliable for detecting child-file changes, so an in-process poll loop is the primary mechanism, backed by three safety nets.

| # | Tier | Cadence | Mechanism |
|---|------|---------|-----------|
| 1 | **Smart poll** (primary) | every **10 s** | Lists the Drive folder tree, compares each file's `modifiedTime` against an in-memory cache, uploads only the deltas. A no-op poll is ~1 API call, <1 s. |
| 2 | **Full reconciliation** | every **5 min** | Re-downloads every file and reconciles GCS deletions (removes any GCS object with no matching Drive file). Corrects drift the delta path missed. |
| 3 | **Cloud Scheduler** | every **15 min** (`*/15 * * * *`, job `drive-sync-all-job`) | External `POST /sync-all` — a safety net independent of the in-process loop. |
| 4 | **Changes API webhook** | instant (when it fires) | `changes.watch()` push notifications hit `POST /webhook/changes` → a smart sync. Present but effectively dormant (Drive push delivery is unreliable); the poll loop is what keeps things current. Live health shows `webhookSyncs: 0`. |

### Smart sync vs. full sync
- **Smart sync**: list → compare `modifiedTime` to the cache → upload changed files only → drop cache entries whose files disappeared from Drive. Runs every 10 s.
- **Full sync**: clears the cache, re-downloads everything, then lists the whole bucket and deletes any object not present in Drive. Runs on startup, every 5 min, and on every `/sync-all`.

### What gets synced
- **Only files inside subdirectories** of the source folder are synced (e.g. `public/`, `images/`). Files at the **root** of the source folder are **ignored by design**.
- The GCS path mirrors the Drive subfolder path: Drive `source/public/report.html` → GCS `public/report.html` → URL `/public/report.html`.
- Content-type is set by extension (`.html`, `.css`, `.js`, `.md`, `.json`; otherwise Drive's mime type).

### Deletion reconciliation
Files removed from Drive are removed from GCS on the next sync — smart sync drops them when they vanish from the listing; full sync sweeps the whole bucket against Drive.

## Reliability Hardening

- **`syncRunning` mutex** — overlapping syncs can't stack.
- **Watchdog** — a 1-minute timer calls `process.exit(1)` if no poll has succeeded for 5 minutes; Cloud Run restarts the container.
- **`/health` returns 503 when stale** (>5 min since last successful poll) so the Cloud Run liveness check restarts the instance.
- **`process.on('unhandledRejection')`** logs and continues; **`uncaughtException`** exits for a clean restart.
- **`min-instances=1` is mandatory** — the poll loop lives inside the container, so it must never scale to zero. (It is also why the Changes API watch is a bonus, not a dependency.)

## Changes API Watch (Tier 4 detail)

`watchHandler.js` registers a **`changes.watch()`** channel — NOT the old `files.watch()`, which only reported folder-metadata changes (renames/moves), never child-file edits. The channel points to `POST /webhook/changes`, expires after 24 h, and auto-renews every 12 h. It is best-effort: if registration fails, the poll loop carries the service.

## Infrastructure

| Component | Type | Value (placeholder) |
|-----------|------|---------------------|
| sync-service | Cloud Run | `https://your-sync-service.run.app` |
| proxy-service | Cloud Run | `https://your-proxy-service.run.app` |
| GCS bucket | Cloud Storage | `gs://YOUR_WEBSITE_ASSETS` |
| Firebase Hosting | Hosting | `https://YOUR_SITE.web.app` (serves `/public/**`) |
| Drive source folder | Google Drive | `YOUR_DRIVE_FOLDER_ID` (subfolders are synced) |
| Cloud Scheduler | Scheduler | `drive-sync-all-job` — `*/15 * * * *` → `POST /sync-all` |

> Operator-specific values (the real project, bucket, Drive folder IDs, service URLs, and service account) live in the sync service's project context in Firestore (a `projects/*` doc) and in the Cloud Run service's env vars — **not** in this template doc.

### Environment variables (referenced by the current code)

| Variable | Purpose |
|----------|---------|
| `DRIVE_FOLDER_ID` | Root Drive folder to mirror (only its subfolders are synced) |
| `GCS_BUCKET_NAME` | Target GCS bucket |
| `SERVICE_URL` | Self-URL, used as the Changes-API webhook address |

Runs as the project's compute service account — needs Drive read on the source folder and `roles/storage.objectAdmin` on the bucket.

### Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Rich JSON: poll cadence, last sync times, `staleSec`, tracked file count, per-tier `stats`, `watch` status. **503 when stale.** |
| `/sync-all` | POST | Full sync + reconcile (Cloud Scheduler, manual, legacy) |
| `/webhook/changes` | POST | Changes API push → smart sync |
| `/renew-watch` | POST | Re-register the Changes API watch |
| `/pubsub/drive-event` | POST | Pub/Sub push → smart sync |
| `/`, `/syncService` | POST | Legacy: sync a single file by `fileId` |

### Source Code

Version-controlled at `services/sync-service/`: `server.js` (orchestrator — tiers + hardening), `index.js` (smart/full sync + upload), `watchHandler.js` (Changes API watch), plus `Dockerfile` and `package.json`. Entry point: `npm start` → `node server.js`.

> ⚠️ **The deployed image is built with `gcloud run deploy --source`**, not from a pinned artifact. Keep `services/sync-service/` in step with production and redeploy from it, so a rebuild never regresses the implementation.

## Monitoring

- **Nightly health** — responsibility `r-sync-health-nightly` (`0 7 * * *` UTC) runs process `p-publicfile-health`: checks sync-service `/health`, GCS freshness, the proxy, and the hosting rewrite.
- **Manual health**: `GET https://your-sync-service.run.app/health`
- **Manual full sync**: `POST https://your-sync-service.run.app/sync-all`
- **Logs**: `gcloud run services logs read sync-service --project=YOUR_PROJECT --region=us-central1 --limit=30`

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| File in a Drive subfolder but not on the site | Wait one poll cycle (~10 s) or `POST /sync-all` | Confirm it is in a **subfolder**, not the folder root |
| File in the Drive root not syncing | By design — root files are ignored | Move it into a subfolder (e.g. `public/`) |
| `/health` returns 503 | Poll loop stale >5 min | The watchdog self-restarts the container; check logs for the failing cause |
| File in GCS but 404 on the site | Hosting rewrite missing | Ensure `services/hosting/firebase.json` has `/public/** → proxy-service` |
| Nothing syncing at all | Service scaled to zero | Confirm `min-instances=1` |

## Change Log

| Date | Change |
|------|--------|
| 2026-06-20 | Initial webhook (`files.watch`) implementation; source added to repo |
| 2026-07-03 | **Rewrote to polling-first** — `files.watch` never detected child-file changes; replaced with a 10 s smart-poll loop + 5 min full reconciliation + `changes.watch` + watchdog/health-restart |
| 2026-08-04 | Repo source + this doc reconciled to the deployed implementation; dead `files.watch` scripts removed; marketing website retired (the site now serves the sync only) |
