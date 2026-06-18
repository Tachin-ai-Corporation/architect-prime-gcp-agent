# Skill: Code Review Operations

## When to Use
When reviewing code changes — including analyzing pull requests, checking test coverage, detecting code smells, scanning for hardcoded secrets, and generating code review checklists.

## Commands

No custom corekit scripts are governed by this skill.

## Procedures

### Perform a complete pull request review
1. Check the changed files and statistics:
   ```bash
   git diff origin/main...HEAD --stat
   ```
2. Scan the changed files for hardcoded secrets and debug leftovers:
   ```bash
   # Scan for hardcoded keys or passwords
   grep -rn "api[_-]key\|api[_-]secret\|password" --include="*.ts" --include="*.py" .
   # Scan for console.log or print statements
   grep -rn "console\.log\|print(" --include="*.ts" --include="*.py" .
   ```
3. Run test coverage checks (e.g. `npx jest --coverage` or `python -m pytest --cov`).
4. Generate the structured review checklist (detailing Passes, Warnings, Blockers, and Metrics).
5. Verify: Ensure the final checklist is outputted with specific file paths and line numbers for warnings or blockers.

### Scan codebase for security concerns
1. Scan for private keys and AWS-style keys:
   ```bash
   grep -rn "BEGIN.*PRIVATE KEY" .
   grep -rn "AKIA[0-9A-Z]\{16\}" .
   ```
2. Check for committed `.env` files:
   ```bash
   git ls-files | grep -i "\.env"
   ```
3. Run dependency audits (e.g. `npm audit` or `pip audit`).
4. Verify: Report any found secrets or vulnerable dependencies as blockers.

---

## Code Review Reference

### Diff Analysis

| What | Command |
|------|---------|
| Diff vs main | `git diff origin/main...HEAD` |
| Diff stat summary | `git diff origin/main...HEAD --stat` |
| Diff specific file | `git diff origin/main...HEAD -- FILE_PATH` |
| Changed files list | `git diff origin/main...HEAD --name-only` |
| Changed files with status | `git diff origin/main...HEAD --name-status` |
| Diff ignore whitespace | `git diff origin/main...HEAD -w` |
| Show additions only | `git diff origin/main...HEAD --diff-filter=A --name-only` |

### Code Smell Detection Patterns
```bash
# TODO/FIXME/HACK left in code
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.py" --include="*.go" .

# Empty catch blocks
grep -rn "catch.*{" -A1 --include="*.ts" --include="*.js" . | grep -B1 "^.*}$"
```

### Review Checklist Format
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
