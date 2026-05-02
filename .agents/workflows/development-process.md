---
description: Working process for developing architect-prime-gcp-agent — checkpoint-driven, manifest-first, no-secrets discipline.
---

# Development Process

> Core development discipline is in `.agents/rules/project-context.md` (always-present context).
> This workflow covers the step-by-step procedures.

## Making a change

1. **Edit** — Make changes in the appropriate module
2. **Manifest** — If adding/removing installed files, update `infra/manifests/`
3. **Contracts** — If changing cross-cutting values, update `contracts.json`
4. **Push** — `/update-git` (commit with `vX.Y.Z:` prefix)
   - ⚠️ **Every commit on main MUST start with `vYYYY.MM.DD.X.Y:`** — non-prefixed commits cause "update unknown" in the dashboard footer (`extractVersion()` in `app/src/app/api/upgrade/route.ts`)
5. **Deploy** — Dashboard upgrade button on the target Prime/Fleet instance
6. **Debug** — `/ssh-vm-access` if something breaks
7. **Verify** — `/firestore-query` to check state
8. **Finalize** — When version is stable: `/finalize-checkpoint` (updates docs, tags, pushes)

## Cloud Run deploy (app/ changes only)

The dashboard itself is a Cloud Run service. App changes need a separate build:

```powershell
gcloud builds submit --tag us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --project=architect-prime-beta app/
gcloud run deploy architect-prime --image=us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --region=us-central1 --project=architect-prime-beta --allow-unauthenticated
```

Or use the dashboard's **Upgrade Dashboard** button (triggers Cloud Build automatically).
