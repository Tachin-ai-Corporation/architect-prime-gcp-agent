# Skill: Git Workspace

## When to Use
When working with git-backed artifact repos — cloning project repos, creating mission branches, committing checkpoint work, syncing changes to the ether, merging branches, or inspecting repo state (status, diffs, logs).

## Architecture

Every project has a git repo in the tenant's GCS-backed git store. Objects (bundles) live in GCS; refs live in Firestore with CAS (compare-and-swap) protection. The host `git` binary does all object manipulation. This skill provides thin CLI wrappers for motor agents.

**Repo naming:** `{projectId}` — one repo per project.
**Branch naming:** `main` (default), `mission/{missionId}` (per-mission work branches).
**Commit format:** Canonical `v{YYYY}.{MM}.{DD}.{index}.{subindex}: description` (C-23).

## Commands

### Read
- `work-status [--dir <path>]` — Show local repo status: branch, modified/staged files, ahead/behind remote.
  Output: JSON with branch, clean (boolean), staged files, modified files, untracked files.

- `work-diff [--dir <path>] [--staged] [--stat] [--file <path>]` — Show file diffs in the local repo.
  Output: Git diff output (text). Use `--staged` for staged changes, `--stat` for summary only.

- `work-log [--dir <path>] [--count <n>] [--oneline]` — Show commit history.
  Output: Git log output (text). Default: last 10 commits.

### Write
- `work-clone <repoId> [--ref <branch>] [--dir <path>]` — Clone a repo from the ether into a local directory.
  Output: JSON with repoId, branch, sha, dir.

- `work-branch <branchName> [--dir <path>]` — Create and switch to a new local branch.
  Output: JSON with branch name and status.

- `work-commit <message> [--dir <path>] [--add-all]` — Commit staged changes (or all changes with `--add-all`).
  Output: JSON with sha, message, filesChanged.

- `work-sync <repoId> [--branch <branch>] [--dir <path>] [--actor <id>]` — Push local commits to the ether. Handles non-fast-forward with automatic fetch+rebase+retry.
  Output: JSON with status (pushed/up_to_date/failed), sha, attempts.

- `work-merge <repoId> <sourceBranch> [--target <branch>] [--policy auto|gated] [--actor <id>]` — Merge source branch into target (default: main). Policy `gated` returns AWAITING_APPROVAL without merging.
  Output: JSON with status (merged/AWAITING_APPROVAL/failed), sha.

## Procedures

### Start working on a mission (called by daemon, not motor)
The brain daemon calls `work-clone` and `work-branch` automatically when activating a mission. Motor agents receive a pre-configured working directory.

### Commit checkpoint work
1. Make your file changes in the working directory.
2. Run `work-commit "v2026.07.04.1.0: description of changes" --add-all` to commit all changes.
3. Run `work-sync <repoId> --branch mission/<missionId>` to push to the ether.
4. Verify: Run `work-status` to confirm clean working tree and synced state.

### Inspect what changed
1. Run `work-status` to see which files are modified, staged, or untracked.
2. Run `work-diff` to see the actual changes (or `work-diff --staged` for staged changes).
3. Run `work-diff --stat` for a summary of changed files and line counts.
4. Run `work-log --count 5` to see the last 5 commits.

### Merge mission work to main (called by daemon on mission completion)
The brain daemon calls `work-merge` automatically when completing a mission. This is typically not invoked directly by motor agents.

## Error Recovery

| Scenario | Cause | Resolution |
|----------|-------|------------|
| `work-sync` returns `failed` | Rebase conflict after non-fast-forward | Motor should resolve conflicts manually, then re-commit and re-sync |
| `work-clone` returns null sha | Empty repo (no commits yet) | Normal for new projects — proceed to make first commit |
| `work-commit` fails | No staged changes | Use `--add-all` or manually stage files with `git add` |
| `work-merge` returns `AWAITING_APPROVAL` | Gated merge policy | Normal — approval will be handled by the approval gate system |
| `work-merge` returns `failed` | Merge conflict | Resolve conflicts in a local clone, commit, then re-merge |

## Important Rules

1. **Never commit directly to `main`** — always work on a mission branch.
2. **Use canonical commit format** (C-23): `v{YYYY}.{MM}.{DD}.{index}.{subindex}: description`.
3. **Commit early, commit often** — each checkpoint should produce at least one commit.
4. **Sync after every commit** — push to the ether so other agents can see your work.
5. **Don't modify .git internals** — use these tools, not raw git commands.
