# Authoring Responsibilities

This guide covers how to write Responsibility definitions for the Culture of Work system. Responsibilities define recurring or event-triggered work that agents perform autonomously.

---

## File Location

- **Fleet config:** `corekit/config/responsibilities.json`
- **Prime-only config:** `corekit/config/responsibilities-prime.json`

Both files share the same schema. Prime-only responsibilities are loaded only on Prime VMs.

---

## Schema Reference

### Config File Structure

```json
{
  "version": 1,
  "responsibilities": [
    { /* responsibility definition */ },
    { /* responsibility definition */ }
  ]
}
```

### Responsibility Definition

```json
{
  "id": "r-example",
  "name": "Example Responsibility",
  "schedule": "0 8 * * *",
  "enabled": true,
  "min_spacing_minutes": 720,
  "instruction": "Do the thing...",
  "context": {
    "purpose": "Why this responsibility exists",
    "process": [
      "STEP 1 — Do first thing",
      "STEP 2 — Do second thing"
    ],
    "reference_files": ["workspace/MEMORY.md"],
    "success_criteria": "What counts as success",
    "prior_learnings": "Lessons from past executions"
  },
  "processRef": null,
  "processParameters": null,
  "project_id": null,
  "trigger": null
}
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `id` | `string` | ✓ | Unique identifier. Convention: `r-{descriptive-name}` |
| `name` | `string` | ✓ | Human-readable name (shown in dashboard and logs) |
| `schedule` | `string` | ✓ | 5-field cron expression |
| `enabled` | `boolean` | ✓ | Whether the scheduler fires this responsibility |
| `min_spacing_minutes` | `number` | ✓ | Minimum minutes between firings |
| `instruction` | `string` | ✓ | What the agent should do. Injected into the Mission instruction. |
| `context` | `object` | ✗ | Rich context (see below) |
| `processRef` | `string \| null` | ✗ | Playbook ID the fired Mission recalls as a planning prior |
| `processParameters` | `object \| null` | ✗ | Optional parameters carried with the reference |
| `project_id` | `string \| null` | ✗ | Project for generated Missions (default: agent's default project) |
| `trigger` | `string \| null` | ✗ | Event trigger type (see below) |
| `singleton` | `boolean` | ✗ | If true, skip firing when a non-terminal mission exists for this responsibility |

---

## Cron Expressions

Standard 5-field cron syntax:

```
┌───────────── minute (0–59)
│ ┌───────────── hour (0–23, UTC)
│ │ ┌───────────── day of month (1–31)
│ │ │ ┌───────────── month (1–12)
│ │ │ │ ┌───────────── day of week (0–7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

### Common Patterns

| Expression | Meaning |
|-----------|---------|
| `0 8 * * *` | Daily at 8:00 UTC |
| `*/30 * * * *` | Every 30 minutes |
| `0 */6 * * *` | Every 6 hours |
| `0 2 * * 1` | Every Monday at 2:00 UTC |
| `0 0 1 * *` | First day of every month at midnight |
| `0 0 31 2 *` | Never fires (Feb 31st — for event-only triggers) |

> **Note:** The brain daemon evaluates cron expressions every 60 seconds. Precision is ±1 minute.

---

## min_spacing_minutes

Prevents rapid re-firing. Even if the cron expression matches multiple times, the responsibility won't fire again until `min_spacing_minutes` have elapsed since the last firing.

**Examples:**
- `min_spacing_minutes: 720` (12 hours) — At most twice per day
- `min_spacing_minutes: 1440` (24 hours) — At most once per day
- `min_spacing_minutes: 15` — At most every 15 minutes

**Use cases:**
- Nightly jobs: set to 720–1440 to prevent double-firing across timezone boundaries
- Monitoring jobs: set to 5–60 for frequent checks
- Event-triggered: set to the minimum recovery time between events

---

## singleton

When `true`, the scheduler checks Firestore for any non-terminal mission (status `pending`, `active`, or `waiting`) with `source_meta.responsibility_id` matching this responsibility's `id`. If one exists, the firing is skipped and the responsibility sleeps until the next cron tick.

This prevents overlapping executions of long-running responsibilities like improvement cycles.

**Example:**
```json
{
  "id": "r-repo-improvement",
  "schedule": "0 * * * *",
  "singleton": true
}
```

With `singleton: true` and an hourly schedule, the responsibility fires at most once per hour, but only if the previous cycle has completed.

---

## Context

The `context` object provides rich information to the agent when the responsibility fires. Each field is optional but recommended for complex responsibilities.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `purpose` | `string` | Why this responsibility exists. Helps the agent understand the "why" behind the work. |
| `process` | `string[]` | Step-by-step instructions. Each string is one step. Prefixed with `STEP N —`. |
| `reference_files` | `string[]` | Files the agent should read. Paths relative to agent workspace root. |
| `success_criteria` | `string` | What a successful execution looks like. Becomes the Mission's `accept_criteria`. |
| `prior_learnings` | `string` | Lessons from previous executions. Helps agents avoid repeating mistakes. |

### Context Injection

When a responsibility fires, the context is injected as a rich text block in the Mission's `context_summary`:

```
PURPOSE: <context.purpose>

PROCESS:
1. <context.process[0]>
2. <context.process[1]>
...

REFERENCE FILES: <context.reference_files>

SUCCESS CRITERIA: <context.success_criteria>

PRIOR LEARNINGS: <context.prior_learnings>
```

---

## processRef — Referencing a Playbook

When `processRef` is set, the fired Mission **recalls** the named playbook's narrative as a planning
prior. The scheduler does not run a step hierarchy — the Mission goes through the normal cortex decide
loop and the agent plans its own checkpoints (C-15), informed by the playbook:

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

`processParameters` is optional context carried with the reference; a narrative playbook has no
parameters of its own, so nothing is substituted into steps (there are no steps).

### What the reference buys you

- **Consistency**: the fired Mission is shaped by a proven pattern the fleet has captured
- **Adaptable**: the agent recalls the narrative and plans its own checkpoints — never locked to a fixed sequence
- **Traceable**: the Mission records the recalled playbook in `process_id`

---

## Event Triggers

The `trigger` field enables event-driven responsibilities:

```json
{
  "id": "r-post-deploy-verify",
  "trigger": "on_failure",
  "schedule": "0 0 31 2 *",
  "min_spacing_minutes": 30,
  "processRef": "p-deploy-verify"
}
```

| Trigger Value | Fires When |
|--------------|-----------|
| `on_complete` | A Mission completes successfully |
| `on_merge` | A code merge or PR is completed **(not yet implemented)** |
| `on_deploy` | A deployment finishes (success or failure) **(not yet implemented)** |
| `on_failure` | A Mission fails |
| `null` | Cron-only (default) |

### Event-Only Responsibilities

For responsibilities that should **only** fire on events (not on a cron schedule), set the cron to a value that never matches:

```json
"schedule": "0 0 31 2 *"
```

February 31st never exists, so the cron will never fire. The responsibility will only fire when its event trigger matches.

---

## The R→M Envelope Pair

Every responsibility firing creates two WorkEnvelopes:

1. **R envelope** (type `R`) — Immediately `complete`. Records the trigger metadata:
   - `source_meta.responsibility_id`
   - `source_meta.responsibility_name`
   - `source_meta.schedule`
   - `source_meta.fired_at`

2. **M envelope** (type `M`) — Active Mission with the actual work:
   - `parent_id` → R envelope ID
   - `project_id` → from `resp.project_id` or default
   - `process_id` → from `resp.processRef` (if set)

---

## Examples

### Nightly Memory Consolidation (Context-Driven)

```json
{
  "id": "r-memory-consolidation",
  "name": "Nightly Memory Consolidation",
  "schedule": "0 8 * * *",
  "enabled": true,
  "min_spacing_minutes": 720,
  "instruction": "Execute the nightly memory consolidation cycle...",
  "context": {
    "purpose": "MEMORY.md is the agent's working scratchpad...",
    "process": [
      "STEP 1 — GATHER WORKING MEMORY: Read workspace/MEMORY.md",
      "STEP 2 — GATHER SESSIONS: Run session-summary --hours 24",
      "STEP 3 — TRIAGE: Classify entries as ACTIVE/COMPLETED/STALE/PROMOTE"
    ],
    "reference_files": ["workspace/MEMORY.md", "workspace/SOUL.md"],
    "success_criteria": "MEMORY.md rewritten under 2,000 chars. Core Memory reconciled.",
    "prior_learnings": "Be conservative with promotions AND retirements."
  }
}
```

### Hourly Health Check (Process-Linked)

```json
{
  "id": "r-health-check",
  "name": "Hourly Fleet Health Check",
  "schedule": "0 * * * *",
  "enabled": true,
  "min_spacing_minutes": 55,
  "instruction": "Check health of all fleet agents",
  "processRef": "p-deploy-verify",
  "processParameters": {
    "target": "fleet"
  },
  "project_id": "proj-operations"
}
```

### Post-Failure Analysis (Event-Triggered)

```json
{
  "id": "r-failure-analysis",
  "name": "Post-Failure Analysis",
  "schedule": "0 0 31 2 *",
  "enabled": true,
  "min_spacing_minutes": 60,
  "instruction": "Investigate the failed mission and document findings",
  "trigger": "on_failure",
  "processRef": "p-investigate",
  "processParameters": {
    "topic": "Mission failure root cause analysis"
  },
  "project_id": null
}
```

---

## Checklist

Before adding a new responsibility:

- [ ] `id` follows `r-{descriptive-name}` convention
- [ ] `name` is clear and descriptive
- [ ] `schedule` is a valid 5-field cron expression
- [ ] `min_spacing_minutes` prevents accidental rapid-firing
- [ ] `instruction` is a clear, complete directive
- [ ] `context.success_criteria` defines what success looks like
- [ ] `context.prior_learnings` captures lessons (add after first few executions)
- [ ] `processRef` points to an existing playbook ID (if used)
- [ ] `processParameters`, if set, carries only what the fired Mission actually needs (a playbook has no required parameters)
- [ ] `project_id` is set if the work belongs to a specific project
- [ ] `trigger` is one of `on_complete`, `on_failure`, `on_merge` **(not yet implemented)**, `on_deploy` **(not yet implemented)**, or `null`
- [ ] Added to the correct config file (`responsibilities.json` for fleet, `responsibilities-prime.json` for prime-only)
