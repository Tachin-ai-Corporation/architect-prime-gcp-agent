# Skill: Git Workflow Operations

Use these procedures when performing git workflow tasks via `exec`.

## Feature Branch Management

| What | Command |
|------|---------|
| Create feature branch | `git checkout -b feat/TICKET-description main` |
| Create fix branch | `git checkout -b fix/TICKET-description main` |
| List branches | `git branch -a --sort=-committerdate` |
| Switch branch | `git checkout BRANCH_NAME` |
| Update from main | `git fetch origin && git rebase origin/main` |
| Delete local branch | `git branch -d BRANCH_NAME` |
| Delete remote branch | `git push origin --delete BRANCH_NAME` |

### Branch Naming Convention
- `feat/TICKET-short-description` — new features
- `fix/TICKET-short-description` — bug fixes
- `chore/TICKET-short-description` — maintenance, deps, config
- `refactor/TICKET-short-description` — code restructuring

## Commit Message Formatting

Use conventional commits format:
```
<type>(<scope>): <subject>

<body>

<footer>
```

| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no logic change |
| `refactor` | Code restructure, no behavior change |
| `test` | Adding or fixing tests |
| `chore` | Build, deps, config changes |
| `perf` | Performance improvement |

### Commit Commands
```bash
# Stage specific files
git add FILE1 FILE2

# Commit with conventional message
git commit -m "feat(auth): add OAuth2 token refresh"

# Amend last commit (unpushed only)
git commit --amend --no-edit
```

## Pre-Commit Checks

Run before every commit. Fail fast — stop on first error.

```bash
# Lint
npm run lint 2>&1 || echo "LINT FAILED"

# Format check
npm run format:check 2>&1 || echo "FORMAT FAILED"

# Type check (TypeScript)
npx tsc --noEmit 2>&1 || echo "TYPE CHECK FAILED"

# Unit tests
npm test 2>&1 || echo "TESTS FAILED"
```

For Python projects:
```bash
ruff check . 2>&1 || echo "LINT FAILED"
ruff format --check . 2>&1 || echo "FORMAT FAILED"
mypy . 2>&1 || echo "TYPE CHECK FAILED"
pytest --tb=short 2>&1 || echo "TESTS FAILED"
```

## PR Description Template

```bash
# Push branch and create PR
git push -u origin BRANCH_NAME

# PR body template (use with gh cli or API)
cat <<'EOF'
## Summary
Brief description of what this PR does.

## Changes
- Change 1
- Change 2

## Testing
- [ ] Unit tests pass
- [ ] Manual testing done
- [ ] No regressions

## Related
- Ticket: TICKET-ID
- Depends on: #PR_NUMBER (if applicable)
EOF
```

## Merge Conflict Resolution

```bash
# 1. Fetch latest
git fetch origin

# 2. Rebase onto target
git rebase origin/main

# 3. If conflicts, list them
git diff --name-only --diff-filter=U

# 4. After resolving each file
git add RESOLVED_FILE

# 5. Continue rebase
git rebase --continue

# 6. If rebase is unrecoverable
git rebase --abort
```

## Stale Branch Cleanup

```bash
# List branches merged into main
git branch --merged main

# List branches older than 30 days
git for-each-ref --sort=committerdate --format='%(committerdate:short) %(refname:short)' refs/heads/

# Prune remote tracking branches
git remote prune origin

# Delete merged branches (excluding main/master/develop)
git branch --merged main | grep -vE '(main|master|develop)' | xargs -r git branch -d
```

## Git Log Analysis

```bash
# Recent commits (compact)
git log --oneline -20

# Commits by author in last 7 days
git log --author="NAME" --since="7 days ago" --oneline

# Files changed in last N commits
git diff --stat HEAD~N

# Commit frequency by day
git log --format='%ad' --date=short | sort | uniq -c | sort -rn | head -20

# Find large files in history
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | sed -n 's/^blob //p' | sort -rnk2 | head -20
```

## Safety Rules
- Never force-push to `main`, `master`, or `develop`
- Always fetch before rebase — work with latest remote state
- Run pre-commit checks before pushing
- Use `--dry-run` with destructive git operations when available
- Verify branch name before deleting — list first, delete second
