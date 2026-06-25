# Engineer Specialty — Cerebellum Verification Rules

## Code Quality Gates (ALL MUST PASS)

Before approving any code mission as complete, verify ALL of the following.
If motor output does not contain evidence for each gate, the mission is NOT complete.

### Gate 1: Tests Pass
- Motor output MUST show test suite execution with a passing result.
- Look for: `passed`, `ok`, `✓`, or equivalent pass indicators.
- Zero test failures. Skipped tests are acceptable ONLY if they were skipped before the mission.
- If no test output exists in motor logs, REJECT — tests were not run.

### Gate 2: Lint Clean
- Motor output MUST show linter execution with zero errors.
- Warnings are acceptable; errors are NOT.
- If the project has a linter configured and motor did not run it, REJECT.

### Gate 3: Types Check (if applicable)
- If the project uses TypeScript, mypy, or another type checker, motor MUST have run it.
- Zero type errors required.
- If the project does not use a type checker, this gate is automatically passed.

### Gate 4: No Debug Artifacts
- The diff MUST NOT contain: `console.log`, `print()` debugging, `debugger` statements,
  `TODO` or `FIXME` comments added by the agent, or commented-out code blocks.
- If motor's `git diff` output contains any of these, REJECT.

### Gate 5: Clean Diff
- Motor MUST have run `git diff --staged` or `git diff` at some point.
- The diff should contain ONLY changes relevant to the mission objective.
- No unrelated whitespace changes, no reformatting of untouched files.
- If the diff touches files not mentioned in the mission objective, require justification.

## Branch Verification

### Branch Status
- The branch MUST NOT be `main` or `master`. Feature branch only.
- The branch MUST be pushed to the remote: look for `git push` output in motor logs.
- The branch MUST be ahead of `main` (has commits not in main).

### No Merge Conflicts
- If motor performed a rebase, verify it completed successfully (no conflict markers).
- Search motor output for `CONFLICT`, `merge conflict`, or `<<<<<<` — if found and
  not resolved, REJECT.

## Evidence Requirements

For each verification gate, you need CONCRETE EVIDENCE from motor output:

| Gate | Required Evidence |
|------|-------------------|
| Tests pass | Test runner output showing pass count and zero failures |
| Lint clean | Linter output showing zero errors |
| Types check | Type checker output showing zero errors (or N/A) |
| No debug artifacts | `git diff` output reviewed, no debug statements found |
| Clean diff | `git diff` output showing only mission-relevant changes |
| Feature branch | `git branch` or `git push` output showing non-main branch |
| No conflicts | Absence of conflict markers in motor output |

## Code Review Criteria

When reviewing code changes (not just verifying gates), also assess:

- **Correctness**: Does the code do what the mission requires?
- **Edge cases**: Are error conditions and boundary cases handled?
- **Naming**: Are variables, functions, and files named clearly?
- **Duplication**: Is there unnecessary code duplication?
- **Security**: No hardcoded secrets, no SQL injection, no XSS vectors.

If any of these have significant issues, flag them in the verification report
even if all gates pass.

## Verification Report Format

Structure your verification output as:

```
## Verification Summary
- Tests: ✅ PASS (X passed, 0 failed)
- Lint: ✅ PASS (0 errors)
- Types: ✅ PASS | ⬜ N/A
- Diff: ✅ CLEAN (N files changed)
- Branch: ✅ feat/<name> pushed
- Conflicts: ✅ NONE

## Notes
<any concerns, suggestions, or observations>
```

### Drive Convention Gate
- ✅ PASS if agent used `work-publish` for artifact uploads
- ⚠️ WARN if agent used raw `drive-upload` — suggest `work-publish` next time
- ✅ PASS if no artifacts were produced (read-only mission)
