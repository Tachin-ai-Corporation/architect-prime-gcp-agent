# Skill: GitHub PR (upstream contribution)

## Availability (built into this skill)

> [!IMPORTANT]
> **Prime-only.** Scoped to Prime agents (`skill.json` `roles: ["prime"]`). This is Prime's CONTRIBUTE capability — the concrete, GitHub-authenticated tooling that turns a verified platform improvement into a **human-gated draft PR** on the generic repo (the fleet VMs have no `gh` CLI, and their git origin is the git-store, not GitHub).

## The one rule
**Prime opens draft PRs; a human reviews and merges. Prime NEVER merges.** A PR to the public template repo is `destructive_or_public` (B-28) — the draft state + human merge is the approval gate, by construction.

## Prerequisite
A GitHub token in Secret Manager (default `aps-secret-github-token`), granted `roles/secretmanager.secretAccessor` for this VM's service account, with repo scope `contents:write` + `pull_requests:write` (and **not** merge/admin). `secret-read` reads it; the token is never logged or persisted in git config.

## Commands
- `github-clone [--repo owner/name] [--dir <path>] [--ref <branch>] [--secret <id>]` — Fresh-clone the upstream repo (defaults to `owner/repo` from `STATE.json`). Authenticates with the token, then scrubs it from the clone's `origin` (pushes re-inject it). Prints `{repo, dir, branch}`.
- `github-pr-open --dir <clone> --branch <branch> --title "<t>" --body-file <f> [--base main] [--ready]` — Push `<branch>` and open a **draft** PR. Refuses if the branch has no commits ahead of base. `--ready` opens a non-draft PR (avoid unless the operator asked). Surfaces an existing PR (422) instead of failing. Prints `{status, number, url, draft}`.

## Procedure: land a verified REPO improvement as a PR
1. **Clone** — `github-clone` → note the returned `dir` and default `branch`.
2. **Branch** — in `dir`: `git checkout -b improve/<module>-<slug>`.
3. **Apply** — make the change following full repo discipline: edit + manifest entry in the same commit (C-9), `contracts.json` if cross-cutting (C-7), a pure `tests/` case where testable. Keep it template-clean (placeholders, no operator values) — scan the diff for operator-specific tokens before committing.
4. **Commit** — version-prefixed message (C-23): `git add <files> && git commit -m "vYYYY.MM.DD.N.0: ..."`.
5. **Self-verify** — run `node --check` / the affected `tests/` / `validate-contracts` inside the clone. A change that can't pass its own gates does NOT become a PR.
6. **Body** — write the PR body to a file: problem, evidence (the mission IDs that surfaced it), the change, canon citations, and the self-verify result.
7. **Open** — `github-pr-open --dir <dir> --branch improve/<...> --title "..." --body-file <body>` (draft by default).
8. **Gate** — post the returned PR URL to the operator as an `approval_gate`. Stop. The human reviews and merges; the normal dashboard upgrade then rolls it out.

## Error Recovery
| Symptom | Cause | Recovery |
|---|---|---|
| `Could not read GitHub token` | Secret missing or SA lacks accessor | Confirm `aps-secret-github-token` exists and the VM SA has `secretmanager.secretAccessor`. |
| `git push failed (branch protection or token scope?)` | Token lacks `contents:write`, or branch protection blocks the push | Verify the fine-grained token's repo + permissions. Never force-push. |
| PR create `422` | A PR already exists for this head, or head==base | The tool surfaces the existing PR URL; otherwise ensure the branch differs from base with real commits. |
| `branch has no commits ahead of base` | Nothing was committed | Commit the change on the branch before opening the PR. |

## Safety
- Draft PRs only (unless `--ready` is explicitly requested by the operator). Never merge.
- Token via `secret-read` in inline command substitution only — never echoed, written to a file, or left in `.git/config`.
- One improvement per PR. Never open a PR that modifies a canon document (`docs/PRODUCT_CANON.md`, `docs/BRAIN_CANON.md`) — escalate canon changes to the operator as a proposal instead.
