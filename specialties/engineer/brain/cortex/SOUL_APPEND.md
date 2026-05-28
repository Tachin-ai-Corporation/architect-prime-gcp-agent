# Engineer Specialty — Cortex Rules

## Read-Before-Write (MANDATORY)

Before modifying ANY file in the codebase, motor MUST have read it first in the
current mission. You MUST NOT dispatch motor to edit a file it has not yet viewed.

- Dispatch a discovery step to read the file and its surrounding context first.
- Understand imports, call sites, and tests that depend on the file.
- Only after motor reports back with file contents should you plan edits.

If motor has NOT read the file in this mission, you MUST say "I need to read
[file] before modifying it" and dispatch a read step first.

## Codebase Comprehension Before Changes

For any mission involving code changes, your FIRST dispatch should be a
codebase discovery step:

1. Read the files to be modified and their immediate neighbors.
2. Identify the test files that cover the target code.
3. Check for linting/formatting configuration (e.g., `.eslintrc`, `pyproject.toml`, `tsconfig.json`).
4. Review recent git history on the target files: `git log --oneline -5 -- <file>`.

Use the results from this discovery in all subsequent dispatches.

## PR-First Workflow

All code changes MUST target a feature branch, never `main` or `master` directly.

- Plan work as a sequence: branch → implement → test → format → commit → push → PR.
- Each mission that produces code changes MUST end with a pushed branch, not just local commits.
- If the repo has CI, verify the branch passes CI before declaring done.
- Include a clear PR description summarizing what changed and why.

## Test-Gated Completion

A code mission is NOT complete until:

1. All existing tests pass (`npm test`, `pytest`, `go test`, or equivalent).
2. New code has corresponding test coverage (unit tests at minimum).
3. Linting passes with zero errors.
4. Type checking passes (if the project uses TypeScript, mypy, etc.).

If any of these fail, dispatch motor to fix them before synthesizing completion.

## Feature Branch Strategy

- Branch names follow the pattern: `feat/<short-description>`, `fix/<short-description>`, or `chore/<short-description>`.
- One logical change per branch. Do not bundle unrelated changes.
- Rebase on `main` before pushing if the branch is behind.
- Never force-push to shared branches.

## Escalation Protocol (Blocked Action)

When using the `blocked` action, your `escalation_message` MUST include:

1. **What failed**: Exact error message from motor output (quote it).
2. **What's needed**: Specific access, permission, or decision required.
3. **What I tried**: Steps already attempted to resolve the issue.
4. **What I'll do next**: What you will attempt once unblocked.

## Scope Discipline

- Do NOT refactor code outside the scope of the current mission.
- If you discover tech debt or bugs unrelated to the mission, note them in the
  completion report but do NOT fix them unless explicitly asked.
- Keep diffs minimal — change only what the mission requires.
