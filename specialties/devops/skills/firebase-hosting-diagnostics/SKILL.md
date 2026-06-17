# Firebase Hosting Pipeline Diagnostics

## When to Use
A file exists in the Drive source (or GCS bucket) but is NOT accessible at the expected Firebase Hosting URL. This skill walks through every stage of the Drive → sync-service → GCS bucket → proxy-service → Firebase Hosting pipeline.

## Prerequisites
- Project context should specify: `drive_sync_folder_id`, `gcp_project_id`, `target_domain`, and `firebase_hosting_rewrites`
- gcloud CLI authenticated with project access
- gsutil available on PATH

## Diagnostic Procedure

### Step 1 — Check Source (Google Drive)
Verify the file exists in the source Drive folder:
```bash
drive-ls <drive_sync_folder_id>
```
Look for the expected filename. If the file is in a subdirectory (e.g. `/public/`), list that subfolder.

### Step 2 — Check Sync Service
Verify the sync-service Cloud Run instance is running and has processed the file:
```bash
gcloud run services describe sync-service --project=<gcp_project_id> --region=us-central1 --format='value(status.url)'
gcloud run services logs read sync-service --project=<gcp_project_id> --region=us-central1 --limit=50
```
Look for recent sync events mentioning the filename. Check for errors.

### Step 3 — Check GCS Bucket
Verify the file landed in the GCS bucket:
```bash
gsutil ls gs://<bucket-name>/public/
gsutil stat gs://<bucket-name>/public/<filename>
```
The bucket name is typically `<gcp_project_id>-assets` or specified in project context.
If the file is NOT in the bucket, the sync-service failed to transfer it.

### Step 4 — Check Proxy Service
Verify the proxy-service can serve the file from GCS:
```bash
# Get proxy service URL
gcloud run services describe proxy-service --project=<gcp_project_id> --region=us-central1 --format='value(status.url)'

# Test direct proxy access
curl -v <proxy-service-url>/public/<filename>
```
Check for 200 OK with content, 404 (file not in bucket), or 500 (proxy misconfiguration).

### Step 5 — Check Firebase Hosting Configuration
Verify the hosting rewrite rules route requests to the proxy:
```bash
# Check firebase.json rewrites
cat firebase.json
# Or check via project context: firebase_hosting_rewrites field
```
The rewrite should map `/public/**` to the proxy-service Cloud Run backend.

### Step 6 — End-to-End Verification
Test the full URL path from the user-facing domain:
```bash
curl -v https://<target_domain>/public/<filename>
curl -v https://<gcp_project_id>.web.app/public/<filename>
```
Compare headers and response with the direct proxy test from Step 4.

## Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| File in Drive but not in GCS | Sync-service not running or watch expired | Check sync-service logs, renew watch |
| File in GCS but proxy returns 404 | Proxy not configured for that path prefix | Check proxy rewrite rules |
| Proxy works but hosting returns 404 | Firebase rewrite missing or incorrect | Update firebase.json rewrites |
| Everything works but wrong content | CDN cache stale | Clear Firebase Hosting cache |
| Sync-service 403 on Drive API | Service account missing Drive permissions | Grant Drive access to SA |

## Safety
- This is a READ-ONLY diagnostic procedure — no modifications
- All commands are safe to run in production
- Do not modify firebase.json or Cloud Run configs without user approval
