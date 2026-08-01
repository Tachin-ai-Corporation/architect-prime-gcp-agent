# docker (container images → Artifact Registry)

## When to Use
Build, tag, and push container images to GCP Artifact Registry with the `docker` CLI. To then
DEPLOY a pushed image to Cloud Run, continue in the **`gcloud`** skill; for GCS use **`gsutil`**.

## Your tools
| Tool | Use |
|------|-----|
| `docker` | Build, tag, and push container images. |
| `gcloud` | One-time Artifact Registry auth + repo discovery (below). |

## Prerequisite — authenticate docker to Artifact Registry (once per host + region)
```bash
gcloud auth configure-docker REGION-docker.pkg.dev
```
On a GCE VM the host's metadata service account is used — no key files. Without this, a
`docker push` to `*-docker.pkg.dev` fails with an auth error.

## Commands
- `docker build -t REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG .` — build and tag in one step.
- `docker tag SOURCE REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG` — retag an existing image.
- `docker push REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG` — push to Artifact Registry.

## Procedures

### Build and push an image to Artifact Registry
0. Verify the target repo exists: `gcloud artifacts repositories list --project=PROJECT --location=REGION` — a push to a missing repo fails only after the full build. Create it (via the `gcloud` skill) if absent.
1. Ensure docker is authed to the registry: `gcloud auth configure-docker REGION-docker.pkg.dev` (once per host/region).
2. `docker build -t REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG .`.
3. `docker push REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG`.
4. Verify: `gcloud artifacts docker images list REGION-docker.pkg.dev/PROJECT/REPO` shows the tag.
5. To deploy this image to Cloud Run, continue in the **`gcloud`** skill (`gcloud run deploy --image=...`).

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `denied` / `unauthenticated` on push | docker not authed to Artifact Registry | Run `gcloud auth configure-docker REGION-docker.pkg.dev`, then push again. |
| `Repository ... not found` | The AR repo doesn't exist in that project/region | `gcloud artifacts repositories list --project=PROJECT --location=REGION`; create the repo (gcloud skill) before pushing. |
| Container image not found at deploy | Image never pushed, or wrong tag/region | Re-verify with `gcloud artifacts docker images list ...`; rebuild/push; confirm the deploy `--image` matches exactly. |
| Build context huge / slow | Sending unneeded files to the daemon | Add a `.dockerignore`; build from a minimal context. |

## Safety
- Tags are mutable — pushing over an existing `:TAG` replaces it. Use immutable tags (e.g. a git SHA) for anything you'll deploy, so a rollback target stays reachable.
- Never `COPY` credentials or secrets into an image (they persist in layers) — inject secrets at runtime.
