# Skill: Code Review Operations

Use these procedures when performing code review tasks via `exec`.

## Diff Analysis

| What | Command |
|------|---------|
| Diff vs main | `git diff origin/main...HEAD` |
| Diff stat summary | `git diff origin/main...HEAD --stat` |
| Diff specific file | `git diff origin/main...HEAD -- FILE_PATH` |
| Changed files list | `git diff origin/main...HEAD --name-only` |
| Changed files with status | `git diff origin/main...HEAD --name-status` |
| Diff ignore whitespace | `git diff origin/main...HEAD -w` |
| Show additions only | `git diff origin/main...HEAD --diff-filter=A --name-only` |

### Diff Triage
1. Run `--stat` first to understand scope
2. Prioritize review of files with most changes
3. Check new files (`--diff-filter=A`) for missing tests
4. Check deleted files (`--diff-filter=D`) for orphaned references

## Code Smell Detection

### Grep Patterns for Common Smells
```bash
# TODO/FIXME/HACK left in code
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.py" --include="*.go" .

# Console.log / print statements (debug leftovers)
grep -rn "console\.log\|console\.debug\|print(" --include="*.ts" --include="*.py" .

# Magic numbers (numeric literals outside of constants)
grep -rn "[^a-zA-Z_0-9]\([0-9]\{3,\}\)" --include="*.ts" --include="*.py" .

# Empty catch blocks
grep -rn "catch.*{" -A1 --include="*.ts" --include="*.js" . | grep -B1 "^.*}$"

# Long functions (files with dense logic)
wc -l $(git diff origin/main...HEAD --name-only --diff-filter=AM) | sort -rn | head -20

# Duplicate code indicators — repeated string literals
grep -roh '"[^"]\{20,\}"' --include="*.ts" --include="*.py" . | sort | uniq -c | sort -rn | head -10
```

## Test Coverage Checks

### JavaScript/TypeScript
```bash
# Run coverage
npx jest --coverage --coverageReporters=text 2>&1

# Coverage for changed files only
npx jest --coverage --changedSince=origin/main --coverageReporters=text 2>&1

# Check coverage threshold
npx jest --coverage --coverageThreshold='{"global":{"branches":80,"functions":80,"lines":80}}' 2>&1
```

### Python
```bash
# Run coverage
python -m pytest --cov=. --cov-report=term-missing 2>&1

# Coverage for specific module
python -m pytest --cov=MODULE_NAME --cov-report=term-missing 2>&1
```

### Go
```bash
# Run coverage
go test -cover ./... 2>&1

# Detailed coverage report
go test -coverprofile=coverage.out ./... && go tool cover -func=coverage.out
```

## Security Scanning

### Secrets Detection
```bash
# Hardcoded API keys / tokens
grep -rn "api[_-]key\|api[_-]secret\|apikey\|apiSecret" --include="*.ts" --include="*.py" --include="*.go" --include="*.json" -i .

# AWS-style keys
grep -rn "AKIA[0-9A-Z]\{16\}" .

# Generic secrets
grep -rn "password\s*=\s*['\"]" --include="*.ts" --include="*.py" --include="*.go" -i .

# Private keys
grep -rn "BEGIN.*PRIVATE KEY" .

# Hardcoded IPs
grep -rn "[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}" --include="*.ts" --include="*.py" --include="*.go" . | grep -v "0\.0\.0\.0\|127\.0\.0\.1\|localhost"

# .env files committed
git ls-files | grep -i "\.env"
```

### Dependency Audit
```bash
# Node
npm audit 2>&1

# Python
pip audit 2>&1 || safety check 2>&1

# Go
go list -m -json all | grep -i "Vulns" 2>&1
```

## Review Checklist Format

Use this format to structure review output:

```markdown
## Code Review Summary

**Branch:** BRANCH_NAME
**Files changed:** N files (+ADDITIONS / -DELETIONS)

### ✅ Passes
- [ ] No secrets or hardcoded credentials
- [ ] No TODO/FIXME introduced
- [ ] Test coverage adequate
- [ ] No console.log/print debug statements

### ⚠️ Warnings
- FILE:LINE — Description of concern

### ❌ Blockers
- FILE:LINE — Description of blocking issue

### 📊 Metrics
- Coverage: XX%
- Files changed: N
- Lines added: +N
- Lines removed: -N
```

## Safety Rules
- Never modify code during review — review is read-only
- Always diff against the merge target (usually `origin/main`)
- Report findings with exact file paths and line numbers
- Distinguish blockers (must fix) from warnings (should fix)
- Use `--format=json` for machine-readable output when chaining commands
