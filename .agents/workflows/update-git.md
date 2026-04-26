---
description: Stage, commit, and push all changes to the main branch. Use before deploying via dashboard upgrade.
---

# Update Git

// turbo-all

## Stage and review

```powershell
git add -A; git status
```

## Commit

Commit message format: `vX.Y.Z: description`

- Every commit is named by the version it is building toward
- Untagged commits are **unstable** (work in progress toward next version)
- Tagged commits are **stable** (deployable checkpoints)

```powershell
git commit -m "vX.Y.Z: description of changes"
```

## Push

```powershell
git push origin main
```

## Tag (when ready to mark stable)

Only tag when a version is complete and verified:

```powershell
git tag -a vX.Y.Z -m "vX.Y.Z: summary"; git push origin --tags
```

## After pushing

Use the **dashboard upgrade button** on the target Prime/Fleet instance to deploy.
The dashboard always deploys from `main` HEAD. Tags are display labels for stability.
