# Engineer Specialty — Motor Operational Procedures

## Git Workflow (Feature Branches Only)

Never commit directly to `main` or `master`. All work happens on feature branches.

### Branch Lifecycle
```bash
# 1. Ensure main is up to date
git checkout main && git pull origin main

# 2. Create feature branch
git checkout -b feat/<short-description>

# 3. Make changes, stage, commit (see Commit Hygiene below)

# 4. Push branch
git push -u origin feat/<short-description>
```

### Before Pushing
```bash
# Rebase on latest main if behind
git fetch origin
git rebase origin/main

# Resolve any conflicts before pushing — never push with conflicts
```

## Commit Hygiene

- Write clear, imperative commit messages: `Add user auth middleware`, not `added stuff`.
- One logical change per commit. Do not bundle unrelated changes.
- Keep commits atomic — each commit should compile and pass tests independently.
- Use conventional commit prefixes when the project uses them: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

### Commit Message Format
```
<type>: <short summary in imperative mood>

<optional body — explain WHY, not WHAT>
```

## Pre-Commit Checks (Run Before Every Commit)

Run these checks IN ORDER before committing. Fix failures before proceeding.

1. **Format**: Run the project's formatter (e.g., `prettier`, `black`, `gofmt`).
2. **Lint**: Run the project's linter (e.g., `eslint`, `ruff`, `golangci-lint`).
3. **Type check**: Run type checker if applicable (e.g., `tsc --noEmit`, `mypy`).
4. **Test**: Run the test suite (e.g., `npm test`, `pytest`, `go test ./...`).

```bash
# Example for a TypeScript project
npx prettier --write .
npx eslint --fix .
npx tsc --noEmit
npm test

# Example for a Python project
black .
ruff check --fix .
mypy .
pytest
```

If any step fails, fix the issue and re-run from step 1.

## Diff Hygiene

- Review your diff before committing: `git diff --staged`.
- Remove debug statements (`console.log`, `print()`, `debugger`).
- Remove commented-out code — version control is the history.
- Ensure no unrelated whitespace-only changes.
- Check for accidentally staged files: `git status`.

## Safety Rules

- **No secrets in commits**: Never commit API keys, tokens, passwords, or `.env` files.
  Check `.gitignore` includes sensitive file patterns before committing.
- **Preserve existing tests**: Never delete or skip existing tests to make your code pass.
- **Read before writing**: Always `cat` or read a file before editing it. Never overwrite
  a file without understanding its current contents.

## Drive File Editing (MANDATORY for delegation tasks)
When editing files from Google Drive (delegation from architect or another agent):
1. **Download** the file using `drive-download <fileId> --output <local_path>`.
2. **Read** the downloaded file with `readFile` to load it into context.
3. **Modify** the content — apply all required changes.
4. **Write the modified file** using `writeFile` with the COMPLETE modified content.
   - **This is the PRIMARY deliverable. Without this `writeFile` call, the task FAILS.**
5. **Upload** the written file using `drive-upload <path> <folderId>`.

CRITICAL: The download→upload cycle is NOT enough. You MUST call `writeFile` BETWEEN
download and upload to save your modifications. Without `writeFile`, you are uploading
the original unmodified file.

## Test Execution Patterns

When running tests, capture and report results clearly:

```bash
# Run full suite
pytest -v 2>&1 | tail -30

# Run specific test file
pytest tests/test_feature.py -v

# Run with coverage
pytest --cov=src --cov-report=term-missing
```

If tests fail:
1. Read the failure output carefully.
2. Identify root cause (your change vs. pre-existing failure).
3. Fix only failures caused by your changes.
4. Re-run the full suite to confirm no regressions.

## File Discovery Before Editing

Before modifying any source file:

```bash
# Understand the file's role
head -30 <file>

# Check what depends on it
grep -r "import.*<module>" --include="*.py" .  # Python
grep -r "from.*<module>" --include="*.ts" .     # TypeScript

# Check test coverage
find . -name "test_*" -o -name "*_test.*" -o -name "*.test.*" | grep <module>

# Recent changes
git log --oneline -5 -- <file>
```

## Error Recovery Patterns

| Error | Discovery | Fix |
|-------|-----------|-----|
| Merge conflict | `git status`, `git diff` | Resolve manually, `git add`, continue rebase/merge |
| Tests fail after change | Read test output, `git diff` | Fix code or update tests for intentional changes |
| Lint errors | Run linter with `--fix` flag | Apply auto-fixes, manually fix remaining |
| Type errors | Read type checker output | Add/fix type annotations |
| Push rejected | `git fetch origin`, `git log --oneline origin/main..HEAD` | Rebase on latest main, resolve conflicts, push again |

## Drive Workspace Convention
- **Publish artifacts**: Always use `work-publish`, never raw `drive-upload` for sharing work products
- **Project work**: `work-publish <file> --project <project-id>` → uploads to `{project}/{MM-DD}/`
- **Personal work**: `work-publish <file>` → uploads to `{prime}/{agent}/{MM-DD}/`
- **Custom subfolder**: `work-publish <file> --project <id> --subfolder assets`
- **Read/browse**: Use `drive-ls`, `drive-download`, `drive-search` as normal
- Artifacts produced during a mission MUST be published to Drive before completion

## Project Context Discovery

When you discover a fact about a project during execution that would help future missions, persist it immediately:

| Discovery Type | Command |
|---|---|
| Permission requirement | `project-manage add-context '<project_id>' '<key>' '<what you learned>'` |
| Working command/path | `project-manage add-context '<project_id>' '<key>' '<verified command or path>'` |
| Resource ID (Drive folder, URL) | `project-manage add-context '<project_id>' '<key>' '{"kind":"drive_folder","ref":"<id>","summary":"<description>"}'` |
| Failure mode | `project-manage add-context '<project_id>' '<key>' 'AVOID: <what failed and why>'` |

Examples of useful discoveries:
- `sync_folder_requires_editor` → "Editor access required for all agents uploading to sync folder"
- `deploy_command_verified` → "firebase deploy --project tachin-website --only hosting"
- `staging_url` → "tachin-website--staging-abc123.web.app"
- `css_build_step_required` → "Must run npm run build before deploying; raw source files won't work"

**Rule:** If you learn something that would save the next agent time on this project, write it to project context. Don't rely on mission output alone — context is the project's institutional memory.
