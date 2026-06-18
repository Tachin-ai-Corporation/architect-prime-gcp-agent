# Skill: Culture of Work Tools

## When to Use
When creating, updating, listing, or querying responsibilities, projects, or processes in the R/M/C/T architecture.

## Commands

### Write
- `responsibility-manage` — Manage responsibility configurations.
  - Subcommands: `list`, `create '<json>'`, `update '<id>' '<json>'`, `remove '<id>'`, `toggle '<id>' [on|off]`.
  - Output: Status or configuration JSON.
- `project-manage` — Manage project details and teams in Firestore.
  - Subcommands: `list`, `get '<id>'`, `create '<json>'`, `update '<id>' '<json>'`, `complete '<id>'`, `pause '<id>'`, `archive '<id>'`, `team-add '<id>' '<json>'`, `team-remove '<id>' '<email>'`, `team-list '<id>'`.
  - Output: Status confirmation, team lists, or project JSON.
- `process-manage` — Manage deterministic process definitions in Firestore.
  - Subcommands: `list`, `get '<id>'`, `create '<json>'`, `update '<id>' '<json>'`, `deprecate '<id>'`.
  - Output: Status, version updates, or process JSON.

## Procedures

### Create a new project and add team members
1. Define the project details in a JSON string (with fields like `id`, `name`, `description`, `goal`, `context`).
2. Run `project-manage create '<json>'` to create the project.
3. Add team members by running `project-manage team-add <project_id> "<member_email>" "<role>"`.
4. Verify: Run `project-manage team-list <project_id>` and confirm the team members are added.

### Create and update a responsibility
1. Define a responsibility config as a JSON string containing `id`, `name`, `schedule`, and `instruction`.
2. Run `responsibility-manage create '<json>'` to add it.
3. Verify: Run `responsibility-manage list` and check that the responsibility ID appears.
4. Update the responsibility by running `responsibility-manage update '<id>' '<partial-json>'`.

### Create a process definition
1. Format process steps as a JSON array of step objects, including `title` and `description`.
2. Run `process-manage create '<json>'` specifying `id`, `name`, `description`, and `steps`.
3. Verify: Run `process-manage list` and confirm the process is listed.

---

## Detailed Tool Reference

### responsibility-manage

Manages responsibility configs in `responsibilities-job.json`.
The Brain daemon's cron scheduler auto-reloads changes within 10 seconds.

#### Subcommands

**list** — List all responsibilities
```
exec responsibility-manage list
```

**create** — Create a new responsibility
```
exec responsibility-manage create '<json>' [--process-ref <processId>] [--process-params '<json>']
```
Required JSON fields: `id`, `name`, `schedule`, `instruction`
Required context fields: `context.purpose`, `context.process` (array of steps), `context.success_criteria`
Defaults: `enabled=true`, `min_spacing_minutes=30`

**update** — Update an existing responsibility
```
exec responsibility-manage update '<id>' '<partial-json>' [--process-ref <processId>] [--process-params '<json>']
```
Deep-merges the `context` field; shallow-merges everything else.

**remove** — Remove a responsibility by ID
```
exec responsibility-manage remove '<id>'
```

**toggle** — Enable or disable a responsibility
```
exec responsibility-manage toggle '<id>' [on|off]
```
Without `on`/`off`, flips the current state.

#### Optional flags (create/update)
- `--process-ref <processId>` — Link responsibility to a process definition
- `--process-params '<json>'` — JSON parameter overrides for the process
- Use `--process-ref ""` to clear the process link on update

---

### project-manage

Manages projects stored in Firestore (`projects/` collection).
Projects support hierarchy (parent/child, max depth 4), team management,
standard process linking, and automatic Drive folder provisioning.

#### Drive Folder Provisioning (built-in)

When a mission runs for a project, the brain daemon auto-provisions a Google Drive
folder hierarchy under the installation's artifacts root folder (configured in
Settings → General → Artifacts):

```
{artifacts_root_folder}/
  └── {project-name}/
      └── {prime-or-agent-name}/
          └── {agent-name}/     (per-agent workspace)
```

The root folder ID is stored in `config/settings.artifacts_root_folder_id` (app-level,
shared across all primes and fleet agents). Per-project folders are tracked in
`projects/{id}.context.drive_folder` as a context entry.

#### Subcommands

**list** — List all projects
```
exec project-manage list
```
Shows: id, name, status, description, goal, owner, parent, dependencies, processes.

**get** — Get full project details as JSON
```
exec project-manage get '<id>'
```

**create** — Create a new project
```
exec project-manage create '<json>' [--processes <comma-separated-ids>]
```
Required JSON fields: `id`, `name`, `description`, `context` (object), `goal`
Optional: `owner` (defaults to AGENT_USER_EMAIL), `parent_id`, `depends_on` (array)
Defaults: `status='active'`, timestamps auto-set, team initialized with prime + agent.

Context entries follow the Context Packet schema:
```json
{ "key": { "kind": "sheet|drive_folder|doc|dataset|url|template|people|convention",
           "ref": "resource-id", "url": "https://...", "name": "Display Name",
           "summary": "Description", "updatedAt": "ISO", "updatedBy": "agent" } }
```

**update** — Update a project (partial merge)
```
exec project-manage update '<id>' '<json>' [--processes <comma-separated-ids>]
```
Deep-merges `context`; shallow-merges everything else. Validates `parent_id`
changes (must exist, max depth 4). Valid statuses: `active`, `complete`, `paused`, `archived`.

**complete** — Mark a project as completed
```
exec project-manage complete '<id>'
```

**pause** — Pause a project
```
exec project-manage pause '<id>'
```

**archive** — Archive a project
```
exec project-manage archive '<id>'
```

**team-add** — Add or update a team member
```
exec project-manage team-add <id> <email> <role> [name] [type]
exec project-manage team-add <id> '<json>'
```
JSON must include `email` and `role`. Optional: `name`, `type` (default: `agent`).
If email already exists, the entry is updated in place.

**team-remove** — Remove a team member by email
```
exec project-manage team-remove '<id>' '<email>'
```

**team-list** — List team members in table format
```
exec project-manage team-list '<id>'
```

#### Optional flags (create/update)
- `--processes <comma-separated-ids>` — Set `standardProcesses` array
- `--processes ""` — Clear the standardProcesses list

---

### process-manage

Manages process definitions stored in Firestore (`primes/{primeId}/processes/` collection).
Processes are versioned with automatic changelog tracking.

#### Subcommands

**list** — List all processes
```
exec process-manage list
```
Shows: id, name, status, version, created_by.

**get** — Get full process details as JSON
```
exec process-manage get '<id>'
```

**create** — Create a new process
```
exec process-manage create '<json>'
```
Required JSON fields: `id`, `name`, `description`, `steps` (array, at least 1)

Step schema:
```json
{
  "title": "Step title",
  "description": "What to do",
  "agent": "motor",
  "type": "standard|delegation|spawn_responsibility|approval_gate",
  "optional": false,
  "checkpointBoundary": false,
  "contextTemplate": {}
}
```
Each step requires `title` and `description`; other fields have defaults.

Defaults on create: `status='active'`, `version=1`, `created_at=now`, `updated_at=now`,
`created_by='system'`, `execution_count=0`, `visibility='team'`,
`parameters={}`, `contextTemplate={}`, `changelog=[]`.

**update** — Update a process (deep merge)
```
exec process-manage update '<id>' '<json>'
```
Deep merges: `steps` (full replace), `parameters`, `contextTemplate`.
Auto-increments `version` and appends to `changelog`.
Pass `_changelog_message` in update JSON to set a custom changelog description.

**deprecate** — Mark a process as deprecated
```
exec process-manage deprecate '<id>'
```

#### Process statuses
`active`, `deprecated`

#### Step types
`standard`, `delegation`, `spawn_responsibility`, `approval_gate`
