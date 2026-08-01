# gsutil (Google Cloud Storage)

## When to Use
Google Cloud Storage work via the `gsutil` CLI: inspect objects and buckets, create buckets,
copy/sync files, set bucket permissions, and remove objects. For IAM / Cloud Run / logging use the
**`gcloud`** skill; for container images use the **`docker`** skill.

## Your tools
| Tool | Use |
|------|-----|
| `gsutil` | The Google Cloud Storage CLI — buckets and objects. |

## Commands

### Read (non-mutating)
- `gsutil ls gs://BUCKET/PREFIX/` — list objects under a prefix.
- `gsutil stat gs://BUCKET/PREFIX/OBJECT` — object metadata (size, content-type, update time).
- `gsutil du -sh gs://BUCKET/PREFIX/` — total size under a prefix.
- `gsutil ls -L -b gs://BUCKET` — bucket metadata (location, storage class).
- `gsutil iam get gs://BUCKET` — read the bucket's IAM policy.

> **Count objects** with `gsutil ls gs://BUCKET/PREFIX/ | wc -l` — never save a listing to a file and
> hand-parse it with a `python3 -c` one-liner (fragile shell quoting).

### Write (mutating — see Safety)
- `gsutil mb -l REGION gs://BUCKET` — make a bucket.
- `gsutil cp LOCAL gs://BUCKET/PATH` / `gsutil cp gs://BUCKET/PATH LOCAL` — copy to / from a bucket.
- `gsutil -m rsync -r LOCAL_DIR gs://BUCKET/PREFIX` — mirror a directory tree (`-m` = parallel).
- `gsutil iam ch MEMBER:ROLE gs://BUCKET` — grant a bucket-level IAM role.
- `gsutil rm gs://BUCKET/PATH` — delete an object (destructive).

## Procedures

### Inspect what a bucket holds
1. `gsutil ls -L -b gs://BUCKET` for the bucket's location and storage class.
2. `gsutil ls gs://BUCKET/PREFIX/` to list objects; `gsutil stat gs://BUCKET/PREFIX/OBJECT` for one object's metadata.

### Create a bucket and upload content
1. Idempotent-check first: `gsutil ls -b gs://BUCKET` — if it already exists, skip the make.
2. `gsutil mb -l REGION gs://BUCKET`.
3. `gsutil cp LOCAL gs://BUCKET/PATH` for single files, or `gsutil -m rsync -r LOCAL_DIR gs://BUCKET/PREFIX` for a whole tree.
4. Verify: `gsutil ls gs://BUCKET/PREFIX/` shows the uploaded objects.

### Grant access to a bucket
1. `gsutil iam ch serviceAccount:SA@PROJECT.iam.gserviceaccount.com:roles/storage.objectViewer gs://BUCKET` — least privilege (`objectViewer` to read; `objectAdmin` only if writes are needed).
2. Verify: `gsutil iam get gs://BUCKET`.

## Error Recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `BucketNotFoundException` / 404 | Wrong bucket name or project | Re-list with `gsutil ls`; confirm the exact bucket name and that your credentials can see the project. |
| `AccessDeniedException: 403` | Caller SA lacks the storage role | Grant `roles/storage.objectViewer` (read) or `objectAdmin` (write) via `gsutil iam ch`, or in the `gcloud` skill. |
| `cp` overwrote something you needed | Default copy overwrites | Use `gsutil cp -n` (no-clobber) to skip existing; `rsync` reconciles a whole tree deterministically. |
| Slow large transfers | Sequential copy | Add `-m` for parallelism (`gsutil -m cp` / `gsutil -m rsync`). |

## Safety
- `gsutil rm` and `rsync -d` (delete-extras) are **destructive** — list first, and never delete without confirming the exact target.
- Least privilege on `iam ch`; verify with `gsutil iam get` after granting.
- Use `-n` (no-clobber) when you must not overwrite existing objects.
