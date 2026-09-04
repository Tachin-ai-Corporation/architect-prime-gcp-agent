# Skill: Fleet Agent Memory Reset

## When to Use
When an operator asks to give a fleet agent a fresh memory — wipe its accumulated core memory and reset its working memory — so it stops being confused by stale testing/iteration facts. This resets an agent **managed by this prime**; it can never touch the prime's own memory (the core-memory path is a fleet subcollection, structurally distinct from the prime's).

## Commands

### Write
- `fleet-agent-memory-reset <agent> [--apply] [--core-only] [--memory-md-only]` — wipe a fleet agent's memory. Default is a **DRY RUN** (reports what would be wiped, changes nothing); pass `--apply` to actually wipe. `--core-only` wipes only the Firestore core memory; `--memory-md-only` resets only the working MEMORY.md.
  Output: the core-memory entry count and the MEMORY.md target, then (with `--apply`) the deleted count and a clean-slate confirmation.

## Procedures

### Reset a fleet agent's memory (safe, gated)
1. **Dry run first** — run `fleet-agent-memory-reset <agent>` with no `--apply`. Report to the operator exactly what would be wiped (N core-memory entries + the MEMORY.md reset).
2. **Confirm** — this is destructive and irreversible; obtain explicit operator approval before applying.
3. **Apply** — `fleet-agent-memory-reset <agent> --apply`. Deletes every core-memory entry under `primes/{prime}/fleet/{agent}/core_memory` and resets the agent VM's working MEMORY.md to the empty template.
4. **Report** — relay the deleted count and confirm the clean slate. No agent restart is needed: working memory is re-read each turn and core memory is re-queried per recall.

## Error Recovery
| Error | Cause | Recovery |
|---|---|---|
| `Refusing: '<x>' is the prime itself` | Tried to reset the prime | This tool only resets FLEET agents; the prime's own memory is off-limits by design. |
| `Refusing: '<x>' is not a fleet agent under prime` | Wrong name, or the agent belongs to another prime | Use `fleet-status` to list this prime's agents; you can only reset your own. |
| `could not reset MEMORY.md … VM unreachable` | Agent VM down or SSH denied | Core memory was still wiped; bring the VM up and re-run with `--memory-md-only --apply`. |

## Examples
- Operator: "Give millie a fresh memory wipe." → `fleet-agent-memory-reset millie` (dry run) → report "15 core-memory entries + MEMORY.md reset" → on approval → `fleet-agent-memory-reset millie --apply` → "deleted 15/15, MEMORY.md reset — clean slate."
