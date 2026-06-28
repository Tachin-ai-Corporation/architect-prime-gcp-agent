---
name: LOCAL Improvement Landing
description: >
  How to land a LOCAL-level (operator-specific) improvement: persist to Firestore
  or commit confined to the operator/ overlay, and never open an upstream PR.
---

# LOCAL Improvement Landing

> **Tier:** LOCAL (operator-specific, stays in this deployment)
> **Agent part:** motor
> **Purpose:** The canonical procedure for landing an operator-specific improvement via Firestore writes or the `operator/` overlay tree. Every `[LOCAL]` improvement process delegates its landing step here.

## When to use

Use this skill when the improvement process you are executing has `"tier": "local"`. The change contains operator-specific values (project context, memory content, operator processes, deployment-specific configuration) and must never flow upstream.

## Procedure

### Step 1 — Determine the sub-form

Classify the change into one of two sub-forms:

| Sub-form | What it covers | Landing mechanism |
|---|---|---|
| **Data** | Firestore documents: project context (`projects/`), core memory (`core_memory/`), runtime process definitions, deployment config | Firestore tools (`project-manage`, `process-manage`, `core-memory-write`) |
| **Overlay file** | Files in the `operator/` directory tree: operator processes, sites, design docs, responsibilities | Git commit confined to `operator/` only |

### Step 2a — Data landing (Firestore)

For Firestore-based changes:

1. Use the appropriate tool:
   - Project context → `project-manage` (`add-context`, `update`, etc.)
   - Core memory → `core-memory-write` or `core-memory-retire`
   - Process definitions → `process-manage` (`create`, `update`)
2. Record the exact Firestore document path that was written (e.g. `projects/architect-prime`, `primes/chuck/core_memory/fact-123`)
3. Verify the write by reading back the document

### Step 2b — Overlay file landing

For file-based changes confined to `operator/`:

1. Edit or create files **only** under the `operator/` tree
2. Verify: confirm that `git diff --name-only` shows ONLY paths starting with `operator/`
3. If any non-`operator/` file appears in the diff, **STOP** — you have accidentally touched a platform path. Revert it.
4. Commit with message: `local(<domain>): <what changed>`
5. Do **NOT** push to a branch. Do **NOT** open a PR to `main`.

### Step 3 — Verify no upstream leak

After landing, confirm:

- [ ] No PR was opened
- [ ] No platform file (outside `operator/`) was modified
- [ ] If Firestore: the document path is in the operator's data space (not a platform config collection)
- [ ] If overlay file: `git diff --name-only HEAD~1` shows only `operator/` paths

### Step 4 — Report

Report back to the calling process with:
- The sub-form used (data or overlay)
- The Firestore document path(s) or the file path(s) changed
- Confirmation that no platform path was touched
- Confirmation that no PR was opened

## Error Recovery

| Error | Recovery |
|---|---|
| Accidentally edited a platform file (outside `operator/`) | `git checkout HEAD -- <platform-file>` to revert. Redo the change under `operator/` or via Firestore. |
| Accidentally opened a PR | Close the PR immediately. The change is LOCAL and must not go upstream. |
| Accidentally pushed a branch with platform changes | Force-delete the remote branch. Revert local changes on platform files. |
| Change contains a generic pattern that could benefit all forks | Flag it for the matching REPO improvement process — do NOT upstream the operator values. Extract the generic skeleton as a separate REPO change. |
| Firestore write failed | Retry with the same tool. If auth error, verify the agent has write access to the collection. |

## Worked Example

**Scenario:** Curating a stale project-context fact in the `architect-prime` project record.

1. **Determine sub-form:** This is a Firestore project context update → **Data** sub-form.
2. **Land via Firestore:**
   - Tool: `project-manage update --id architect-prime`
   - Change: removed a stale `context.documentation` entry pointing to a deleted doc, added a new entry for `docs/guides/SKILL_STANDARD.md`
   - Document path: `projects/architect-prime`
3. **Verify:** Read back `project-manage get architect-prime` — documentation array now correct. No files modified, no PR opened.
4. **Report:** Sub-form: data. Path: `projects/architect-prime`. No platform files touched. No PR opened.
