---
description: Stage, commit, and push all changes to the main branch. Use before deploying via dashboard upgrade.
---

# Update Git

// turbo-all

## Stage and review

```bash
git add -A; git status
```

## Commit and push

```bash
git commit -m "description of changes"; git push origin main
```

## After pushing
Use the **dashboard upgrade button** on the target Prime/Fleet instance to deploy.
