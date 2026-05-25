# Implementation Plan: Projects, Processes & Context Packets

**Repo:** `Tachin-ai-Corporation/architect-prime-gcp-agent`  
**Base version:** `v2026.05.24.21.32`  
**Reference docs:** `projects-processes-plan.html`, `context-packets-plan.html`

---

## Current State Reconciliation

Before making any changes, understand exactly what exists today and where each piece lives.

### Firestore Schema (current)

```
primes/{id}                                    → Prime instance metadata
primes/{id}/messages/{msg}                     → Dashboard ↔ Prime chat messages
primes/{id}/fleet/{agent}                      → Fleet agent status, deploy steps, health
primes/{id}/fleet/{agent}/messages/{msg}        → Dashboard ↔ Fleet agent chat messages
primes/{id}/tasks/{taskId}                     → Prime task lifecycle log
primes/{id}/fleet/{agent}/tasks/{taskId}        → Fleet task lifecycle log
primes/{id}/work/{id}                          → Work envelopes (R/M/C/T state machine)
primes/{id}/work/{id}/history/                 → Status transition log
primes/{id}/intake/{id}                        → Brain intake queue
primes/{id}/fleet/{agent}/introspect/{queryId} → Introspection query/result bus
config/settings                                → Agent defaults (email domain)
config/dwd                                     → DWD configuration
```

**No `projects/` collection exists. No `processes/` collection exists. No `context` field exists on any document.**

### Dashboard Routes (current)

```
/                          → Home (Living Agent Graph + split-panel chat)
/work?prime={id}           → Work tree (M→C→T, three tabs, agent strip)
/work?prime={id}&agent={n} → Agent-scoped work tree
/brain?prime={id}          → Prime brain (6-slot LLM grid)
/brain?prime={id}&agent={n}→ Fleet agent brain
/skills?prime={id}         → Prime skills (introspection-backed)
/skills?prime={id}&agent={n}→ Fleet agent skills
/settings                  → Global settings (models, DWD, setup)
```

**No `/projects` route. No `/processes` route. No project selector on the work page.**

### Dashboard API Routes (current)

```
POST /api/primes/{id}/deploy
POST /api/primes/{id}/messages
GET  /api/primes/{id}/fleet/{agent}/messages
POST /api/primes/{id}/fleet/{agent}/messages
POST /api/primes/{id}/fleet/hire
POST /api/primes/{id}/fleet/fire
POST /api/primes/{id}/fleet/update-status
POST /api/primes/{id}/fleet/confirm-setup
GET  /api/primes/{id}/fleet
GET  /api/primes/{id}/fleet/[agent]/logs
GET  /api/agent-types
GET  /api/setup
POST /api/setup
GET  /api/upgrade
POST /api/upgrade
GET  /api/upgrade/status
GET  /api/primes/{id}/work
POST /api/primes/{id}/work/{workId}/respond
POST/GET /api/primes/{id}/fleet/{agent}/introspect
```

**No project CRUD endpoints. No process endpoints. No context endpoints.**

### Brain Architecture (current)

The brain daemon (`agent-brain.mjs`) runs as a systemd service on every VM (Prime + fleet). Key facts:

- **Cortex classify/decide loop:** Returns structured JSON actions: `classify`, `decide`, `short_circuit`, `dispatch`, `continue`, `synthesize`. No `create_project`, `follow_process`, or `load_context` actions exist.
- **Envelope hierarchy:** M→C→T. Missions contain Checkpoints, Checkpoints contain Tasks. Envelopes live at `primes/{id}/work/{id}`. No `projectId` field on envelopes.
- **Delegation:** Cortex can issue `delegate` action to create child envelopes on other agents. The parent waits, resumes on child completion.
- **Responsibilities:** Configured in `responsibilities-job.json` per agent. File watcher hot-reloads. CRUD via `responsibility-manage` Motor tool. No `processRef` field on responsibility entries.
- **Context assembly:** System prompt = SOUL.md + IDENTITY.md + MEMORY.md + agent-registry.json (~20K tokens). Rolling 400K token envelope context budget.
- **Memory:** Three tiers — MEMORY.md (working), Core Memory in Firestore (long-term), Deep Truths in SOUL.md (behavioral). Nightly consolidation.
- **Shared workspaces:** Mission-scoped shared dirs for motor file continuity within a mission.
- **Envelope fields** (known from Work API + brain code): `type`, `status`, `title`, `description`, `agent`, `parentId`, `children`, `iteration_history`, `delivery_status`, `created_at`, `updated_at`. No `projectId`, no `context`, no `processId`.

### CoreKit Scripts (current)

Organized in `corekit/` by domain:

```
fleet/    → fleet-deploy, fleet-teardown, fleet-hire, fleet-fire, fleet-status,
            fleet-verify, fleet-upgrade, fleet-monitor, fleet-health-check
gateway/  → render-config, discover-models, upgrade-openclaw, oc, smoke-test
chat/     → chat-send, chat-read, dwd-token
daemon/   → agent-ears.mjs, agent-mouth.mjs, agent-introspect.mjs, start-*
brain/    → agent-ask, assemble-tools, brain-telemetry-write/read, task-log-write/read
memory/   → core-memory-read, core-memory-write, update-deep-truths
dashboard/→ command-runner
system/   → upgrade-corekit, validate-contracts
config/   → agent-registry.json, fleet-registry.json, openclaw-bootstrap.json5.tmpl
```

**No project-manage, process-manage, or context-manage scripts exist.**

### Specialty SOULs (current)

Eight specialties, each with `SOUL.md`, `IDENTITY.md`, `TOOLS.md` at `specialties/{type}/workspace/`. The PM SOUL references planning, task breakdown, status tracking — but has no awareness of Projects or Processes as formal concepts.

---

## Phase 1: Projects + Context Packets

**Goal:** Add Projects as a first-class organizing layer for work. Add Context Packets as structured environment data on Projects and Missions.

**Estimated scope:** 2-3 days.

### 1.1 Firestore: Add `projects` collection

Create the collection at: `primes/{primeId}/projects/{projectId}`

Document schema:

```json
{
  "name": "Q3 Close",
  "description": "Quarterly financial close and reporting.",
  "status": "active",
  "ownerAgent": "mira",
  "participants": ["mira", "cleo", "anora"],
  "missionCount": 3,
  "completedMissions": 1,
  "createdAt": "Timestamp",
  "createdBy": "operator | agent:mira",
  "completedAt": "Timestamp | null",
  "context": {
    "budget_sheet": {
      "kind": "sheet",
      "ref": "spreadsheet_id",
      "url": "https://docs.google.com/spreadsheets/d/...",
      "name": "Q3 2026 Budget",
      "summary": "Master budget tracker. Tabs: actuals, forecast, variance.",
      "updatedAt": "ISO timestamp",
      "updatedBy": "agent:cleo"
    }
  }
}
```

Valid status values: `active`, `completed`, `archived`.

Valid context entry kinds: `drive_folder`, `sheet`, `doc`, `dataset`, `url`, `template`, `people`, `convention`.

### 1.2 Firestore: Add `projectId` to work envelopes

Add an optional field `projectId` (string | null) to work envelope documents at `primes/{id}/work/{id}`.

- Default: `null` for all existing envelopes (no migration needed, field simply absent)
- New envelopes may optionally include a `projectId` referencing a document in the `projects` subcollection
- This is backward-compatible — all existing code that reads envelopes ignores unknown fields

### 1.3 Firestore: Add `context` to work envelopes

Add an optional field `context` (map | null) to work envelope documents.

- Same schema as the project-level `context` field
- When present, merges with the parent project's context (mission-level overrides on key collision)
- Default: `null` (absent)

### 1.4 Dashboard API: Project CRUD

Add four new API routes:

```
GET  /api/primes/{id}/projects              → List all projects for this prime
POST /api/primes/{id}/projects              → Create a new project
GET  /api/primes/{id}/projects/{projectId}  → Get project detail (with context)
PUT  /api/primes/{id}/projects/{projectId}  → Update project (name, description, status, context)
```

Implementation: Server-side using Firebase Admin SDK (same pattern as existing `/api/primes/{id}/work` route).

For the PUT endpoint, support partial updates — the operator may update only the `context` map without touching other fields.

### 1.5 Dashboard API: Extend Work endpoint

Modify `GET /api/primes/{id}/work` to:

1. Accept an optional `?projectId={id}` query parameter to filter envelopes by project
2. Include `projectId` in the response payload for each envelope
3. For envelopes with a `projectId`, join the project document's `context` field into the response (so the dashboard can display project context alongside work)

### 1.6 Dashboard UI: Projects page

Create a new top-level route: `/projects?prime={id}`

This page displays:

- All projects for the selected prime as cards
- Each card shows: name, status, progress bar (completedMissions/missionCount), participant agent chips, created date
- A "+ Create Project" card that opens an inline modal (name + description + optional context entries)
- Clicking a project card navigates to: `/projects?prime={id}&project={projectId}`

The project detail view shows:

- Project header: name, description, progress bar, participant chips
- Context section: list of context entries (kind icon, name, summary preview), with "Add entry" and "Edit" actions
- Mission list: all work envelopes with `projectId` matching this project, rendered as a simple M→C→T tree (reuse existing work tree component)
- Clicking a mission navigates to `/work?prime={id}` pre-scrolled to that mission

### 1.7 Dashboard UI: Project filter on Work page

Add a project filter dropdown to the existing work page filter bar at `/work?prime={id}`.

- Default: "All projects" (shows all envelopes)
- Options: list of active projects for this prime + "No project" (envelopes with null projectId)
- Selecting a project sets `?projectId={id}` in the URL and filters the tree

### 1.8 Dashboard UI: Project navigation

Add a "Projects" nav option to the prime chip on the home page. This follows the same pattern as Work/Brain/Skills — clicking it navigates to `/projects?prime={id}`.

### 1.9 Brain: Cortex `create_project` action

Add a new action to the Cortex classify/decide loop: `create_project`.

When Cortex returns `{ "action": "create_project", "name": "...", "description": "..." }`:

1. The brain daemon writes a new document to `primes/{primeId}/projects/{auto-id}` with the provided name and description
2. Status is set to `active`, createdBy is set to the current agent
3. The project ID is returned to Cortex so it can reference it in subsequent envelope creation

### 1.10 Brain: Cortex `assign_to_project` action

Add a new action: `assign_to_project`.

When Cortex returns `{ "action": "assign_to_project", "envelopeId": "...", "projectId": "..." }`:

1. The brain daemon updates the envelope document to set `projectId`
2. The brain daemon updates the project document to increment `missionCount` and add the current agent to `participants` if not already present

### 1.11 Brain: Context injection

Modify the context assembly pipeline in `agent-brain.mjs`:

1. When dispatching work for an envelope that has a `projectId`, fetch the project document
2. Merge the project's `context` with the envelope's `context` (envelope wins on key collision)
3. Render the merged context as a `## Project Context: {name}` section
4. Inject this section into the system prompt **after MEMORY.md and before the envelope history**
5. If the merged context exceeds 2,000 tokens, dispatch Prefrontal to select the 10 most relevant entries for the current task

Format for injection:

```
## Project Context: Q3 Close

budget_sheet (sheet): Q3 2026 Budget
  ID: 1BxR7a9K... | Updated: May 22 by Agent-Cleo
  Master budget tracker. Tabs: actuals, forecast, variance. Amounts in USD.

project_folder (drive_folder): /Finance/Q3-Close/
  ID: folder_id | Updated: May 21 by Agent-Mira
  Root project folder. Contains: /Reports, /Data, /Templates.
```

### 1.12 Brain: Context backfill

When Motor executes a tool call that creates a resource (drive_create_folder, sheets_create, docs_create) during an envelope that has context entries with `ref: null`:

1. Extract the resource ID from the tool call result
2. Match it to the null-ref context entry by key (the brain knows which step it's executing)
3. Write the real `ref` and `url` back into the envelope's `context` field in Firestore
4. The updated context is available to subsequent tasks without re-discovery

### 1.13 SOUL updates

Update PM specialty SOUL.md (`specialties/pm/workspace/SOUL.md`) to include awareness of Projects:

- Add to "What I Do": "Organize related missions under Projects with context and progress tracking."
- Add to core identity: awareness that Projects are a first-class concept in Firestore, that they carry context packets, and that Missions can be assigned to them.

---

## Phase 2: Processes

**Goal:** Add Processes as reusable, shareable, evolving playbooks that agents create, follow, and improve.

**Estimated scope:** 1-2 weeks.

### 2.1 Firestore: Add `processes` collection

Create the collection at: `primes/{primeId}/processes/{processId}`

Document schema:

```json
{
  "name": "Competitor Research",
  "description": "Full competitor analysis with ongoing monitoring.",
  "version": 1,
  "status": "active",
  "createdBy": "agent:mira",
  "createdAt": "Timestamp",
  "updatedAt": "Timestamp",
  "updatedBy": "agent:mira",
  "visibility": "fleet",
  "sharedWith": [],
  "projectId": null,
  "category": "research",
  "parameters": [
    { "name": "competitor_name", "type": "string", "required": true },
    { "name": "categories", "type": "list", "default": ["product", "pricing", "blog", "careers"] }
  ],
  "steps": [
    {
      "order": 1,
      "title": "Check if competitor directory exists",
      "description": "Drive → look in /Research/Competitors/{competitor_name}/",
      "tools": ["drive_list"],
      "conditional": "if_exists: skip_to:4",
      "checkpointBoundary": false
    },
    {
      "order": 7,
      "title": "Handoff to designer agent",
      "type": "delegation",
      "delegateTo": "specialty:designer",
      "optional": true,
      "checkpointBoundary": true
    },
    {
      "order": 8,
      "title": "Create monitoring responsibility",
      "type": "spawn_responsibility",
      "schedule": "0 9 * * 1",
      "processRef": "self:step:5",
      "checkpointBoundary": true
    }
  ],
  "contextTemplate": {
    "competitor_folder": {
      "kind": "drive_folder",
      "ref": null,
      "name": "/Research/Competitors/{competitor_name}/",
      "summary": "Competitor research folder."
    }
  },
  "executionCount": 0,
  "lastExecuted": null,
  "changelog": []
}
```

Valid status values: `draft`, `active`, `deprecated`.

Valid visibility values: `fleet` (all agents), `agents` (use sharedWith list), `private`.

Valid step types: `standard` (default), `delegation`, `spawn_responsibility`, `conditional`, `approval_gate`.

### 2.2 Dashboard API: Process CRUD

Add API routes:

```
GET  /api/primes/{id}/processes              → List all processes
POST /api/primes/{id}/processes              → Create process
GET  /api/primes/{id}/processes/{processId}  → Get process detail
PUT  /api/primes/{id}/processes/{processId}  → Update process (increments version, appends changelog)
```

### 2.3 Dashboard UI: Process library

Create a new top-level route: `/processes?prime={id}`

Displays all processes as cards: name, description, version, created by, execution count, status badge.

- "+ Create Process" card opens a structured form: name, description, parameter definitions, step builder
- Clicking a process opens the detail view: full step list, parameters, context template, execution history, changelog
- Share controls: visibility selector, agent picker for restricted sharing

Also accessible from agent settings at `/settings?prime={id}&agent={name}` — the agent's settings page should link to processes that agent has created or has access to.

### 2.4 Dashboard UI: Process navigation

Add "Processes" to the prime chip nav options on the home page, alongside Projects, Work, Brain, Skills.

### 2.5 Brain: Process loader

Add a new module to `agent-brain.mjs` or as a separate file (`process-loader.mjs`):

1. Given a `processId` and a parameter map, fetch the process document from Firestore
2. Validate that all required parameters are provided (if not, return a `needs_input` state listing the missing ones)
3. Substitute parameter values into step titles, descriptions, and context template
4. Generate an M→C→T envelope tree from the steps:
   - Mission: one envelope with the process name and filled parameters as the title
   - Checkpoints: grouped by `checkpointBoundary: true` markers (each boundary ends a checkpoint, next step starts a new one)
   - Tasks: each step within a checkpoint boundary becomes a task
5. Attach the filled `contextTemplate` as the mission's `context` field
6. Return the generated envelope tree for the brain daemon to execute normally

### 2.6 Brain: Cortex `follow_process` action

Add to the Cortex classify/decide loop:

When Cortex returns `{ "action": "follow_process", "processId": "...", "parameters": {...} }`:

1. Call the process loader (2.5) with the process ID and parameters
2. If parameters are missing, create a `needs_input` envelope asking for them
3. If all parameters are provided, create the M→C→T tree and begin executing the first checkpoint

### 2.7 Brain: Special step types

Extend the brain's task execution handler to recognize special step types:

**delegation**: When the brain encounters a task with `type: "delegation"`:
- Use the existing delegation handler to create a child envelope on the target agent
- If `delegateTo` starts with `specialty:`, look up the fleet registry for an agent with that specialty
- If `optional: true` and no matching agent is found, skip the task and mark it as `skipped`
- If `optional: false` and no agent is found, create a `needs_input` state: "No {specialty} agent available. Hire one or skip?"

**spawn_responsibility**: When the brain encounters a task with `type: "spawn_responsibility"`:
- Use the existing `responsibility-manage` Motor tool to write a new entry to `responsibilities-job.json`
- Set the cron schedule from the step's `schedule` field
- If `processRef` is present, add it to the responsibility entry so the responsibility can re-invoke the process (or a subset of it) on each fire

**approval_gate**: When the brain encounters a task with `type: "approval_gate"`:
- Immediately set the envelope to `needs_input` status
- Include the step's description as the question text
- Wait for human response before proceeding (uses existing human-in-the-loop infrastructure)

### 2.8 Brain: Process extraction (agent-initiated creation)

After a mission completes, the brain can offer to extract a process:

1. When a mission reaches `complete` status, check if it had 3+ checkpoints and 5+ tasks (threshold for "repeatable pattern")
2. If yes, have Cortex generate a process definition from the completed envelope tree:
   - Map each checkpoint to checkpoint boundaries
   - Map each task to a step with its title and tools
   - Identify parameterizable values (specific names, IDs, dates that should become variables)
3. Save as a `draft` process in Firestore
4. Report to the agent: "I've drafted a process from this mission: {name}. Review and activate?"

This is an opportunistic background action — it runs after delivery, doesn't block the mission, and produces a draft that requires explicit activation.

### 2.9 Brain: Process versioning

When a process is updated (via dashboard or agent):

1. Increment the `version` field
2. Append to the `changelog` array: `{ version, date, by, note }`
3. Existing responsibilities referencing this process automatically use the latest version on their next fire
4. Currently-executing missions generated from an older version are not affected (they already have their M→C→T tree)

### 2.10 CoreKit: `process-manage` Motor tool

Create a new CoreKit script: `corekit/brain/process-manage`

This is the Motor-accessible tool for CRUD operations on processes (same pattern as `responsibility-manage`):

- `process-manage create --name "..." --description "..." --steps-file /path/to/steps.json`
- `process-manage update --id "..." --steps-file /path/to/steps.json --note "..."`
- `process-manage list`
- `process-manage get --id "..."`

The tool reads/writes to the Firestore `processes` collection via the Admin SDK.

Add to manifests: `role-fleet.txt` (available to all fleet agents).

### 2.11 SOUL updates

Update all specialty SOULs to include awareness of Processes:

- PM SOUL: "I create and maintain Processes — reusable playbooks for recurring work. I extract processes from completed missions and share them across the fleet."
- All SOULs: "I can follow Processes when assigned. A Process provides step-by-step instructions with tools, conditionals, and handoff points. I execute each step and the brain verifies."

---

## Phase 3: Composition

**Goal:** Wire Projects, Processes, and Responsibilities together.

**Estimated scope:** 1 week.

### 3.1 Responsibility → Process reference

Extend the `responsibilities-job.json` schema to support an optional `processRef` field:

```json
{
  "process": "weekly-status-brief",
  "purpose": "Send weekly status to stakeholders",
  "schedule": "0 9 * * 1",
  "success_criteria": "Brief delivered to leadership folder",
  "processRef": "process_firestore_id",
  "processParameters": { "period": "this_week" }
}
```

When the responsibility fires:

1. The brain checks for `processRef`
2. If present, loads the process and generates an M→C→T tree with the provided parameters
3. If absent, fires as before (creates a mission from the responsibility's `purpose` and `success_criteria`)

### 3.2 Project → Process listing

Add an optional `standardProcesses` field to the project document:

```json
{
  "standardProcesses": ["process_id_1", "process_id_2"]
}
```

This is a display/organization field — the dashboard shows these on the project detail page as "Standard Processes for this project." The PM agent can reference them when planning work under the project.

### 3.3 Context promotion

When a mission completes, new context entries that were added at the mission level (not inherited from the project) should be promotable:

1. The brain identifies entries in the mission's `context` that don't exist in the parent project's `context` (new keys)
2. These are flagged as "promotable" in the work envelope
3. The dashboard shows a "Promote to project" action on the mission detail view for each new entry
4. Clicking it copies the entry to the project's `context` field
5. Optionally, the PM agent can auto-promote entries if configured to do so in its SOUL

### 3.4 Dashboard: Responsibility → Process linking

On the agent settings page (where responsibilities are managed), add a "Link to process" option:

- When creating or editing a responsibility, the operator can optionally select a process from a dropdown
- This sets the `processRef` and lets the operator fill in `processParameters`
- The responsibility card in the work tree shows the linked process name

### 3.5 contracts.json extension

Add a `projects` section to `contracts.json`:

```json
{
  "projects": {
    "context_max_tokens": 2000,
    "context_prefrontal_threshold": 2000,
    "promotion_auto": false,
    "archive_completed_after_days": 30
  }
}
```

Add validation to `validate-contracts` (Check 12).

---

## File Inventory: What Gets Created / Modified

### New files

```
# Dashboard API
dashboard/src/app/api/primes/[id]/projects/route.ts
dashboard/src/app/api/primes/[id]/projects/[projectId]/route.ts
dashboard/src/app/api/primes/[id]/processes/route.ts
dashboard/src/app/api/primes/[id]/processes/[processId]/route.ts

# Dashboard pages
dashboard/src/app/projects/page.tsx
dashboard/src/app/processes/page.tsx

# CoreKit
corekit/brain/process-manage
```

### Modified files

```
# Brain daemon
corekit/daemon/agent-brain.mjs                → Add create_project, assign_to_project,
                                                 follow_process actions to Cortex loop.
                                                 Add context injection to dispatch pipeline.
                                                 Add context backfill on resource creation.
                                                 Add process extraction on mission completion.

# CoreKit config
infra/contracts.json                           → Add projects section
corekit/system/validate-contracts              → Add Check 12

# Manifests
infra/manifests/role-fleet.txt                 → Add process-manage

# Specialty SOULs
specialties/pm/workspace/SOUL.md               → Add Project + Process awareness
specialties/*/workspace/SOUL.md                → Add Process following awareness (all types)

# Dashboard components
dashboard/src/app/work/page.tsx                → Add project filter dropdown
dashboard/src/components/Shell.tsx (or equiv)  → Add Projects + Processes nav options

# Responsibility schema
(brain code that reads responsibilities-job.json) → Support optional processRef field
```

---

## Sequencing

```
Phase 1 (days 1-3):
  1.1  Firestore projects collection
  1.2  projectId on work envelopes
  1.3  context on work envelopes
  1.4  Dashboard API: project CRUD
  1.5  Dashboard API: extend work endpoint
  1.6  Dashboard UI: projects page
  1.7  Dashboard UI: project filter on work page
  1.8  Dashboard UI: project navigation
  1.9  Brain: create_project action
  1.10 Brain: assign_to_project action
  1.11 Brain: context injection
  1.12 Brain: context backfill
  1.13 SOUL updates (PM only)

Phase 2 (days 4-10):
  2.1  Firestore processes collection
  2.2  Dashboard API: process CRUD
  2.3  Dashboard UI: process library
  2.4  Dashboard UI: process navigation
  2.5  Brain: process loader
  2.6  Brain: follow_process action
  2.7  Brain: special step types (delegation, spawn_responsibility, approval_gate)
  2.8  Brain: process extraction
  2.9  Brain: process versioning
  2.10 CoreKit: process-manage tool
  2.11 SOUL updates (all specialties)

Phase 3 (days 11-14):
  3.1  Responsibility → Process reference
  3.2  Project → Process listing
  3.3  Context promotion
  3.4  Dashboard: responsibility → process linking
  3.5  contracts.json extension
```

Each phase is independently deployable. Phase 1 adds value immediately (project organization). Phase 2 adds the highest impact (reusable playbooks). Phase 3 is the glue.

---

## Validation Checklist

After each phase, verify:

**Phase 1:**
- [ ] Operator can create a project from the dashboard
- [ ] Operator can add context entries to a project
- [ ] Operator can assign a mission to a project from the work tree
- [ ] Work tree filters by project
- [ ] Agent-Mira can create a project via chat ("create a project called Q3 Close")
- [ ] Agent-Mira can assign a mission to a project via chat
- [ ] Context appears in the brain's dispatch window when working under a project
- [ ] Context backfills when Motor creates a resource referenced in context

**Phase 2:**
- [ ] Operator can create a process from the dashboard
- [ ] Operator can view the process library
- [ ] Agent-Mira can follow a process via chat ("research competitor Acme using the Competitor Research process")
- [ ] Brain generates M→C→T tree from process steps
- [ ] Parameters substitute correctly into step titles and context
- [ ] Delegation steps hand off to the correct agent (or skip if optional + unavailable)
- [ ] spawn_responsibility steps create working cron entries
- [ ] approval_gate steps pause for human input
- [ ] Process extraction offers to save a process after a qualifying mission completes
- [ ] Process versioning increments on update

**Phase 3:**
- [ ] A responsibility with processRef fires and generates work from the process
- [ ] A project lists its standard processes on the detail page
- [ ] New mission-level context entries show "Promote to project" in the dashboard
- [ ] Promoting a context entry copies it to the project document
- [ ] validate-contracts passes with the new projects section
