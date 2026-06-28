---
name: REPO Improvement Landing
description: >
  How to land a REPO-level (upstream) platform improvement: confirm it is clean
  of operator identity, run the contamination scan, branch, and open a PR to main.
---

# REPO Improvement Landing

> **Tier:** REPO (upstream-safe, benefits every fork)
> **Agent part:** motor
> **Purpose:** The canonical procedure for landing a generic platform improvement as a PR to `main`. Every `[REPO]` improvement process delegates its landing step here.

## When to use

Use this skill when the improvement process you are executing has `"tier": "repo"`. The change must touch only generic platform files and contain zero operator-specific values.

## Procedure

### Step 1 — Confirm the change is operator-neutral

Review every file you modified. Confirm that **none** of the following appear in your changes:

- Real project IDs, GCP project names, or billing accounts
- Real Google Drive folder/file IDs or Space IDs
- Real email addresses or domain names (use `@example.com`, `your-domain.com`)
- Real organization or company names (use `YOUR_GITHUB_ORG`, `your-company`)
- Real Cloud Run URLs, GCS bucket names, or API keys
- Any value that would only be correct for one specific deployment

If any operator-specific value is present, you have two options:
1. **Parameterize it** — replace with a template variable, env-var lookup, or metadata read. Then the change is still REPO.
2. **Reclassify to LOCAL** — stop using this skill and switch to the `local-improvement` skill. The change stays in this deployment only.

### Step 2 — Run the contamination scan

Run the `fresh-install-scan` tool on the files you changed:

```
fresh-install-scan <repo-root> --operator-terms "<known operator terms>" --severity-min high
```

| Scan result | Action |
|---|---|
| **Clean** (0 high/critical findings on changed files) | Proceed to Step 3 |
| **Findings on your changes** | Parameterize the flagged values and re-scan, or reclassify to LOCAL |
| **Findings on untouched files** | Not your problem — note them for a future contamination sweep but proceed |

> **Gate rule:** If the scan is not clean on your changed files, you MUST NOT open a PR. Fix or reclassify.

### Step 3 — Branch, commit, and open the PR

Using `git-ops`:

1. Create branch: `improve/<module>-<short-description>` (e.g. `improve/skills-workspace-docs-procedures`)
2. Stage only the files related to this improvement
3. Commit with message: `improve(<module>): <what changed>`
4. Push the branch
5. Open a PR to `main` with the following in the description:
   - **Module:** which improvement module this belongs to
   - **Tier:** REPO
   - **Evidence:** before/after comparison, mechanical metrics if applicable
   - **Contamination scan:** confirm clean result

### Step 4 — Report

Report back to the calling process with:
- The PR URL
- The branch name
- The scan result (clean / parameterized N values)
- Any values that were parameterized during the contamination gate

## Error Recovery

| Error | Recovery |
|---|---|
| Scan flags an operator value in your change | Parameterize it (replace with env var / metadata / placeholder) and re-scan. If not possible, reclassify to LOCAL. |
| PR has merge conflicts | Rebase onto `main` per `git-ops` skill, resolve conflicts, force-push the branch. |
| PR review requests changes | Address the feedback, amend the commit, re-push. |
| Accidentally committed to `main` | Revert the commit on `main`, cherry-pick to a branch, open a proper PR. |
| Change touches both platform and operator files | Split: platform changes via this skill (REPO PR), operator changes via `local-improvement` skill. Never mix in one PR. |

## Worked Example

**Scenario:** Landing an improved `workspace-docs` skill (better procedures for tab creation).

1. **Confirm operator-neutral:** The SKILL.md changes reference `@example.com` emails, `YOUR_DRIVE_FOLDER_ID` placeholders, and generic tab names. No operator values. ✅
2. **Run scan:** `fresh-install-scan . --operator-terms "tachin,chill@" --severity-min high` → 0 findings on changed files. ✅
3. **Branch and PR:**
   - Branch: `improve/skills-workspace-docs-tabs`
   - Commit: `improve(skills): add tab creation procedures to workspace-docs`
   - PR description includes before/after (old SKILL.md lacked tab procedures, new one has 5-step procedure with error recovery), scan result (clean), tier (REPO).
4. **Report:** PR #42 opened, branch `improve/skills-workspace-docs-tabs`, scan clean, 0 values parameterized.
