# Skill: Scripting

## When to Use
When a one-liner isn't enough — the task has loops, conditionals, structured data
transforms, or multiple dependent steps. Write a script, run it, verify it.

## Philosophy
Prefer a written, inspectable script over a fragile chain of piped commands when logic
gets complex. Python for anything structured (JSON, CSV, API calls, data manipulation);
bash for process orchestration and file operations.

## Procedures

### Write and run a Python script
1. `writeFile` to `/tmp/<name>.py` with the full script (imports, logic, output).
2. Run: `python3 /tmp/<name>.py`.
3. For dependencies: `pip install <pkg> --break-system-packages --quiet` first (Ubuntu 24
   requires the flag). Prefer stdlib where possible.
4. Print structured results (JSON to stdout) so the outcome is machine-readable.

### Write and run a bash script
1. `writeFile` to `/tmp/<name>.sh` starting with `#!/usr/bin/env bash` and `set -euo pipefail`.
2. Run: `bash /tmp/<name>.sh`.
3. Capture stdout and stderr.

### Idempotency
Scripts should be safely re-runnable. Check-before-create, use `mkdir -p`, guard
destructive steps with existence checks. If a script partially fails, re-running it
should not double-apply.

## Safety
- `set -euo pipefail` in every bash script — fail fast, no silent errors.
- Inspect any script that mutates state before running it.
- Never write secrets into scripts; use command substitution from `secret-read`.
- Long-running scripts: if a script may exceed the 2-min tool timeout, use the `wait`
  capability to background-and-poll, or break it into steps.

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| `ModuleNotFoundError` | Missing pip package | `pip install <pkg> --break-system-packages` |
| Script exits silently | Missing `set -e` or swallowed error | Add `set -euo pipefail`; echo checkpoints |
| `pip install` externally-managed error | Ubuntu 24 PEP 668 | Add `--break-system-packages` |
| Timeout at 2 min | Long-running operation | Background it (`nohup ... &`), poll with `wait`, or decompose |
