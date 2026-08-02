# Skill: Git Workflow Operations

## When to Use
When performing git workflow operations including feature branch management, conventional commits, pre-commit checks, pulling upstream updates, and resolving merge conflicts.

## Commands

No custom corekit scripts are governed by this skill. Standard `git` commands are used directly.

## Procedures

### Feature branch creation and sync
1. Ensure you are on the latest main branch:
   ```bash
   git checkout main && git fetch origin && git rebase origin/main
   ```
2. Create and switch to your feature branch:
   ```bash
   git checkout -b feat/<short-description>
   ```
3. Regularly sync with main:
   ```bash
   git fetch origin && git rebase origin/main
   ```
4. Verify: Run `git branch` and confirm you are on your feature branch and it is up to date.

### Code commit and verification
1. Run pre-commit quality checks (e.g. `npm run lint` or `ruff check .`).
2. Stage modified files using `git add <file1> <file2>`.
3. Commit with a conventional commit message (e.g. `feat(auth): add token validation`).
4. Verify: Run `git log -1` and confirm your commit is listed with the correct conventional format.

### Resolving merge conflicts
1. Identify the conflict files:
   ```bash
   git diff --name-only --diff-filter=U
   ```
2. Open conflict files and edit to resolve standard conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
3. Stage the resolved files:
   ```bash
   git add <resolved_file>
   ```
4. Continue the rebase:
   ```bash
   git rebase --continue
   ```
5. Verify: Ensure the rebase finishes cleanly with no outstanding conflicts.

### Open a pull request
1. Ensure all changes are committed and pushed to the feature branch:
   ```bash
   git push -u origin <branch-name>
   ```
2. Create the pull request:
   ```bash
   gh pr create --base main --head <branch-name> --title "<title>" --body "<description>"
   ```
3. Verify the PR was created:
   ```bash
   gh pr list --head <branch-name>
   ```
4. Report the PR URL from the output.

---

## Git Workflow Reference

### Feature Branch Management

| What | Command |
|------|---------|
| Create feature branch | `git checkout -b feat/<short-description> main` |
| Create fix branch | `git checkout -b fix/<short-description> main` |
| List branches | `git branch -a --sort=-committerdate` |
| Switch branch | `git checkout BRANCH_NAME` |
| Update from main | `git fetch origin && git rebase origin/main` |
| Delete local branch | `git branch -d BRANCH_NAME` |
| Delete remote branch | `git push origin --delete BRANCH_NAME` |
| Open pull request | `gh pr create --base main --head BRANCH --title "title" --body "desc"` |

### Commit Message Formatting
Use conventional commits format:
`<type>(<scope>): <subject>`

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

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `git rebase` fails with conflict | Changes in your branch conflict with commits on target branch | Run `git diff --name-only --diff-filter=U` to identify conflict files. Resolve conflicts, run `git add <file>`, and then run `git rebase --continue`. |
| `git push` rejected (non-fast-forward) | Remote branch has newer commits not present locally | Run `git fetch origin` followed by `git rebase origin/main` (or origin/feature-branch) to sync before pushing. |
| Commits made on incorrect branch | Edits committed directly to main instead of a feature branch | Run `git branch temp-branch`, reset main to upstream state: `git reset --hard origin/main`, then switch to the temp branch: `git checkout temp-branch`. |

## Safety Rules
- Never force-push to `main`, `master`, or `develop`
- Always fetch before rebase — work with latest remote state
- Run pre-commit checks before pushing
- Use `--dry-run` with destructive git operations when available
- Verify branch name before deleting — list first, delete second

---

### Run pre-commit checks
Run these IN ORDER before every commit. If any step fails, fix the issue and re-run from step 1.
1. **Format** — run the project's formatter (e.g. `prettier`, `black`, `gofmt`).
2. **Lint** — run the project's linter (e.g. `eslint`, `ruff`, `golangci-lint`), applying auto-fixes where safe.
3. **Type check** — run the type checker if the project has one (e.g. `tsc --noEmit`, `mypy`).
4. **Test** — run the test suite (e.g. `npm test`, `pytest`, `go test ./...`).
5. Verify: all steps exit clean before staging the commit.
