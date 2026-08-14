# Skill: Process Playbooks (process-ops)

## When to Use
When you want to **capture**, **read**, **update**, **discuss**, or **retire** a *process playbook* — a
remembered **name + short description + narrative** of how a recurring kind of work is done well. Use it
when:
- a mission went well and the pattern is worth remembering ("this is how we do X");
- the owner asks "what processes do you have?" (list them, narrate any one);
- the owner gives feedback on how something should be done ("for deploys, always …") — fold it into the playbook;
- you want to see how a kind of work has been done before, to inform your own plan.

A process is **not** a step-machine you execute. It is guidance you (or any agent) recall into your **own**
checkpoint plan and adapt. The library is **one global library** shared across every agent and every prime —
a pattern one agent captures, the whole fleet can reuse.

## The tool
`process-ops` reads and writes the one global process library.
- `process-ops list` — every active playbook (id, name, whether it has a narrative, description).
- `process-ops get <id>` — read one playbook's full narrative.
- `process-ops write <id> --name "<name>" --description "<one line>" --narrative "<prose>" [--tags a,b] [--project <id>]`
  — create or update a playbook (additive: it patches the fields you pass and stamps `updated_by`/`updated_at`).
- `process-ops write <id> --name "<name>" --description "<one line>" --stdin` — pass the narrative on **stdin**
  (quote-safe; use this whenever the narrative has apostrophes, quotes, or newlines).
- `process-ops retire <id>` — mark a stale playbook deprecated (soft delete; it stops being recalled).

## How to write a good playbook
- **name** — a short handle (e.g. `Investigation`, `Plan and Build`).
- **description** — one line: what kind of work this is and when it's relevant.
- **narrative** — prose: the shape that works, the order, what to watch for, what NOT to do. **No tool
  syntax** (that lives in skills), **no rigid step list** — the reader adapts it to their own checkpoints.
- Keep it lean and honest: capture what actually worked, refine rather than pile on, and retire what's stale.

## Procedures
### Capture a pattern that worked
After work that went well: `process-ops write <id> --name ".." --description ".." --stdin` with the narrative piped in.

### Discuss what the fleet has
`process-ops list`, then `process-ops get <id>` to read any one for the owner.

### Take feedback / update
When the owner says how something should be done: `process-ops get <id>` the relevant playbook, fold the
feedback into a tighter narrative, and `process-ops write <id> --stdin` it back.

## Error Recovery
| Symptom | Cause | Recovery |
|---|---|---|
| `write failed` | Bad token or malformed field | Retry; ensure `--narrative`/`--stdin` is non-empty and the id is lowercase-kebab. |
| Narrative came out mangled (stray `\'`) | A quote-heavy narrative was passed as a shell arg | Use `--stdin` and pipe the narrative in — it is never shell-parsed. |
| `list` shows `[NO narrative]` for an entry | An un-migrated legacy process | `process-ops write` a narrative for it — that is the migration. |

## Safety
- The library is **global** — a write is seen by every agent on every prime. Refine, dedupe, and don't
  clobber; retire a stale playbook rather than leaving it to mislead.
- A playbook carries **no secrets** and **no tool syntax** — it is a narrative of how work is done well.
