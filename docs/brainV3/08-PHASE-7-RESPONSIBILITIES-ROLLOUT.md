# Phase 7: Responsibilities + fleet rollout

> **Goal:** Cron-triggered Responsibilities via Brain's built-in scheduler. Agent self-management of Responsibilities via Cortex tools. Architecture deployed to Prime and all Fleet agents. Deprecated v2 code removed.

---

## Prerequisites

- Phase 6 complete: delegation + dashboard working on Stan and at least one other agent

---

## Deliverables

### 1. Responsibility scheduler in Brain

Brain loads `responsibilities.json` at startup and runs an internal cron scheduler:

```json
{
  "responsibilities": [
    {
      "id": "r-memory-consolidation",
      "schedule": "0 3 * * *",
      "instruction": "Run nightly memory consolidation — compact working notes into durable core memory, prune stale entries, update deep truths",
      "enabled": true,
      "min_spacing_minutes": 15
    },
    {
      "id": "r-stale-envelope-review",
      "schedule": "0 9 * * 1",
      "instruction": "Review envelopes stuck in active/waiting for more than 48 hours, escalate to operator",
      "enabled": true,
      "min_spacing_minutes": 15
    }
  ]
}
```

**Scheduler behavior:**
- Parse cron expressions on startup, calculate next-fire times
- Background timer checks every 60 seconds
- When a Responsibility fires: create type=R envelope + child type=M envelope in Firestore
- The Mission enters the normal Brain queue and gets processed through the Cortex loop
- Minimum spacing enforced: if another Responsibility is due within `min_spacing_minutes`, defer it

**Per-specialty Responsibilities:**
- `responsibilities.json` is deployed via the manifest system
- `manifests/role-prime.txt` installs Prime Responsibilities (fleet health, upgrade checks)
- `manifests/job-devops.txt` installs DevOps Responsibilities (infrastructure monitoring)
- Each job manifest can include a `responsibilities-{job}.json` that gets merged with base

### 2. Agent self-management tools

Cortex gets three new tool actions for managing Responsibilities:

**`responsibility-create`:**
```json
{
  "action": "dispatch",
  "agent": "motor",
  "intent": "execute",
  "task": "Create a new Responsibility: schedule='0 8 * * 1-5' instruction='Check infrastructure costs and alert if spending exceeds budget'",
  "accept_criteria": "Responsibility written to responsibilities.json and scheduler updated"
}
```

Motor executes by:
1. Writing the new entry to `responsibilities.json`
2. Sending a signal to Brain to reload the schedule (or Brain watches the file for changes)

**`responsibility-remove`:** Motor removes the entry from `responsibilities.json`.

**`responsibility-list`:** Motor reads `responsibilities.json` and returns the current Responsibilities with next-fire times.

### 3. Dashboard Responsibility view

Extend the R/C/M/T tree to show Responsibilities at the top level:
- Each Responsibility shows: name, schedule (human-readable), last fired, next fire, enabled/disabled
- Expandable: shows child Missions spawned by this Responsibility
- Toggle: enable/disable a Responsibility from the dashboard

### 4. Prime deployment

Deploy the Brain v3 architecture to Prime:
- Install `agent-brain.mjs` + `agent-brain.service`
- Install Prime-specific `agent-registry.json` (includes fleet tools)
- Install Prime-specific `responsibilities.json`
- Update Prime's Cortex SOUL.md to v3
- Update Prime's Ears and Mouth with feature flags
- Validate: Prime handles dashboard messages through the new pipeline
- Validate: Prime can delegate to Fleet agents via Firestore

### 5. Fleet bootstrap update

Update `infra/bootstrap/fleet-bootstrap.sh` and `infra/install.sh`:
- `manifests/base.txt`: add agent-brain.mjs, agent-brain.service, start-agent-brain, agent-registry template
- `manifests/role-fleet.txt`: add fleet-specific Brain config
- Each `manifests/job-{specialty}.txt`: add per-job responsibilities and agent-registry overrides
- `build-agent-registry` runs at bootstrap to generate the registry from installed tools

### 6. Deprecated code removal

Remove the following, which are fully replaced by Brain v3:

| File | Replacement |
|------|-------------|
| `corekit/brain/brain-exec` | Brain service Cortex loop |
| `corekit/brain/brain-exec-worker` | Brain service HTTP dispatch |
| `corekit/brain/check-plan-compliance` | Cerebellum envelope-based verification |
| `corekit/brain/build-system-prompt` | Agent registry + Cortex SOUL v3 |
| Conversation history in `agent-ears.mjs` | Firestore intake records |
| JSONL tailing in `agent-mouth.mjs` | Firestore envelope listener |
| `PLAN.md` file-based gate | Firestore envelope state machine |
| `sessions_spawn`/`sessions_yield` usage in Cortex SOUL | Brain HTTP dispatch |
| BRAIN_CARD.md routing hints | Agent registry JSON |

### 7. Feature flag removal

Remove the `BRAIN_V3_*` feature flags. The v3 pipeline is now the only path:
- Ears always writes intake to Firestore
- Brain always processes envelopes
- Mouth always reads from Firestore

### 8. Contracts.json update

Add Brain-related values to `contracts.json`:
```json
{
  "brain": {
    "poll_interval_ms": 2000,
    "max_iterations": 12,
    "session_strategy": "named_per_envelope",
    "min_responsibility_spacing_minutes": 15
  }
}
```

`validate-contracts` updated to check these values.

---

## End-to-end tests

**Test 1 — Responsibility fires:**
1. Configure a Responsibility with a 1-minute schedule (for testing)
2. Wait for it to fire
3. Verify: R envelope + M envelope created in Firestore
4. Verify: Brain processes the Mission normally
5. Verify: Dashboard shows the Responsibility → Mission relationship

**Test 2 — Agent creates own Responsibility:**
1. Ask Stan "Monitor the staging server health every 6 hours and alert me if anything is wrong"
2. Verify: Cortex dispatches Motor to create a Responsibility
3. Verify: New entry in responsibilities.json
4. Verify: Responsibility fires on schedule
5. Verify: Dashboard shows the new Responsibility

**Test 3 — Fleet-wide:**
1. All agents (Prime + Fleet) running Brain v3
2. Human sends message to Prime → processes through new pipeline
3. Prime delegates to Stan → Firestore envelope → Stan processes → Prime resumes
4. Dashboard shows fleet-wide R/C/M/T tree with all agents' work
5. No `sessions_spawn` calls anywhere in any logs

---

## Files created/modified

| File | Action | Description |
|------|--------|-------------|
| `corekit/daemon/agent-brain.mjs` | MODIFY | Responsibility scheduler, file watcher for config changes |
| `corekit/config/responsibilities.json` | CREATE | Base Responsibilities template |
| `corekit/config/responsibilities-prime.json` | CREATE | Prime-specific Responsibilities |
| `specialties/devops/responsibilities.json` | CREATE | DevOps Responsibilities |
| `infra/manifests/base.txt` | MODIFY | Add Brain service files |
| `infra/manifests/role-prime.txt` | MODIFY | Add Prime Responsibilities |
| `infra/manifests/role-fleet.txt` | MODIFY | Add Fleet Brain config |
| `infra/manifests/job-*.txt` | MODIFY | Add per-job Responsibilities |
| `infra/bootstrap/fleet-bootstrap.sh` | MODIFY | Deploy Brain service |
| `infra/contracts.json` | MODIFY | Add brain section |
| `corekit/system/validate-contracts` | MODIFY | Validate brain config |
| `corekit/brain/brain-exec` | DELETE | Replaced by Brain service |
| `corekit/brain/brain-exec-worker` | DELETE | Replaced by Brain service |
| `corekit/brain/check-plan-compliance` | DELETE | Replaced by Cerebellum |
| `corekit/brain/build-system-prompt` | DELETE | Replaced by agent registry |
| `brain/prime/cortex/BRAIN_CARD.md` | DELETE | Replaced by agent registry |
| `app/src/app/page.tsx` | MODIFY | Add Responsibility view to dashboard |
