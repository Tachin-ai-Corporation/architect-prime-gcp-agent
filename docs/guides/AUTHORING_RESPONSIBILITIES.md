# Authoring Responsibilities

This guide covers how to write Responsibility definitions for the Culture of Work system. Responsibilities define recurring or event-triggered work that agents perform autonomously.

---

## Where a responsibility lives, and who writes it

| You are… | You write… | With |
|----------|-----------|------|
| **The product** (this repo) | platform upkeep every agent runs — `corekit/config/responsibilities.json`, `responsibilities-prime.json` — marked `"locked": true` | a commit + platform release |
| **The product** (this repo) | a role's shipped defaults — `specialties/<role>/responsibilities-<role>.json`, installed on the agent as its job overlay, `responsibilities-job.json` | a commit + platform release |
| **Prime**, for a whole role | the role's defaults in this deployment | `fleet-config change update responsibility` → release → assign |
| **An agent**, for itself | overrides of its defaults, and responsibilities of its own | `responsibility-manage` |
| **Prime**, for one agent | that agent's overrides and own responsibilities | `responsibility-manage --agent <id>` |
| **The operator**, from the dashboard | enable / disable | the introspect command `set_responsibility_enabled` |

The last three write the agent's **store** in Firestore (`primes/{prime}/fleet/{agent}/responsibilities/{id}`). The scheduler re-reads it every minute and merges it over the shipped defaults. A change there is live without a Fleet release or a CoreKit upgrade, and it survives both. See [the Responsibility primitive](../primitives/06-RESPONSIBILITY.md#where-responsibilities-live-and-who-changes-them) for the layering, validation, revisions and limits.

**Product content stays generic.** A responsibility that names one deployment's meetings, folders or people belongs in that deployment: in an agent's store or a Prime release, with its ids in a Project. It never goes in a shipped specialty file (C-28, C-29).

---

## Schema Reference

### Shipped File Structure

```json
{
  "version": 2,
  "responsibilities": [
    { /* responsibility definition */ }
  ]
}
```

In the agent's store, each responsibility is one document. `responsibility-manage` writes and revisions it, so you only ever supply the definition body.

### Responsibility Definition

```json
{
  "id": "r-example",
  "name": "Example Responsibility",
  "schedule": "0 8 * * *",
  "timezone": "America/Chicago",
  "enabled": true,
  "singleton": true,
  "triggerable": false,
  "min_spacing_minutes": 720,
  "instruction": "Do the thing...",
  "success_criteria": "What counts as success",
  "context": {
    "purpose": "Why this responsibility exists",
    "process": [
      "STEP 1 — Do first thing",
      "STEP 2 — Do second thing"
    ],
    "reference_files": ["workspace/MEMORY.md"],
    "prior_learnings": "Lessons from past executions"
  },
  "processRef": null,
  "project_id": null
}
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `id` | `string` | ✓ | Unique identifier, lowercase letters, digits and dashes. Convention: `r-{descriptive-name}` |
| `name` | `string` | ✓ | Human-readable name (shown in dashboard and logs), ≤ 80 chars |
| `schedule` | `string` | one of | Five-field cron, read in `timezone` |
| `event` | `string` | one of | `on_complete` or `on_failure` — fires on that event instead of a clock |
| `timezone` | `string` | ✗ | IANA zone for `schedule` (default `UTC`) |
| `enabled` | `boolean` | ✗ | Whether the scheduler fires it (default `true` when created through `responsibility-manage`) |
| `instruction` | `string` | ✓ | What the agent should do. Injected into the Mission instruction |
| `success_criteria` | `string` | ✓ | What a successful execution looks like. Becomes the Mission's `accept_criteria` |
| `context` | `object` | ✓ for an agent's own | `purpose` and `process` are required when an agent creates one |
| `singleton` | `boolean` | ✗ | Skip firing while a previous firing is still in progress |
| `triggerable` | `boolean` | ✗ | A user may ask the agent to run it out of turn |
| `min_spacing_minutes` | `number` | ✗ | Minimum minutes between firings |
| `effect_scope` | `'world' \| 'memory'` | ✗ | `memory` confines a firing to the agent's memory layers |
| `processRef` | `string \| null` | ✗ | Playbook ID the fired Mission recalls as a planning prior |
| `processParameters` | `object \| null` | ✗ | Optional parameters carried with the reference |
| `project_id` | `string \| null` | ✗ | Project for generated Missions (default: agent's default project) — where its deployment ids live |
| `locked` | `boolean` | platform only | Platform upkeep that no store record may change |

---

## Cron Expressions

Standard 5-field cron syntax, matched in the responsibility's `timezone`:

```
┌───────────── minute (0–59)
│ ┌───────────── hour (0–23, in `timezone`)
│ │ ┌───────────── day of month (1–31)
│ │ │ ┌───────────── month (1–12)
│ │ │ │ ┌───────────── day of week (0–6, 0 = Sunday)
│ │ │ │ │
* * * * *
```

The scheduler reads exactly these forms: `*`, `*/N`, a number, a range `a-b`, and a list `a,b`. Names (`MON`), stepped ranges (`1-5/2`) and `7` for Sunday are refused, because they would parse, never match, and leave a responsibility that silently never fires.

### Common Patterns

| Expression | Meaning |
|-----------|---------|
| `0 8 * * *` | Daily at 8:00 |
| `*/30 * * * *` | Every 30 minutes |
| `0 */6 * * *` | Every 6 hours |
| `0 2 * * 1` | Every Monday at 2:00 |
| `20 10 * * 4` + `America/Chicago` | Every Thursday at 10:20 Central, through DST |
| `0 0 1 * *` | First day of every month at midnight |

> **Note:** The brain daemon evaluates cron expressions every 60 seconds. Precision is ±1 minute.
> A schedule an agent or Prime writes must not fire more often than every
> `responsibility_store.min_interval_minutes` (15).

---

## min_spacing_minutes

Prevents rapid re-firing. Even if the cron expression matches multiple times, the responsibility won't fire again until `min_spacing_minutes` have elapsed since the last firing.

**Examples:**
- `min_spacing_minutes: 720` (12 hours) — At most twice per day
- `min_spacing_minutes: 1440` (24 hours) — At most once per day

**Use cases:**
- Nightly jobs: set to 720–1440 to prevent double-firing across timezone boundaries
- Event-triggered: set to the minimum recovery time between events

A manual run counts toward the spacing, so don't test a weekly job with a 24-hour spacing inside the 24 hours before its slot.

---

## singleton

When `true`, the scheduler checks Firestore for any in-progress mission (status `pending`, `active`, `queued` or `waiting`) whose `source_meta.responsibility_id` matches this responsibility's `id`. If one exists, the firing is skipped and the responsibility sleeps until the next cron tick.

This prevents overlapping executions of long-running responsibilities like improvement cycles.

---

## Context

The `context` object provides rich information to the agent when the responsibility fires.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `purpose` | `string` | Why this responsibility exists. Helps the agent understand the "why" behind the work. |
| `process` | `string[]` | Step-by-step instructions. Each string is one step. Prefixed with `STEP N —`. |
| `reference_files` | `string[]` | Files the agent should read. Paths relative to agent workspace root. |
| `prior_learnings` | `string` | Lessons from previous executions. Helps agents avoid repeating mistakes. |

### Context Injection

When a responsibility fires, the context is injected as a rich text block in the Mission's `context_summary`:

```
PURPOSE: <context.purpose>

PROCESS:
1. <context.process[0]>
2. <context.process[1]>
...

PLAYBOOK — <name> (<processRef>): <narrative>

REFERENCE FILES: <context.reference_files>

SUCCESS CRITERIA: <success_criteria>

PRIOR LEARNINGS: <context.prior_learnings>
```

---

## processRef — Referencing a Playbook

When `processRef` is set, the fired Mission **recalls** the named playbook's narrative as a planning
prior. The scheduler does not run a step hierarchy. The Mission goes through the normal cortex decide
loop, and the agent plans its own checkpoints (C-15), informed by the playbook:

```json
{
  "id": "r-nightly-audit",
  "processRef": "p-audit",
  "processParameters": {
    "scope": "app/src/",
    "criteria": "security"
  }
}
```

`processParameters` is optional context carried with the reference. A narrative playbook has no
parameters of its own, so nothing is substituted into steps (there are no steps).

---

## Event Responsibilities

Set `event` instead of `schedule`:

```json
{
  "id": "r-failure-review",
  "event": "on_failure",
  "min_spacing_minutes": 60,
  "instruction": "Review the blocked mission and record what stopped it",
  "success_criteria": "A short review names the blocking cause and the next step."
}
```

| `event` | Fires When |
|--------------|-----------|
| `on_complete` | A Mission completes |
| `on_failure` | A Mission ends blocked |

A responsibility takes a schedule **or** an event, never both. The old "never-matching cron" trick
(`0 0 31 2 *`) is refused. Event firing never chains: a Mission that an event responsibility produced
never fires another event responsibility, and every event responsibility is spaced by at least the
store's floor.

---

## The R→M Envelope Pair

Every responsibility firing creates two WorkEnvelopes:

1. **R envelope** (type `R`), immediately `complete`. It records the trigger metadata:
   - `source_meta.responsibility_id`
   - `source_meta.responsibility_name`
   - `source_meta.schedule`

2. **M envelope** (type `M`), an active Mission with the actual work:
   - `parent_id` → R envelope ID
   - `project_id` → from `resp.project_id` or default
   - `source_meta.responsibility_origin` / `responsibility_revision`: which definition produced it
   - `source_meta.process_ref` → from `resp.processRef` (if set)

---

## Examples

### Nightly Memory Consolidation (platform upkeep, locked)

```json
{
  "id": "r-memory-consolidation",
  "name": "Nightly Memory Consolidation",
  "schedule": "0 8 * * *",
  "enabled": true,
  "locked": true,
  "effect_scope": "memory",
  "min_spacing_minutes": 720,
  "instruction": "Execute the nightly memory consolidation cycle...",
  "context": {
    "purpose": "MEMORY.md is the agent's working scratchpad...",
    "process": [
      "STEP 1 — GATHER WORKING MEMORY: Read workspace/MEMORY.md",
      "STEP 2 — GATHER SESSIONS: Run session-summary --hours 24"
    ],
    "success_criteria": "MEMORY.md rewritten under 2,000 chars. Core Memory reconciled."
  }
}
```

### An agent's own weekly report

The agent creates it for itself, so it never ships in a specialty file:

```bash
responsibility-manage create --note "asked for in the ops channel" --stdin <<'EOF'
{
  "id": "r-weekly-ops-report",
  "name": "Weekly Ops Report",
  "schedule": "0 9 * * 1",
  "timezone": "America/Chicago",
  "singleton": true,
  "min_spacing_minutes": 1440,
  "instruction": "Summarize last week's operational work into the ops report doc.",
  "success_criteria": "This week's report exists and its sections were read back.",
  "project_id": "ops-reporting",
  "context": {
    "purpose": "Leadership reads one ops summary every Monday.",
    "process": ["Read last week's completed work", "Write the report", "Read it back"]
  }
}
EOF
```

Moving it later is one command: `responsibility-manage update r-weekly-ops-report '{"schedule":"30 9 * * 1"}'`.

---

## Checklist

Before adding a new responsibility:

- [ ] It's written in the right layer. Platform upkeep and generic role defaults go in the repo. A deployment's own duty goes in the agent's store or a Prime release
- [ ] `id` follows the `r-{descriptive-name}` convention
- [ ] `name` is clear and descriptive
- [ ] Exactly one of `schedule` (a five-field cron in the supported forms) or `event`
- [ ] `timezone` is set when the time of day matters
- [ ] `min_spacing_minutes` prevents accidental rapid-firing
- [ ] `instruction` is a clear, complete directive
- [ ] `success_criteria` defines what success looks like
- [ ] `context.purpose` and `context.process` say why and how
- [ ] `processRef` points to an existing playbook ID (if used)
- [ ] `project_id` is set if the work belongs to a specific project, and deployment ids live in that project, not in the text
