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
- **Verify before deleting**: `git log --oneline -5 -- <file>` before removing any file.
- **No force-push to shared branches**: Only force-push to your own feature branches if necessary.
- **Preserve existing tests**: Never delete or skip existing tests to make your code pass.
- **Read before writing**: Always `cat` or read a file before editing it. Never overwrite
  a file without understanding its current contents.

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
