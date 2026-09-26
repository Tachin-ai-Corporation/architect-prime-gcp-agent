# Skill: Culture of Work Tools

## When to Use
When creating, updating, listing, or querying responsibilities or projects in the R/M/C/T architecture. Also for reading work and task logs.

## Commands

### Read
- `task-log-read [--last <n>] [--agent <name>] [--task <taskId>]` — Read recent task records from Firestore.
  Output: JSON array of task records containing status, agent, and output details.
- `work-log-read [--hours <n>] [--owner <name>] [--self] [--recent <n>] [--status <status>] [--type <type>] [--min-steps <n>] [--mission <id>] [--limit <n>] [--json] [--verbose]` — Query recent work envelopes (missions, checkpoints, responsibilities) from Firestore.
  Output: Table or JSON representation of work envelopes including dispatches, outcomes, and timestamps.
  Use `--self` to scope to **your own** work, and `--recent <n>` for "my last N missions" (implies `--type M`, a 30-day window). `--status failed` (or `blocked`) narrows to what went wrong.
  Use `--mission <id>` to inspect ONE mission's full M→C→T tree **plus its step ledger** (per-task attempts with their errors — the richest signal for *why* it failed) with bounded reads (one GET per envelope) — do NOT widen `--hours` to hunt for a single mission's children; that pulls the whole fleet's window and can exhaust your budget.
- `work-output-read <envelope-id> [--json]` — Read the full output of a work envelope from Firestore. Use this to recover truncated delegation results or inspect mission output.
  Output: Formatted header (status, type, title, timestamps) followed by full output text. With `--json`: raw JSON with all fields.

### Write
- `responsibility-manage` — Manage **your own** responsibilities (your recurring duties). Changes go to your responsibility store and are live within a minute, with no Prime and no upgrade, and they survive upgrades.
  - Subcommands: `list`, `show '<id>'`, `create`, `update '<id>'`, `toggle '<id>' [on|off]`, `remove '<id>'`, `reset '<id>'`, `adopt '<id>'`, `history '<id>'`, `revert '<id>' --to <n>`.
  - Output: What changed and the new revision (`--json` for machine-readable).
- `project-manage` — Manage project details and teams in Firestore.
  - Subcommands: `list`, `get '<id>'`, `create '<json>'`, `update '<id>' '<json>'`, `complete '<id>'`, `pause '<id>'`, `archive '<id>'`, `team-add '<id>' '<json>'`, `team-remove '<id>' '<email>'`, `team-list '<id>'`, `add-context '<id>' '<key>' '<value>'`.
  - Output: Status confirmation, team lists, or project JSON.

## Procedures

### Create a new project and add team members
1. Define the project details in a JSON string (with fields like `id`, `name`, `description`, `goal`, `context`).
2. Run `project-manage create '<json>'` to create the project.
3. Add team members by running `project-manage team-add <project_id> "<member_email>" "<role>"`.
4. Verify: Run `project-manage team-list <project_id>` and confirm the team members are added.

### Take on a new recurring duty (create a responsibility)
Use this when someone asks you to do something on a schedule ("every Monday, send the ops summary") or on an event ("when a mission gets blocked, write a review").
1. Write the definition as JSON: `id` (`r-<name>`, lowercase with dashes), `name`, `schedule` (five-field cron) with `timezone` (IANA zone, e.g. `America/Chicago`) **or** `event` (`on_complete` / `on_failure`), `instruction`, `success_criteria`, `context.purpose`, and `context.process` (the steps). Put any ids it depends on (folders, docs) in a **project** and set `project_id`, never in the text.
2. Create it, passing free text on stdin: `responsibility-manage create --note "<who asked, and why>" --stdin` with the JSON as the tool's stdin.
3. Verify: `responsibility-manage list` shows it with its schedule and `agent-owned (rev 1, …)`.

### Change one of your responsibilities
1. `responsibility-manage list` shows every responsibility you run and where it comes from: a shipped default, a default you've overridden, or your own.
2. Change only the fields that should change: `responsibility-manage update r-<id> '{"schedule":"20 10 * * 4","timezone":"America/Chicago"}'`. On a shipped default this stores an override of just those fields, so later product fixes to the rest still reach you.
3. Pause or resume: `responsibility-manage toggle r-<id> off` (or `on`).
4. Verify: `responsibility-manage show r-<id>` shows the new values and revision.
5. Undo: `responsibility-manage history r-<id>`, then `responsibility-manage revert r-<id> --to <n>`. To drop every change you made to a shipped default, run `reset`.

You cannot change platform upkeep (nightly memory consolidation, git cleanup). Those are `locked` and change only through a platform release.

### Query an agent's recent task history
1. Identify the agent name (e.g., `stan`).
2. Run `task-log-read --agent stan --last 10` to view the last 10 task records for that agent.
3. Verify: Check that the output contains a JSON list of tasks executed by the specified agent.

### Inspect completed work envelopes
1. Define the timeframe (e.g., last 48 hours).
2. Run `work-log-read --hours 48 --status complete` to list all completed envelopes.
3. Verify: Confirm the output displays a list of completed missions or responsibilities with completion status.

### Analyze my own recent work / diagnose a failed mission
Use this when a task asks you to review, learn from, or report on your own past work — especially failures (recall gives outcome-level context; this is the tool for per-task depth).
1. List your recent missions: `work-log-read --self --recent 10` — note the ones marked failed/blocked and copy the mission id you care about.
2. Drill the failure: `work-log-read --self --mission <id>` — this prints the M→C→T tree AND the **step ledger** (each task attempt's status, error, and timing). The step-ledger errors are the concrete "why" (tool error, verification rejection, missing input).
3. If an envelope's output is truncated, pull it in full with `work-output-read <envelope-id>`.
4. Classify each failure by its root cause and, if the fix belongs in the product (a skill, a tool, a daemon), surface it to your Prime/operator with the mission id and the exact error as evidence (B-29 — cite what you observed, not what you infer).

---

## Detailed Tool Reference

### responsibility-manage

Authors **your own** responsibilities. It writes your responsibility store in Firestore, beside your Core Memory. The scheduler re-reads that store every minute and runs it over the defaults your role ships with. A change needs no Prime and no upgrade, it survives upgrades and VM rebuilds, and every change is a revision you can undo. It never edits an installed file.

What you run is three layers:
- **Platform upkeep** (`locked`): nightly memory consolidation, git cleanup. You can't change these.
- **Your role's defaults**: you can override fields, pause them (`toggle`), drop your changes (`reset`), or take one over completely (`adopt`, after which you stop receiving product updates to it).
- **Your own**: ones you created. You can do anything with these.

#### Subcommands

```
exec responsibility-manage list                         # everything you run, and where each comes from
exec responsibility-manage show '<id>'                  # one responsibility as it runs, plus its store record
exec responsibility-manage create --stdin               # JSON on stdin (shell-safe); or '<json>' / --file <path>
exec responsibility-manage update '<id>' '<json>'       # only the fields that change; context merges key by key
exec responsibility-manage toggle '<id>' [on|off]       # without on/off, flips it
exec responsibility-manage remove '<id>'                # one you created (a shipped default: toggle off or reset)
exec responsibility-manage reset '<id>'                 # back to the shipped default
exec responsibility-manage adopt '<id>' ['<json>']      # make a shipped default fully yours
exec responsibility-manage history '<id>'               # every revision: who, when, what
exec responsibility-manage revert '<id>' --to <n>       # restore revision n (as a new revision)
```

Options: `--note "<why>"` records the reason on the revision, and `--json` gives machine-readable output. On create and update, `--process-ref <playbook-id>` links a playbook (`""` clears it) and `--process-params '<json>'` carries parameters.

**create requires** `id`, `name`, `schedule` (five-field cron) **or** `event` (`on_complete` / `on_failure`), `instruction`, `success_criteria`, `context.purpose`, and `context.process` (array of steps). Defaults are `enabled: true` and `min_spacing_minutes: 30`. `timezone` is an IANA zone (default `UTC`).

**Refused, with the reason printed:**
- A cron form the scheduler can't read. Use `*`, `*/N`, numbers, `a-b`, `a,b`. Names like `MON` and `7` for Sunday are refused.
- An unknown timezone.
- A schedule that fires more often than every 15 minutes.
- Any change to a `locked` responsibility.
- Owning more than 25 responsibilities.
- Creating an id your role already ships. Use `update` or `adopt` instead.

If you and someone else edit the same responsibility at the same moment, one of you gets "changed at the same moment — run the command again".

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

**add-context** — Persist a project discovery (institutional memory)
```
exec project-manage add-context '<id>' '<key>' '<value-or-json-packet>'
```
The value may be a plain string or a JSON packet (e.g. `{"kind":"drive_folder","ref":"<id>","summary":"<description>"}`).
Persist a discovery immediately when execution teaches you something a future mission on the same project would need:

| Discovery type | Example |
|---|---|
| Permission requirement | `project-manage add-context '<project_id>' 'sync_folder_requires_editor' 'Editor access required for all agents uploading to the sync folder'` |
| Verified command or path | `project-manage add-context '<project_id>' 'deploy_command_verified' 'firebase deploy --project your-website-project --only hosting'` |
| Resource ID (Drive folder, URL) | `project-manage add-context '<project_id>' 'assets_folder' '{"kind":"drive_folder","ref":"<id>","summary":"shared assets"}'` |
| Failure mode | `project-manage add-context '<project_id>' 'css_build_step_required' 'AVOID: deploying raw source; must run npm run build first'` |

Context is the project's institutional memory — if a **durable** fact would save the next agent time on this project, write it. **C-28 layer purity:** context holds only 40,000-ft working-area references — durable resources and lasting conventions. It is NOT for mission particulars (a specific doc id, this run's result → the Mission record), history/failures, transient state ("repo is at commit X"), or step sequences (→ a Process). Values must be resource packets; `add-context` rejects off-layer keys. To point a project at the processes that apply to it, use `add-process` / `--processes`, not context.

#### Optional flags (create/update)
- `--processes <comma-separated-ids>` — Set `standardProcesses` array
- `--processes ""` — Clear the standardProcesses list

## Project Files
Project artifacts are stored in the project's git artifact repo (C-24). The daemon
automatically clones the repo into `shared/{missionId}/` at mission start and commits
at checkpoint boundaries. For the full clone→commit→sync loop, see the **workspace-git** skill.
