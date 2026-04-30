---
description: Finalize a version checkpoint — update docs, commit, tag, push. Run after verifying a stable checkpoint.
---

# Finalize Checkpoint

> Run this after you've verified all changes work and the checkpoint is ready to be stamped.

// turbo-all

## 1. Update documentation

Review and update these files to reflect the new checkpoint reality.
**Rules from MISSION_PLAN.md header apply**: current state only, no stale references, no changelogs.

### MISSION_PLAN.md
- Update `Current version:` header to the new version
- Update any architecture sections that changed (e.g., chat pipeline, bootstrap, tools)
- Move the completed roadmap milestone to "Completed" section
- Write the next roadmap milestone as "Current"
- Remove all references to the old approach if something was replaced

### README.md
- Update `Current version:` badge
- Update architecture diagram if any descriptions changed
- Update "What It Does" table if capabilities changed
- Update bootstrap section if OpenClaw pin or process changed
- Add new version to "Version History" table at the bottom

### .agents/rules/project-context.md
- Update version reference (e.g., `## Current Architecture (vX.Y.Z)`)
- Update any architecture descriptions that changed

### Other docs (if applicable)
- `docs/architecture/` files if brain or dispatch architecture changed
- `brain/` workspace files if agent instructions changed
- `infra/contracts.json` if cross-cutting values changed

## 2. Stage and review

```powershell
git add -A; git status
```

Verify only documentation files are staged. No accidental code changes.

## 3. Commit

```powershell
git commit -m "vX.Y.Z: finalize checkpoint — update MISSION_PLAN, README, project-context"
```

## 4. Push

```powershell
git push origin main
```

## 5. Tag

Move both the version tag and STABLE tag to the final commit (including docs):

```powershell
git tag -f vX.Y.Z -m "vX.Y.Z: one-line summary of the checkpoint"
git tag -f STABLE
git push origin vX.Y.Z -f
git push origin STABLE -f
```

## 6. Verify tags

```powershell
git log --oneline -1 --decorate
```

Expected output should show `HEAD -> main, tag: vX.Y.Z, tag: STABLE, origin/main` all on the same commit.
