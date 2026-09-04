# Skill: Project Delete

## When to Use
When an operator asks to delete a project **entirely** — not archive it, but remove the project record along with everything scoped to it (its work envelopes, plans, approvals, and subcollections). `project-manage archive` only sets `status`; this removes the data. Prime-only, gated behind a dry run.

## Commands

### Write
- `project-delete <project-id> [--apply] [--force]` — delete a project and its full footprint. Default is a **DRY RUN** (reports the exact footprint, changes nothing); pass `--apply` to delete. `--force` overrides the guard that refuses a project other projects depend on.
  Output: the target's name/creator, the footprint counts (work / plans / approvals / each subcollection / the doc), then (with `--apply`) the deleted counts and a verification that the doc is gone (404) and no scoped work remains.

## Procedures

### Delete a project (safe, gated)
1. **Dry run first** — run `project-delete <id>` with no `--apply`. Report the full footprint (how many work envelopes, plans, approvals, and subcollection docs) to the operator.
2. **Confirm** — this is destructive and irreversible; obtain explicit operator approval before applying. Note what is deliberately left untouched: external Google Drive folders/docs the project referenced, and shared library processes are NOT deleted.
3. **Apply** — `project-delete <id> --apply`. Cascades the deletion, then verifies the project doc is gone and zero scoped work remains.
4. **Report** — relay the deleted total and the verification result.

## Error Recovery
| Error | Cause | Recovery |
|---|---|---|
| `Refusing to delete the structural project` | Target is `general` or `architect-prime` | These are load-bearing and cannot be deleted. |
| `N project(s) depend on '<id>' — refusing` | Another project's `depends_on` references the target | Remove the dependency first, or re-run with `--force` if you intend to orphan it. |
| `projects/<id> not found` | Wrong id, or already deleted | Verify the id with `project-manage list`. |

## Examples
- Operator: "Delete the legal-processes project entirely." → `project-delete legal-processes` (dry run) → report "587 work + 5 promotions + the doc = 593 records" → on approval → `project-delete legal-processes --apply` → "deleted 593; project gone (404), 0 work remaining."
