# Authoring Processes

This guide covers how an agent authors and evolves a **process playbook** — a named narrative of how a
recurring kind of work is done well. A playbook is not a step-machine you execute; it is guidance you
(or any agent) recall into your **own** checkpoint plan and adapt. See
[05-PROCESS.md](../primitives/05-PROCESS.md) for the primitive definition and
[MODULE_CHARTER.md](../MODULE_CHARTER.md) for where it sits among the content layers.

Playbooks are authored through the base **`process-ops`** skill, which reads and writes the one global
process library. Every agent carries it — capture, recall, update, discuss, and retire are a base
capability for every role, not gated to a PM or architect.

---

## The shape you are authoring

A playbook is exactly **name + short description + narrative**, plus recall cues and status:

```json
{
  "id": "p-investigate",
  "name": "Investigation",
  "description": "How we diagnose an issue or answer a question — read-only, evidence-first.",
  "narrative": "An investigation examines; it never fixes. Frame the precise question and scope first, then gather the real evidence — logs, code paths, config, live state — without touching anything. Weigh it against your hypotheses, separating what you verified from what you are still guessing. Close with findings, the root cause if you have it, and a recommendation. Keep the read-only line: diagnosing is not deploying.",
  "intent_keywords": ["not working", "broken", "diagnose", "debug", "why", "investigate"],
  "status": "active",
  "version": 4
}
```

| Field | Required | What to write |
|-------|:---:|-------------|
| `id` | ✓ | lowercase-kebab handle (e.g. `p-investigate`); stable across versions |
| `name` | ✓ | short human handle (`Investigation`, `Plan and Build`) |
| `description` | ✓ | one line — what kind of work this is and when it's relevant (this is the registry line the cortex sees) |
| `narrative` | ✓ | the prose pattern (see below) — **no tool syntax, no rigid step list** |
| `intent_keywords` | ✓ | cue terms that should surface this playbook when a mission resembles the pattern |
| `status` | ✓ | `active` (recalled) or `deprecated` (retired — soft delete, no longer recalled) |
| `version` | ✓ | bump on every refinement |

There are no `steps`, `parameters`, `contextTemplate`, per-step `agent`, `checkpointBoundary`, or
`approval_gate` fields. Those belonged to the old step-machine and are gone.

---

## The `process-ops` tool

`process-ops` operates on the one global library (a write is visible to every agent on every prime):

- `process-ops list` — every active playbook (id, name, whether it has a narrative, description).
- `process-ops get <id>` — read one playbook's full narrative.
- `process-ops write <id> --name "<name>" --description "<one line>" --narrative "<prose>" [--tags a,b] [--project <id>]`
  — create or update a playbook. Additive: it patches the fields you pass and stamps
  `updated_by`/`updated_at`.
- `process-ops write <id> --name "<name>" --description "<one line>" --stdin` — pass the narrative on
  **stdin** (quote-safe; use this whenever the narrative has apostrophes, quotes, or newlines).
- `process-ops retire <id>` — mark a stale playbook `deprecated` (soft delete; it stops being recalled).

The skill is the HOW (see `skills/process-ops/SKILL.md` for the full command reference and error
recovery); the narratives are the content.

---

## What makes a good narrative

A narrative captures **pattern + disposition** — the shape that works and the stance to hold while
doing it. Write it the way a seasoned teammate would tell you "here's how this usually goes well."

- **Pattern.** The shape and order that has worked: what to do first, what to gather, how to close.
  Prose, not a numbered list the reader must obey — the reader adapts it to their own checkpoints.
- **Disposition.** The judgment that keeps the work honest: what to watch for, what *not* to do, the
  line that must not be crossed ("keep the read-only line: diagnosing is not deploying").
- **No tool syntax.** Commands, flags, and API shapes live in **skills**. If the pattern needs a tool,
  name the kind of work ("gather the logs"), not the command.
- **No rigid steps, no gates.** Do not encode agent-per-step, checkpoint boundaries, or approval gates.
  Those are the agent's own to plan when it recalls the narrative.
- **Lean and honest.** Capture what actually worked; refine rather than pile on. A narrative that tries
  to cover every case guides nothing.

**Good:** *"An investigation examines; it never fixes. Frame the precise question and scope first, then
gather the real evidence… separating what you verified from what you are still guessing."*

**Bad (tool syntax leaked in):** *"Run `grep -r ERROR /var/log` then `curl -sf …` the health
endpoint."* → that HOW belongs in a skill.

**Bad (rigid step-machine):** *"Step 1 (motor): … Step 2 (cerebellum, checkpointBoundary): … Step 3
(approval_gate): …"* → those structural decisions are the agent's plan, not the playbook.

### Writing good `intent_keywords`

These are the cues that surface a playbook when a mission resembles its pattern. Use the words a person
would actually use to describe the situation ("broken", "not working", "diagnose", "404"), not internal
jargon. A handful of high-signal terms beats an exhaustive list.

---

## When to capture, update, and retire

- **Capture** after work that went well and the pattern is worth remembering — "this is how we do X."
  You do not have to wait to be asked: the post-mission reflex and the nightly consolidation also
  capture patterns automatically, and the user can say "remember how we did this."
- **Update** when a later run improves the pattern, or the user gives feedback on how something should
  be done ("for deploys, always …"). `get` the playbook, fold the feedback into a tighter narrative,
  `write` it back, and confirm. Bump the `version`.
- **Discuss** whenever asked what playbooks exist — `list`, then `get` any one to narrate it.
- **Retire** a playbook that has gone stale or been superseded rather than leaving it to mislead. Prefer
  refining an existing playbook over spawning a near-duplicate; the library stays valuable only if it
  stays lean.

---

## Procedures

### Capture a pattern that worked
After a clean success: `process-ops write <id> --name ".." --description ".." --stdin`, piping the
narrative in. Choose a stable lowercase-kebab `id` and high-signal `intent_keywords`.

### Discuss what the fleet has
`process-ops list`, then `process-ops get <id>` to read any one for the user.

### Take feedback / update
`process-ops get <id>` the relevant playbook, fold the feedback into a tighter narrative, and
`process-ops write <id> --stdin` it back.

---

## Guardrails

- **The library is global.** A write is seen by every agent on every prime. Refine, dedupe, and don't
  clobber; retire rather than leave a stale playbook to mislead.
- **Additive and honest.** Edits refine and keep version history; never fabricate a pattern that did not
  actually work (B-29).
- **No secrets, no tool syntax.** A playbook is a narrative of how work is done well — nothing that
  belongs in a skill, a project resource, or a secret store.

---

## Checklist

Before writing a playbook:

- [ ] `id` is a stable lowercase-kebab handle
- [ ] `description` is one line, clear enough for the cortex to know when the playbook is relevant
- [ ] `narrative` is prose — pattern + disposition, **no tool syntax, no rigid step list, no gates**
- [ ] `intent_keywords` are the words a person would use for this situation
- [ ] you are refining an existing playbook rather than creating a near-duplicate
- [ ] the narrative captures what *actually* worked (honest, not aspirational)
- [ ] `version` is bumped from the previous value
- [ ] a quote-heavy or multi-line narrative is passed via `--stdin`, not a shell arg
