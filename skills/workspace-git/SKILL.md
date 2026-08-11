# Skill: Git Workspace

> **Note (A16):** The brain daemon automatically clones mission workspaces into
> `shared/{missionId}/` at mission start. 
> 
> > [!WARNING]
> > **DO NOT instruct agents (Motor) to clone the mission's primary project repository.** The Brain Daemon has ALREADY cloned it into `shared/<missionId>`. Prefrontal plans must NOT include a "Clone the repo" step. Motor agents must NOT run `work-clone` for the main project. Just start working in `shared/<missionId>/` directly!
> 
> > [!NOTE]
> > The auto-clone contains the project repo's `main` plus your `mission/<missionId>` branch — nothing more. Files produced by an upstream teammate, or files named in a delegated instruction, are NOT guaranteed to be in that clone. Before depending on a named input file, verify it exists in the workspace; if it does not, obtain it as the delegated instruction directs. A delegated instruction that has upstream inputs carries an explicit `[INPUT FILES]` block naming the delegator's mission branch — run its retrieval command, e.g. `work-clone <repoId> --ref mission/<delegatorMissionId> --dir delegator-inputs`, then read from `delegator-inputs/`. If a named file is still absent, it was not produced: report what is missing rather than looping over an empty workspace.
> 
> `work-clone`'s bare default (`shared/{repoId}`) is ONLY for ad-hoc cross-project reads outside of missions.

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

### Edit a file in the working tree — surgically, and mind the quote trap
Your changes go into files in `shared/<missionId>/`. A content change (retitle an
`index.html` heading, tweak a CSS value) is a *surgical* edit: change the smallest unique
span and leave the rest byte-for-byte identical. HOW you make the edit decides whether you
quietly corrupt the file:

- **Match the smallest unique token — never a whole block.** To retitle one heading, target
  just that text: `sed -i 's/>Proof</>The proof</' index.html`. Do NOT build a multi-line
  `sed` whose pattern is a big chunk of surrounding markup — basic `sed` cannot match across
  newlines, so it fails and you retry blind.
- **THE QUOTE TRAP — it silently corrupts files.** A `sed 's/…/…/'` program is wrapped in
  single quotes by the shell. If the text inside contains an apostrophe or quote — `payor's`,
  `class="x"`, an inline `<script>` using `'.reveal'` — the shell escaping turns every `'`
  into `\'` and writes the backslashes into the file, mangling dozens of quotes and breaking
  inline JS (the page then renders blank below the first broken script). If the span you must
  match or insert contains any quote, do NOT hand it to inline `sed`.
- **Beyond a tiny quote-free token, edit by writing the file — not by a shell string.** Read
  the file, compute the new content, and write it literally (`writeFile`, or a small `python3`
  `s=open(p).read().replace(OLD,NEW,1); open(p,'w').write(s)`) — string ops never shell-escape.
- **Prove the edit is surgical BEFORE you commit.** `work-diff --stat` must show ~the lines you
  meant — a one-word change is a 1–2 line diff, not the whole file — and `grep -n "\\'" <file>`
  must return nothing (a stray `\'` = you hit the quote trap: revert the file and redo it with
  `writeFile`/`python3`). A change that corrupts the file is not a completed change.
- **Edit the REPO-TRACKED file, inside your working dir — not a stray copy.** The file to change
  is the one git tracks in `shared/<missionId>/` (the working dir the daemon set up). If after your
  edit `work-diff --stat` shows **nothing changed**, you edited a file OUTSIDE the tracked tree (a
  root-level or scratch copy at a different path) — the edit is invisible to the repo and will never
  reach `main` or a git-source deploy. Find the tracked file (`work-status` lists it; it lives under
  your working dir), edit THAT one, and confirm `work-diff` now shows your change.

### Commit checkpoint work
You are ALREADY on your `mission/<missionId>` branch (the daemon put you there) and the repo is
already cloned into the working dir. Do NOT `git checkout`/switch to `main`, do NOT create a NEW
branch (do not `work-branch` a `feature/…` branch), do NOT clone, and do NOT try to `work-merge`
your work onto `main` yourself. A push to `main` is refused, and there is **no** direct-push-to-main
capability — the daemon merges your `mission/<missionId>` branch onto `main` **automatically on
mission completion**. Reaching `main` is NOT your step; your job is only to edit + commit + sync on
the branch you are already on. (A task instruction that says "create a branch from main" or "push to
main" is over-specified — ignore the git mechanism and just edit the file in place, commit, sync.)
Just commit on the branch you are on.
1. Make your file changes in the working directory (see "Edit a file in the working tree").
2. **Confirm the diff is ONLY your change before committing.** Run `work-diff --stat` — it must
   show just the file(s) you meant. If it lists unrelated or scratch files, do NOT `--add-all`
   (that sweeps the whole tree — a commit carrying dozens of unintended files is a failed
   commit); stage only your file(s) (`git add <path>`) and commit those.
3. Commit with the **C-23** message — `work-commit "v{YYYY}.{MM}.{DD}.{index}.{subindex}: what
   changed"` — NOT a conventional-commit `fix:`/`feat:` message. Add `--add-all` ONLY when step 2
   confirmed every pending change is yours.
4. Run `work-sync <repoId> --branch mission/<missionId>` to push to the ether.
5. Verify: `work-status` shows a clean working tree on your `mission/<missionId>` branch, synced.

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
| A one-line content edit shows a whole-file `work-diff`, stray `\'`/`\"` in the file, or the page renders blank below the first section | An inline `sed 's/…/…/'` whose pattern/replacement held apostrophes or quotes — the shell escaped them into the file, breaking inline JS | Revert the file; redo as the smallest quote-free token, or via `writeFile`/`python3` `.replace()` (literal, no shell escaping). Confirm `work-diff --stat` is minimal and `grep "\\'" <file>` is empty before `work-commit` |

## Important Rules

1. **Never commit directly to `main`** — always work on a mission branch.
2. **Use canonical commit format** (C-23): `v{YYYY}.{MM}.{DD}.{index}.{subindex}: description`.
3. **Commit early, commit often** — each checkpoint should produce at least one commit.
4. **Sync after every commit** — push to the ether so other agents can see your work.
5. **Don't modify .git internals** — use these tools, not raw git commands.
