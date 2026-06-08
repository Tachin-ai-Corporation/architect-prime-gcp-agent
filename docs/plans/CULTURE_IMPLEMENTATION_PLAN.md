# Implementation Plan: Culture of Work — Core Infrastructure

**Scope:** Core product only. The primitives, the data model, the engine, the enforcement. No fleet-specific configurations, no team-specific responsibilities. Those are separate projects that consume this infrastructure.

---

## Current State

| Primitive | Engine | Data Model | Status |
|---|---|---|---|
| **Task** | ✅ Full lifecycle, dispatch, output | ✅ WorkEnvelope type: 'T' | Complete |
| **Checkpoint** | ✅ Sequential execution, auto-verification | ✅ WorkEnvelope type: 'C' | Complete |
| **Mission** | ✅ Process-driven & ad-hoc, blocker handling | ⚠️ Missing `depends_on`. No project enforcement | Needs work |
| **Project** | ⚠️ Loads from Firestore, injects context | ❌ Bare type: no parent_id, no goal, no context, no depends_on | Needs rebuild |
| **Process** | ✅ Registry, checkpoint grouping, execution | ❌ Zero definition files on disk | Needs seeding |
| **Plan** | ❌ Doesn't exist as a primitive | ❌ No type definition | Needs building |
| **Responsibility** | ✅ Cron scheduler, min_spacing, processRef | ⚠️ No event triggers, no project_id field | Needs extension |

---

## Cluster 1: Data Model

### 1A — Expand Project

**Files:** `app/src/lib/types.ts`, `corekit/daemon/agent-brain.mjs`

The current Project is `{ id, name, description, status: 'active' | 'archived' }`. It needs to become the recursive organizational primitive.

**Add fields:**
```typescript
export interface Project {
  id: string;
  name: string;
  goal: string;                                    // NEW
  description: string;
  owner: string;                                   // NEW
  status: 'active' | 'complete' | 'paused' | 'archived';  // EXPANDED
  parent_id: string | null;                        // NEW — recursion
  depends_on: string[];                            // NEW
  context: {                                       // NEW
    documentation: string[];
    processes: string[];
    team: Record<string, string>;
    configuration: Record<string, unknown>;
  } | null;
  created_at: string;
  updated_at: string;
}
```

**Engine changes in agent-brain.mjs:**
- `loadProjects()`: read new fields, build parent→child index
- `buildProjectContext()`: traverse parent chain, accumulate context (most specific wins)
- New: `validateProjectDepth()` — reject nesting beyond 4 levels at write time
- New: Project status transitions. When all child Missions/Projects complete, flag for PM review (or auto-complete if `projects.promotion_auto` is true in contracts)
- New: `depends_on` evaluation. Project stays `paused` until all dependency Projects are `complete` or `archived`

### 1B — Add depends_on to Mission (WorkEnvelope)

**Files:** `app/src/lib/types.ts`, `corekit/daemon/agent-brain.mjs`

**Add field:**
```typescript
export interface WorkEnvelope {
  // ... existing fields ...
  depends_on: string[];    // NEW — Mission IDs
}
```

**Engine changes in agent-brain.mjs:**
- New: `checkDependencies(envelope)` — returns true if all `depends_on` targets are `complete`
- Wire into Mission activation: a `pending` Mission with `depends_on` stays pending until deps clear
- Wire into Mission completion handler: when any Mission completes, scan for Missions that list it in `depends_on` and activate those whose deps are all met
- Reject circular dependencies at write time (traverse the dep graph before writing)
- Firestore schema update: add `depends_on` as `ARRAY` field

### 1C — Plan primitive

**Files:** `app/src/lib/types.ts`, `corekit/daemon/agent-brain.mjs`

**New type:**
```typescript
export interface Plan {
  id: string;
  project_id: string;
  name: string;
  process_id: string | null;
  process_version: number | null;
  parameters: Record<string, unknown>;
  layout: {
    mission: { instruction: string; accept_criteria: string; owner: string };
    checkpoints: {
      instruction: string;
      accept_criteria: string;
      tasks: { instruction: string; accept_criteria: string; agent: string }[];
    }[];
  };
  mission_id: string | null;
  amendments: { timestamp: string; reason: string; changes: string; amended_by: string }[];
  status: 'draft' | 'approved' | 'executing' | 'complete' | 'abandoned';
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}
```

**Engine changes in agent-brain.mjs:**
- Refactor `executeProcess()`: split into `createPlan()` → `approvePlan()` → `stampPlan()`
- `createPlan(processId, parameters, projectId)` — calls `processToCheckpointPlan()`, stores result as Plan in `draft`
- `approvePlan(planId, approvedBy)` — transitions to `approved`, records approver
- `stampPlan(planId)` — creates Mission + Checkpoints + Tasks in Firestore, links `mission_id`
- For auto-approved work (simple processes, routine Responsibility firings): all three steps in one call. Current behavior preserved — just routed through the Plan layer.
- Plans stored in Firestore: `primes/{PRIME_ID}/plans/{planId}`
- Plan amendments: new function `amendPlan(planId, reason, changes)` that records the amendment and updates remaining unstamped Checkpoints/Tasks

### 1D — Extend Responsibility schema

**Files:** `corekit/config/responsibilities.json` schema, `corekit/daemon/agent-brain.mjs`

**Add fields to Responsibility definitions:**
```json
{
  "trigger": null,          // NEW — "on_merge" | "on_deploy" | "on_failure" | null
  "project_id": null        // NEW — where generated Missions live
}
```

**Engine changes in agent-brain.mjs:**
- New: `fireEventResponsibilities(eventType)` — called from relevant code paths (Mission completion, deployment, etc.). Finds all Responsibilities with matching `trigger` and fires them.
- Update `fireResponsibility()`: set `project_id` on generated Missions from the Responsibility's `project_id` field. If null, use the agent's default project.
- Update existing `r-memory-consolidation` to include `project_id`.

---

## Cluster 2: Default Project

Depends on: Cluster 1A

### 2A — Create default project at startup

**Files:** `corekit/daemon/agent-brain.mjs`

In `main()` initialization, after Firestore is available:
- Derive default project ID: `{AGENT_ID}/general` (e.g., `stan/general`)
- Check if Project exists in Firestore
- If not: create it with `{ goal: "General workspace", status: "active", parent_id: null, owner: AGENT_ID }`
- Store the ID as `DEFAULT_PROJECT_ID` module-level constant

### 2B — Enforce project_id on all Missions

**Files:** `corekit/daemon/agent-brain.mjs`

Every code path that creates a Mission must set `project_id`:
- `processIntake()` → new_mission classification: if cortex didn't set `project_id`, use `DEFAULT_PROJECT_ID`
- `executeProcess()` → if no project context, use `DEFAULT_PROJECT_ID`
- `fireResponsibility()` → use `resp.project_id` or `DEFAULT_PROJECT_ID`
- `handleAttach()` → inherit `project_id` from the parent Mission
- `processIntakeAsNewTask()` → inherit from parent or use default

Add Firestore write validation: reject any Mission (type: 'M') write where `project_id` is null or empty.

---

## Cluster 3: Process Definitions

Depends on: nothing (parallel with Clusters 1-2)

### 3A — Create core process files

**Directory:** `corekit/processes/`

These are universal processes any fleet team would use. Not Forge-specific.

| File | Process | What it does |
|---|---|---|
| `p-plan.json` | Plan and Build | Investigate → plan → approve → implement → validate → commit |
| `p-review.json` | Code Review | Read diff → check correctness → check conventions → verdict |
| `p-audit.json` | Codebase Audit | Define criteria → scan → classify → create work → report |
| `p-investigate.json` | Investigation | Frame question → gather evidence → analyze → recommend |
| `p-deploy-verify.json` | Deployment Verification | Health check → smoke test → regression check → report |
| `p-release.json` | Release | Pre-flight → tag → deploy → verify → announce |

Each file follows the existing schema consumed by `loadLocalProcesses()` and `processToCheckpointPlan()`. Steps include `checkpointBoundary`, `accept_criteria`, `agent`, and `optional` fields as appropriate.

### 3B — Sub-process composition

**Files:** `corekit/daemon/agent-brain.mjs`

In `processToCheckpointPlan()`: when a step has a `sub_process` field, load the referenced Process, substitute parameters, and inline its steps into the checkpoint grouping. Track visited IDs to reject circular references. Output remains one flat Mission.

---

## Cluster 4: SOUL.md — Culture of Work Rules

Depends on: Clusters 1-3 (model, defaults, processes must exist)

### 4A — Cortex SOUL

**File:** `brain/prime/cortex/SOUL.md`

Add a "Culture of Work" section:
- Every Mission must have a `project_id`. Use default project when no named project applies.
- Prefer `follow_process` when `available_processes` matches the work.
- Mission instructions describe goals, not steps.
- If work spans multiple agents or independent goals, it needs Project-level structure — do not try to fit it into one Mission.
- Set `depends_on` when new work depends on an active Mission's completion.

Update classification schema: `project_id` required (not optional).

### 4B — Prefrontal SOUL

**File:** `brain/prime/prefrontal/SOUL.md`

Add:
- When designing a checkpoint_plan, every Checkpoint must have accept criteria.
- If a plan exceeds 6-8 Checkpoints, recommend restructuring as a sub-Project with multiple Missions.
- Check available_processes before planning from scratch.

### 4C — Motor SOUL

**File:** `brain/prime/motor/SOUL.md`

Add:
- Motor executes Tasks. Motor does not plan, create Missions, or modify Plans.
- If a Task is too complex, fail it with a clear error describing why decomposition is needed. Do not attempt to self-decompose.

### 4D — Cerebellum SOUL

**File:** `brain/prime/cerebellum/SOUL.md`

Reinforce:
- Verification evaluates outcomes against accept criteria, not command exit codes.
- A command can succeed but produce wrong results. Check the actual output.

---

## Cluster 5: contracts.json

Depends on: nothing

**File:** `infra/contracts.json`

```jsonc
"dispatch": {
  "max_iterations": 50    // was 12
}
```

Single line. Immediate impact.

---

## Cluster 6: Dashboard

Depends on: Clusters 1-2 (data model stable)

### 6A — Project hierarchy

- Tree view of Projects (parent → children → Missions)
- Sub-project creation UI
- Project context editor (team, processes, documentation)
- Project `depends_on` editor and display
- Default project visible per agent
- Status transitions: active → complete / paused / archived

### 6B — Plan viewer

- View Plans in draft/approved/executing/complete
- Approve/abandon Plans from dashboard
- View amendments during execution
- Link Plan ↔ Mission

### 6C — Dependency visualization

- `depends_on` relationships between Missions shown in work tree
- Visual: which Missions are pending on dependencies vs actively blocked
- Auto-activation visible when dependency completes

---

## Cluster 7: Documentation

Depends on: all other clusters

### 7A — Culture of Work in repo

```
docs/CULTURE_OF_WORK.md
docs/primitives/01-TASK.md
docs/primitives/02-CHECKPOINT.md
docs/primitives/03-MISSION.md
docs/primitives/04-PROJECT.md
docs/primitives/05-PROCESS.md
docs/primitives/06-PLAN.md
docs/primitives/07-RESPONSIBILITY.md
```

### 7B — Authoring guides

```
docs/guides/AUTHORING_PROCESSES.md
docs/guides/AUTHORING_RESPONSIBILITIES.md
```

### 7C — README update

Reference the Culture of Work. Update architecture section. Remove any stale work system descriptions.

---

## Execution Order

```
Cluster 5  (contracts — 5 min)                    ─┐
Cluster 3  (process definitions — no deps)         ─┤── immediate, parallel
                                                    │
Cluster 1  (data model — no deps)                  ─┤── immediate, parallel
  1A: Project type expansion                        │
  1B: depends_on on WorkEnvelope                    │
  1C: Plan primitive                                │
  1D: Responsibility schema extension               │
                                                    │
Cluster 2  (default project — depends on 1A)       ─┤
  2A: Create default project at startup             │
  2B: Enforce project_id on all Missions            │
                                                    │
Cluster 4  (SOUL.md — depends on 1, 2, 3)         ─┤
  4A-4D: Culture rules wired into all SOULs         │
                                                    │
Cluster 6  (dashboard — depends on 1, 2)           ─┤
  6A: Project hierarchy                             │
  6B: Plan viewer                                   │
  6C: Dependency visualization                      │
                                                    │
Cluster 7  (documentation — after all)             ─┘
```

---

## Exit Criteria

- [ ] `Project` type in Firestore has: `parent_id`, `goal`, `owner`, `context`, `depends_on`, full status set
- [ ] `Project` recursion works to 4 levels, depth 5 rejected
- [ ] `WorkEnvelope` has `depends_on` field. Dependency evaluation auto-activates pending Missions
- [ ] `Plan` primitive exists in Firestore with draft → approved → executing → complete lifecycle
- [ ] `executeProcess()` routes through Plan layer
- [ ] `Responsibility` supports `trigger` and `project_id` fields
- [ ] Default project `{agent-id}/general` created automatically at agent startup
- [ ] No Mission can be written to Firestore with `project_id: null`
- [ ] Six core process definitions exist in `corekit/processes/`
- [ ] Sub-process composition flattens correctly (no nested Missions)
- [ ] `dispatch.max_iterations` is 50
- [ ] Cortex SOUL enforces Culture of Work rules
- [ ] Culture of Work documentation committed to `docs/`
