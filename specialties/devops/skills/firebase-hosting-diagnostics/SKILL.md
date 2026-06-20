# Firebase Hosting Pipeline Diagnostics

## When to Use
A file exists in the Drive source (or GCS bucket) but is NOT accessible at the expected Firebase Hosting URL. This skill walks through every stage of the Drive → sync-service → GCS bucket → proxy-service → Firebase Hosting pipeline.

## Prerequisites
- Project context should specify: `drive_sync_folder_id`, `gcp_project_id`, `target_domain`, and `firebase_hosting_rewrites`
- gcloud CLI authenticated with project access
- gsutil available on PATH

## Commands

### Read
- `gsutil` — Read bucket object lists and verify file statuses in Google Cloud Storage.
- `gcloud` — Retrieve service state and logs for the sync-service and proxy-service Cloud Run instances.
- `curl` — Query proxy endpoints and user-facing URLs to verify HTTP response codes and headers.
- `firebase hosting:sites:list --project=<project>` — List all hosting sites for a project.
- `firebase hosting:channel:list --project=<project> --site=<site>` — List deployment channels for a site.
- `cat firebase.json` — Read the local Firebase config to check rewrite rules.

⚠️ **Invalid commands** — Do NOT use `firebase hosting:get-config`, `firebase hosting:get`, `firebase hosting:releases`, or `firebase hosting:sites:get`. These do not exist in the Firebase CLI.

## Procedures

### Diagnostic Walkthrough
1. **Identify the missing file in Drive:** Run `drive-ls <drive_sync_folder_id>` to list all files in the source Drive folder (and subfolders like `public/`). Identify the exact filename that should be synced. Do NOT assume or guess the filename — resolve it from the Drive listing.
2. **Check Sync Service:** Check logs and URLs for the sync-service Cloud Run instance:
   ```bash
   gcloud run services describe sync-service --project=<gcp_project_id> --region=us-central1 --format='value(status.url)'
   gcloud run services logs read sync-service --project=<gcp_project_id> --region=us-central1 --limit=50
   ```
2b. **Verify Drive Watch Channel:** Check that the watch is active AND the notification address points to the sync-service:
   ```bash
   # Check recent watch registration logs
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="sync-service" AND textPayload:"watch"' \
     --project=<gcp_project_id> --freshness=24h --limit=10 \
     --format='value(textPayload)'
   ```
   Verify the log shows `Using webhook address: https://sync-service-....run.app/sync-all` (must be the service's own URL, NOT a Pub/Sub topic URL).
   If the address is wrong or the watch is expired, renew it:
   ```bash
   curl -X POST https://<sync_service_url>/renew-watch
   ```
3. **Check GCS Bucket:** Run `gsutil ls gs://<bucket-name>/public/` and `gsutil stat gs://<bucket-name>/public/<filename>` to verify the file is stored in GCS.
3b. **Manually trigger sync-all if file missing from GCS:** If the file is in Drive but not in GCS, manually trigger a full sync:
   ```bash
   curl -X POST <sync_service_url>/sync-all
   ```
   This endpoint falls back to the configured `DRIVE_FOLDER_ID` env var, so no parameters are needed. Wait 10 seconds, then re-check GCS.
4. **Check Proxy Service:** Get proxy service URL and test proxy access using `curl -v <proxy-service-url>/public/<filename>`.
5. **Check Firebase Hosting Configuration:** Run `cat firebase.json` to verify the rewrite rules route requests correctly to the proxy.
6. **End-to-End Verification:** Run `curl -v https://<target_domain>/public/<filename>` to test the full URL path from the user-facing domain.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| File in Drive but not in GCS | Sync-service not running or watch expired | Check sync-service logs using `gcloud run services logs read` and renew the directory watch. |
| Watch registered but no notifications arrive | Watch address points to wrong URL (e.g., Pub/Sub topic instead of Cloud Run) | Check watch registration logs. The address must be the sync-service's own URL + /sync-all endpoint, NOT a Pub/Sub topic URL. |
| Files in Drive subfolders sync, but root files don't | By design — sync-service ignores root-level files | Move files to a subdirectory (e.g., public/) for sync to work. Root files are intentionally skipped. |
| File in GCS but proxy returns 404 | Proxy not configured for that path prefix | Check proxy rewrite rules in configuration, and verify GCS bucket name resolution. |
| Proxy works but hosting returns 404 | Firebase rewrite missing or incorrect | Update `firebase.json` rewrites and run `firebase deploy --only hosting` to apply them. |
| Everything works but wrong content | CDN cache stale | Clear Firebase Hosting cache or perform a force reload of the page. |
| CDN returns cached 404 after file was synced | Firebase Hosting CDN cached the 404 before the file existed | Wait for cache TTL (up to 1 hour) or run `firebase deploy --only hosting` to bust the cache. |
| Sync-service 403 on Drive API | Service account missing Drive permissions | Grant Google Drive read/write access to the sync-service service account email. |

## Safety
- This is a READ-ONLY diagnostic procedure — no modifications
- All commands are safe to run in production
- Do not modify `firebase.json` or Cloud Run configs without user approval
