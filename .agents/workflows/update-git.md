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

Version format: `v{YYYY}.{MM}.{DD}.{index}.{subindex}`

- Every commit is named by the version it is building toward
- Untagged commits are **unstable** (work in progress)
- The `STABLE` tag marks the last verified-good commit

```powershell
git commit -m "v2026.04.28.1.0: description of changes"
```

## Push

```powershell
git push origin main
```

## Mark stable (after verification)

Move the `STABLE` tag to the current commit:

```powershell
git tag -f STABLE; git push origin STABLE -f
```

## After pushing

Use the **dashboard upgrade button** on the target Prime/Fleet instance to deploy.
The dashboard always deploys from `main` HEAD.
