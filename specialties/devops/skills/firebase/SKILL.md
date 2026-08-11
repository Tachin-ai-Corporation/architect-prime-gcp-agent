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
- `firebase hosting:clone SRC_SITE:SRC_CHANNEL DST_SITE:DST_CHANNEL --project=PROJECT` — copy an **exact version** between channels/sites (e.g. `tachin-web:staging tachin-web:live`). This is the **promote** command: it releases the already-built, already-reviewed version to live without rebuilding.
- `firebase deploy --only hosting --project=PROJECT` — build+deploy the local directory to the **live** site. Ships whatever is in `public/` *now* — only correct when that directory is the reviewed source (see Deploy procedure).
- `firebase deploy --only firestore:indexes --project=PROJECT` — apply Firestore indexes from `firestore.indexes.json`.

## Procedures

### Deploy a site (staging → approval → production)
The golden rule: **source from the reviewed repo, promote by cloning.** The content you deploy
must be the project's canonical source, and what reaches production must be the exact version the
owner approved on staging — not a fresh rebuild of whatever is lying around.

0. **Read the deploy target from the project's `## Deployment` block — do NOT infer it.** A mission
   scoped to a project renders an authoritative Deployment block in your context (and the delegation
   often carries a `[DEPLOY TARGET] site=… project=… source=…` line). It names two DISTINCT things:
   the **Hosting site** (the deploy target) and the **GCP/Firebase project** (`--project`). They are
   frequently different — e.g. site `your-hosting-site` lives under project `your-gcp-project` — so
   **never** assume the site equals the project name. **The Hosting site is NOT a CLI flag.** Neither
   `firebase deploy` nor `firebase hosting:channel:deploy` accepts `--site` — passing it errors
   `unknown option '--site'` (verified, firebase-tools 15.x). You select the site by putting
   `"site": "<hosting_site>"` inside the `hosting` object of `firebase.json` (Deploy step 2), or by
   mapping a target once (`firebase target:apply hosting <target> <hosting_site>`) and deploying with
   `--only hosting:<target>`. Every deploy command still passes `--project <gcp_project>`. Without the
   site set in `firebase.json`, a bare deploy silently hits the project's *default* site (a different
   service's — you'd clobber it), so in a multi-site project setting `"site"` is mandatory. If the
   project has no Deployment block and you cannot determine the site, `needs_input` and ask the
   operator — do not guess.

1. **Get the deploy directory from the project's reviewed source — never an ad-hoc or ambient
   tree.** Use the `source` from the Deployment block:
   - **`source.kind: git`/`repo`** → clone it into a clean dir and deploy *that* (`work-clone REPO`
     via the workspace-git skill, or `git-store clone REPO --ref main --dir DIR`). A clone reads the
     repo's **`main`** branch — and a mission's own commits land on its mission branch and merge to
     `main` only when that mission **completes** (objects-before-refs). So **seeding a repo and
     deploying from it are two separate missions**: if the *same* mission first commits the source
     and then deploys, the clone reads a `main` that does not yet have the commit (an empty/placeholder
     dir — the step-3 pre-deploy gate will correctly STOP you). Seed the source in one mission; let it
     complete; deploy from `main` in a later mission.
   - **`source.kind: drive`** → `drive-download <ref>` (workspace-drive) INTO the clean deploy dir.
     A Drive source is one of two **shapes** — the Deployment block may say (`file`/`folder`); if it
     doesn't, look at what actually downloads (`ls -R`):
     - **A single file** (one self-contained HTML page — the common one-page site): that file **is**
       the site. Place it as `index.html` in the deploy dir. It is **complete on its own** — a
       one-page site legitimately has **no** `images/` dir, so do **not** treat missing assets as a
       broken download, and do **not** write a checkpoint criterion like *"download all files from
       the folder"* — there is no folder, and that criterion can never pass.
     - **A folder** (a multi-page site): download the whole tree, preserving structure — its HTML
       pages **and** its `images/`/assets.
     A fresh project's git repo is often empty/placeholder — deploying it ships the 33-byte Firebase
     default page, so fetch the real Drive source first.
   Do **not** aim `"public": "."` at your mission workspace — that ships whatever scratch is
   there (the "prod live but incomplete" failure: missing pages/images, stale `<title>`). After
   staging the source, sanity-check that the deploy dir matches the **source** before deploying
   (`ls -R`): a single-file source → exactly your `index.html`; a folder source → its pages plus
   `images/`/assets. The completeness bar is **"the deploy dir contains the site as the source
   defines it"** — not "a folder of many files." If the real content isn't there, fix the source first.
2. **Write** `firebase.json` in the deploy directory yourself — **never run `firebase init`**.
   Every `init` subcommand is interactive and hangs with no TTY: it burns the whole command
   timeout, then the turn loop-guards out. Create the file directly instead, e.g.:
   ```bash
   cat > firebase.json <<'EOF'
   { "hosting": { "public": ".", "ignore": ["firebase.json", "**/node_modules/**"] } }
   EOF
   ```
   `firebase deploy` needs no project init — the `--project` flag and this `firebase.json` are enough.
   **Multi-site project? Name the target site — this is not optional.** If the project hosts
   more than one site (`firebase hosting:sites:list` shows >1), a config with no `site` deploys
   to the project's *default* site — which may belong to a different service and whose content
   you would clobber. Add `"site": "SITE_ID"` inside the `hosting` object so both the channel
   deploy and the live deploy act on the intended site:
   ```json
   { "hosting": { "site": "SITE_ID", "public": ".", "ignore": ["firebase.json", "**/node_modules/**"] } }
   ```
   (Alternatively map a target once with `firebase target:apply hosting TARGET SITE`, then deploy
   with `--only hosting:TARGET`.) Confirm the resolved site in the deploy output before promoting.
3. **Pre-deploy gate — never ship an empty or half-fetched dir (a deploy REPLACES the channel).**
   `hosting:channel:deploy` (and `deploy`) overwrite that channel/site's content wholesale, so
   deploying an empty or incomplete directory turns a **working** preview/site into a 404. Before
   you deploy, confirm the deploy dir actually holds the site: `test -s <public>/index.html` and
   `ls -R` shows the real pages/assets. If the source fetch (`drive-download`, `work-clone`/clone)
   **errored, returned no file, or the dir is empty — STOP, do NOT deploy.** A transient
   `access_denied`/network error on the fetch usually succeeds on a retry, so retry the fetch
   first; if it still fails, escalate `needs_input`. Never deploy nothing over a live channel — a
   failed fetch must never become a shipped 404. THEN deploy to the **preview channel** first,
   **from the deploy directory** — `firebase` reads `firebase.json` from the CURRENT WORKING
   DIRECTORY, and the motor's `runCommand` starts in a default dir that is NOT your deploy dir and
   does NOT persist a prior `cd`. So `cd` into the deploy dir in the SAME command (reading
   `firebase.json` by absolute path is not enough — the CLI still looks in cwd):
   ```bash
   cd "$DEPLOY_DIR" && firebase hosting:channel:deploy staging --project=PROJECT
   ```
   A bare `firebase hosting:channel:deploy …` from the wrong cwd fails with an unhelpful
   `Command failed` (no `firebase.json` found) — not a permissions or API problem.
4. Verify the preview URL (in the command output) serves the expected content — verify **what
   the site actually has**, not an assumed shape. **Always** confirm `/` RENDERED WHOLE (not
   merely a 200): compare the served byte size to your source (a deploy that dropped content is
   markedly smaller), `grep` the served HTML for a marker from **below the fold** (a late section
   heading, the footer) — present means the page didn't die halfway — and `grep` for a stray
   `\'`/`\"` (escaped quotes = a corrupted source edit shipped; see the system-shell "quote
   trap"). A `/` that 200s can still be visually blank below the hero when an inline `<script>`
   was corrupted, and that is NOT ready to promote. **If** the site is multi-page / has assets,
   also `curl` a couple of other pages and `images/…` paths — one that 200s on `/` but 404s on its
   images is not ready. A **single-page** site with no separate assets is fully verified by the
   whole-render check on `/` alone — do **not** fail it for `images/` paths its source never had.
   **Report that Channel URL verbatim as the checkpoint's outcome** — e.g. "Deployed to staging:
   https://SITE--staging-….web.app". A checkpoint whose criterion is "a valid staging URL is
   provided" FAILS verification when your result only says "deployed": the verifier judges the
   evidence you reported, and a bare "done" is not evidence of a reachable URL. Carry the URL out.
5. **STOP — report the preview URL to the owner and wait for explicit approval.** Do not
   promote to production on your own. When your checkpoint's task is "deploy to STAGING", it
   touches the **staging channel only** — never `firebase deploy` (that ships the LIVE site) and
   never a clone-to-live. Promotion to production is its OWN later step (6): even when the owner
   pre-approved production in advance, that pre-approval lets step 6 proceed without a fresh
   prompt — it does NOT merge deploy-to-staging and promote-to-live into one action. Do only the
   checkpoint in front of you; leave prod untouched until the promote checkpoint.
6. **After approval, PROMOTE the reviewed version — do not rebuild.** Clone the exact staging
   version that was approved to the live channel, so production serves the same bytes the owner
   reviewed:
   ```bash
   firebase hosting:clone SITE:staging SITE:live --project=PROJECT   # e.g. tachin-web:staging tachin-web:live
   ```
   A fresh `firebase deploy --only hosting` from the *same, unchanged* directory also works, but
   re-deploying risks shipping something different from what was reviewed — prefer the clone.
   Fallback if the CLI clone is unavailable: release the reviewed version via the Hosting REST
   API — `POST https://firebasehosting.googleapis.com/v1beta1/sites/SITE/releases?versionName=sites/SITE/versions/VERSION`
   with an empty body (`-d "{}"`) and an `X-Goog-User-Project: QUOTA_PROJECT` header.
7. Verify the live URL end to end — `/`, a content page, and an image
   (`curl -sS -D- -o /dev/null https://SITE/`, then `…/images/…`).

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
| A page's embedded Google Doc (`<iframe>`) shows nothing / stays blank | The iframe `src` uses the RAW doc form `docs.google.com/document/d/<DOC_ID>/pub?embedded=true` (returns **401**) instead of the Published-to-web form `…/document/d/e/<PUBLISH_TOKEN>/pub?embedded=true` | In Google Docs, **File → Share → Publish to web**, copy that embed URL (it contains `/d/e/<token>/`) and use it in the iframe. The publish token **cannot** be derived from the doc id — if you lack access, ask the doc owner for the published URL. Quick check: `curl -s -o /dev/null -w '%{http_code}' <src>` → 200 = embeddable, 401 = not published. |
| Deployed page 200s but renders blank below the hero / first section | Shipped a source file with corrupted inline JS — an upstream edit escaped its quotes (`'`→`\'`), so the script that reveals lower sections throws | Do NOT promote. `curl` the served HTML and `grep "\\'"` — stray backslash-quotes confirm it. Fix the source edit (see system-shell "quote trap"), redeploy to the preview channel, re-verify whole-page render, then promote. To recover a broken live/staging channel fast, clone the last-good version back: `firebase hosting:clone SITE:live SITE:staging` (or a REST version-release of the good version to the channel). |
| Deploy landed on the wrong site / clobbered another service's content, or the CLI is ambiguous about which site | Ran a bare deploy / `firebase.json` names no site, so it hit the project's default site — often because the site was inferred from the GCP project name (they differ) | Read the project's `## Deployment` block for the authoritative `hosting_site`; add `"site": "<hosting_site>"` to the `hosting` object (and pass `--project`; the site comes from `firebase.json`, NOT a `--site` flag), or map a target with `firebase target:apply hosting TARGET SITE`. Re-deploy to the correct site. |
| `error: unknown option '--site'` on `firebase deploy` or `hosting:channel:deploy` | Passed `--site` — these deploy commands have no such flag (firebase-tools 15.x) | The Hosting site is NOT a CLI flag. Put `"site": "<hosting_site>"` in the `hosting` object of `firebase.json` (or map a target: `firebase target:apply hosting TARGET SITE`, then `--only hosting:TARGET`), and pass only `--project`. |
| `hosting:channel:deploy` / `hosting:channel:list` fail with a generic `Command failed` (no detail), yet `hosting:sites:list` works | Ran `firebase` from the wrong cwd — it reads `firebase.json` from the CURRENT directory and finds none (reading the file by absolute path doesn't help) | `cd` into the deploy dir in the SAME command: `cd "$DEPLOY_DIR" && firebase hosting:channel:deploy staging --project=PROJECT`. The motor's `runCommand` does not persist a prior `cd`. |
| Staging/live URL 200s but serves the 33-byte Firebase default page (`Hello, Firebase Hosting!`) or a stub, not the real site | Deployed an empty/placeholder dir — the project's real source (often a Drive file, or an empty freshly-created repo) was never fetched into the deploy dir | `drive-download <source.ref>` (or clone the source repo) INTO the clean deploy dir per Deploy step 1, confirm the real files are present (`ls -R`), then redeploy to the preview channel and re-verify the served bytes match the source. |
| Verification keeps failing on "download all files from the folder" / missing `images/`, but the source is a single file | A single-FILE Drive site (one self-contained HTML page) is being treated as an incomplete folder | A one-page site is COMPLETE as that one file: place it as `index.html`, and verify by whole-render of `/` (byte size + a below-the-fold marker), NOT by a folder inventory or `images/` paths it never had. Read the Deployment block's `source` shape (`file` vs `folder`); never write a "download the whole folder" criterion for a single-file source. |
| `firebase init` hangs, times out (~120s), then the turn loop-guards out | `init` is interactive and blocks forever with no TTY | **Never run `firebase init` (or any `init` subcommand).** Write `firebase.json` directly (Deploy step 2), then deploy with `hosting:channel:deploy` / `deploy --only hosting`. Deploying needs no init. |
| Deploy reports **0 files** | `hosting.public` points at the wrong directory | Point `public` at the directory holding the files (`.` when `firebase.json` sits with them); redeploy. |
| A working preview/live channel suddenly 404s ("Site/Page Not Found") right after a deploy | Deployed an empty/half-fetched dir — the source fetch (`drive-download`/clone) errored or returned nothing, but the deploy ran anyway and REPLACED the channel wholesale | Never deploy an unverified dir (Deploy step 3 gate: `test -s <public>/index.html` first). Recover: re-fetch the real source and redeploy, or clone a known-good version back (`firebase hosting:clone SITE:live SITE:staging`). Retry a transient `access_denied`/network fetch; escalate `needs_input` if it persists — never ship empty over a live channel. |
| Prod went live but content is **incomplete or wrong** (missing pages/images, stale `<title>`) | Deployed the ambient mission workspace (`public:"."`) instead of the project's reviewed source | Promote the approved **staging** version rather than rebuilding: `firebase hosting:clone SITE:staging SITE:live` (or a REST version-release of the reviewed version). Then always deploy from a clean clone of the project repo, never the scratch tree; re-verify `/` + a page + an image. |
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
