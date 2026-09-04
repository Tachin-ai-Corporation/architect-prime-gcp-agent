# Skill: Operator Forensics

## When to Use
Before acting on an unfamiliar or irreversible operational target — deleting data, wiping an agent's memory, editing runtime state — when you don't yet know exactly where the thing lives, what its footprint is, or the safe procedure. The Prime is a resourceful operator (B-26): "there's no script for that" is a reason to investigate, not to refuse. This skill is the *method*; the raw capability comes from `system-shell` / `scripting` / `gcp-admin`, and an irreversible act should go through a guarded tool with a dry run.

## The Method

1. **Locate the AUTHORITY — don't guess.** Where a thing lives is defined by the CODE that writes it, not always by a doc or a "contract" that may be stale. To find a Firestore path, an env var, a config key: read the tool/module that *produces* it. Example: an agent's core-memory path is authoritative in `corekit/memory/core-memory-write`, not in a catalog that once listed a different, empty path. Read the writer before you trust the map.
2. **Probe read-only first.** Confirm the target and its *full* footprint with non-mutating reads (a Firestore query, a `GET`, a file read) BEFORE any change. Count what you would touch; identify siblings you must NOT touch.
3. **Prefer a guarded tool, dry-run first.** If a tool covers the action (e.g. `project-delete`, `fleet-agent-memory-reset`), run it with NO `--apply` to see the exact footprint, present that to the operator, and only then apply. A hand-rolled destructive command with no dry run is the last resort, not the first.
4. **Verify by re-derivation, not assumption (B-28).** After acting, re-query the live state to prove the result — the doc is gone (404), the count is zero — instead of trusting the command's exit code.
5. **Scope tightly.** Change exactly what is in scope and leave the rest: external resources (Drive files, DNS), shared-library items (a process reused elsewhere), and another owner's data are out of scope unless explicitly named. Over-reach is the failure mode of a capable operator.

## Error Recovery
| Situation | Response |
|---|---|
| The doc/contract path returns empty | Don't conclude "nothing there" — the doc may be stale; read the WRITER for the real path (step 1). |
| A tool refuses (a guard tripped) | The guard is protecting you (a structural or dependency invariant). Read the message; never `--force` past it without understanding what it protects. |
| Unsure of the blast radius | Stay read-only / dry-run and widen the probe until the footprint is fully known before any `--apply`. |

## Examples
- "Delete project X entirely." → read how work is scoped (root `work` by `project_id`) → `project-delete X` (dry run) reports "N work + M subcollection docs + the doc" → operator approves → `project-delete X --apply` → re-query proves 0 remaining.
- "Wipe agent Y's memory." → the path is not the catalog's empty `agents/{id}/…` but the writer's `primes/{prime}/fleet/{agent}/core_memory` → `fleet-agent-memory-reset Y` (dry run) → apply → verify the count is 0 and the prime's own memory is untouched.
