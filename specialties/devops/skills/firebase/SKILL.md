# Firebase (Hosting: deploy, inspect, diagnose)

## When to Use
Any Firebase Hosting work driven from the CLI:
- **Deploy** a site — preview channels, and staging → approval → production.
- **Inspect** hosting sites, channels, and local config.
- **Diagnose** why content is not served at its expected URL.
- **Firestore indexes** applied through the Firebase CLI.

## Your tools — this is a procedure, not a program
This skill tells you **how to drive real CLIs**. It is **not** an executable. There is no
command named `firebase-hosting`, `firebase-diagnostics`, or anything matching this skill's
name, and no subcommand like `diagnose` or `check-file`. If you find yourself typing a
command built from this skill's name, stop — you tried to *run the skill instead of the
tool*. The only programs you invoke here are:

| Tool | Use |
|------|-----|
| `firebase` | Firebase CLI — hosting sites/channels, deploy, Firestore indexes. |
| `gcloud` | Cloud Run / Cloud Logging state for hosting backends (a rewrite may proxy to one). |
| `gsutil` | Read GCS objects when hosting serves from a bucket-backed origin. |
| `curl` | Probe URLs and backend endpoints for HTTP status + headers. |

## Commands

### Read (non-mutating, safe in production)
- `firebase hosting:sites:list --project=PROJECT` — list all hosting sites for a project.
- `firebase hosting:channel:list --site=SITE --project=PROJECT` — list preview/live channels for a site.
- `firebase target:apply hosting TARGET SITE --project=PROJECT` — (config only) map a deploy target to a site.
- `cat firebase.json` — read the local hosting config: `public` dir, `rewrites`, `redirects`, `headers`.
- `curl -sS -D- -o /dev/null https://SITE/PATH` — see exactly what a URL returns (status line + headers).
- `gcloud run services describe SERVICE --region=REGION --project=PROJECT --format='value(status.url)'` — a rewrite backend's URL/health.
- `gcloud run services logs read SERVICE --region=REGION --project=PROJECT --limit=50` — backend logs.
- `gsutil ls gs://BUCKET/PREFIX/` · `gsutil stat gs://BUCKET/PREFIX/OBJECT` — inspect a bucket-backed origin.

> ⚠️ These Firebase subcommands **do not exist** — do not invent them:
> `hosting:get`, `hosting:get-config`, `hosting:releases`, `hosting:sites:get`.
> To read live config, use `hosting:sites:list` / `hosting:channel:list` and read `firebase.json`.

### Write (mutating — obey Safety below)
- `firebase hosting:channel:deploy CHANNEL --project=PROJECT` — deploy to a **preview** channel; prints a preview URL.
- `firebase deploy --only hosting --project=PROJECT` — deploy to the **live** site.
- `firebase deploy --only firestore:indexes --project=PROJECT` — apply Firestore indexes from `firestore.indexes.json`.

## Procedures

### Deploy a site (staging → approval → production)
1. Prepare the deploy directory with all static files.
2. Ensure a `firebase.json` exists in it. Minimal static config:
   ```json
   { "hosting": { "public": ".", "ignore": ["firebase.json", "**/node_modules/**"] } }
   ```
3. Deploy to a **preview channel** first, from the deploy directory:
   ```bash
   firebase hosting:channel:deploy staging --project=PROJECT
   ```
4. Verify the preview URL (in the command output) serves the expected content.
5. **STOP — report the preview URL to the owner and wait for explicit approval.** Do not
   promote to production on your own.
6. After approval, deploy live: `firebase deploy --only hosting --project=PROJECT`.
7. Verify the live URL responds correctly (`curl -sS -D- -o /dev/null https://SITE/`).

### Diagnose why a URL isn't serving
A Firebase Hosting request resolves in stages. Walk them **in order**, discovering real
resource names as you go — never assume a filename, bucket, site, or service; resolve each
from tool output.

1. **Fix the target.** `firebase hosting:sites:list --project=PROJECT`; agree the exact site
   and URL path, and what content *should* be there.
2. **Reproduce and read the signal.** `curl -sS -D- -o /dev/null https://SITE/PATH`. The
   failure *kind* narrows everything: a 404 served by Hosting, a 404 from a rewrite backend,
   a 5xx from a backend, and a stale `200` are four different bugs.
3. **Read the hosting config.** `cat firebase.json`. Does a `rewrites` entry's `source` match
   the path? Static paths serve from the `public` directory; other paths route via `rewrites`
   to a backend (`run` for Cloud Run, `function` for Cloud Functions).
4. **Follow the route to its origin.**
   - *Static file:* it must be in the deployed `public` directory. A 404 here means the deploy
     didn't include it (see "0 files" recovery) — the content never shipped.
   - *Rewrite → Cloud Run/Function backend:* check the backend is healthy and answers directly
     (`gcloud run services describe …`; `curl` the backend URL). If the backend itself pulls
     from an origin (a GCS bucket, a DB), verify the object exists there (`gsutil stat …`).
5. **Name the failing hop.** The first hop that lacks the content is the culprit:
   origin missing → an upstream/build/sync problem; origin has it but the backend 404s →
   backend routing; backend serves it but Hosting 404s → rewrite/`firebase.json`/deploy;
   everything serves but content is wrong or old → CDN cache.
6. **Verify end to end** after any fix: `curl` the user-facing URL again and confirm the
   status and content.

### firebase.json rewrites for a Cloud Run / Functions backend
To proxy a path to a Cloud Run service, use the `run` key — **not** `destination`:
```json
{ "hosting": {
    "public": "PUBLIC_DIR",
    "rewrites": [{ "source": "/PATH/**", "run": { "serviceId": "SERVICE", "region": "REGION" } }]
} }
```
`destination` redirects to a **local file**; it does not proxy to Cloud Run. Always keep a
`public` directory key — Hosting requires it. After any rewrite change,
`firebase deploy --only hosting` to apply it.

## Example: a Drive-synced, bucket-backed hosting pipeline
Some deployments back Hosting with a content pipeline rather than a static `public` dir:
a Cloud Run **sync-service** mirrors a Google Drive folder into a **GCS bucket**, a Cloud Run
**proxy-service** serves those objects, and a hosting rewrite (`/public/** → proxy-service`)
sits in front — `Drive → sync-service → GCS → proxy-service → Hosting`. This is one concrete
instance of the general walkthrough above; the reference topology (service names, endpoints,
env vars) is documented in `docs/services/SYNC_SERVICE.md`. When diagnosing *this*
architecture, the hops map on as:

1. **Origin content — Drive.** List the source folder (e.g. `drive-ls FOLDER_ID`, including
   subfolders) and resolve the exact filename that should sync. Watch out: such pipelines
   often sync **subfolders only** and ignore root-level files by design.
2. **Sync backend — the sync-service.** Check its Cloud Run health/logs
   (`gcloud run services describe/logs read`). A Drive `files.watch()` channel only watches
   the item itself, **not** its children — a watch on the root folder does not fire for a
   `/public/` subfolder, so each folder must be watched individually. A watch can also point
   at the wrong address (a Pub/Sub topic instead of the service's own URL) or expire (~24h).
   If a manual re-sync/renew endpoint exists, `curl -X POST BACKEND_URL/ENDPOINT` triggers it.
3. **Origin store — GCS.** `gsutil ls`/`gsutil stat gs://BUCKET/PREFIX/FILE` to confirm the
   object actually landed.
4. **Proxy backend.** `curl -v PROXY_URL/PATH/FILE` — does the proxy serve it directly?
5. **Hosting front.** `cat firebase.json` for the `/…/** → proxy-service` rewrite, then
   `curl` the user-facing domain.

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `firebase-hosting-diagnostics: not found`, or any command built from this skill's name | Treated the skill as a program | The skill is a **procedure**, not a command. Run the real CLIs above (`firebase`, `gcloud`, `gsutil`, `curl`). |
| `Unknown command`/`is not a Firebase command`; instant (<20 ms) failure | Invented a `firebase` subcommand | Re-read Read/Write above and use a documented one. Sub-20 ms means argument parsing, not the API. |
| `Error: No site found` | Hosting not initialized for the project | `firebase hosting:sites:list`; create with `firebase hosting:sites:create SITE --project=PROJECT` if needed. |
| Deploy reports **0 files** | `hosting.public` points at the wrong directory | Point `public` at the directory holding the files (`.` when `firebase.json` sits with them); redeploy. |
| Rewrite to Cloud Run not working | Used `destination` instead of `run` | Use `"run": {"serviceId": "SERVICE", "region": "REGION"}`; `destination` is for local-file redirects only. |
| Backend serves the content but Hosting returns 404 | Rewrite missing/incorrect, or deploy stale | Fix `firebase.json` rewrites and `firebase deploy --only hosting`. |
| Content in origin but backend returns 404 | Backend not routed for that path/prefix, or origin name wrong | Check the backend's routing and re-verify the origin object name/bucket. |
| Everything serves but content is wrong/old, or a cached 404 persists | Hosting CDN cached a prior response | Wait out the cache TTL (up to ~1h) or `firebase deploy --only hosting` to bust it. |
| `firebase deploy` auth errors on a GCE VM | Tried to impersonate a service account | Run `firebase deploy` directly — GCE ADC handles auth. Do **not** `gcloud auth activate-service-account` / set `impersonate_service_account` first. |
| Backend (Cloud Run) 403/permission on its origin | Backend service account missing origin access | Grant the backend's SA the needed role on the origin (e.g. Drive read, `roles/storage.objectViewer` on the bucket). |

## Safety
- **A skill is a procedure you follow, not a command you run.**
- Read commands (`*:list`, `describe`, `logs read`, `cat`, `gsutil ls/stat`, `curl` GETs) are
  non-mutating and safe in production.
- A **deploy mutates a live site.** Deploy to a preview channel first, report the preview URL,
  and get **explicit owner approval** before `firebase deploy` to production.
- Do not modify `firebase.json` or backend/Cloud Run configuration without owner approval.
