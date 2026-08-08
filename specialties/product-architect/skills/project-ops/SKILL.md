# Skill: Project Operations

## When to Use
When managing projects, processes, or improvement plans — including creating projects, adding team members, defining processes, and tracking progress.

## Commands

No custom corekit scripts are governed directly by this skill (handled via core workspace/work tools).

## Procedures

### Create an Improvement Project
1. Formulate the project details (name, description, goals).
2. Run the creation command:
   ```bash
   project-manage create --name "Improvement: <title>" --description "<scope and goals>"
   ```
3. Link the project to a defined process:
   ```bash
   project-manage update --id <project-id> --process-ref <process-ref>
   ```
4. Verify: Ensure the project is successfully registered in Firestore.

### Bootstrap a Delivery Project (from a chat ask)
When the operator asks you — in a chat space — to **set up / create / stand up a NEW project**
(its own team, and this chat as its channel), you bootstrap it yourself. You do NOT need the
operator to pre-create anything in Firestore.

**The space you received the ask in IS the project's space.** When the request arrived on a space
not yet linked to a project, the decision context surfaces it as `project_bootstrap_available`
(with `origin_space`). Respond with the **`project_bootstrap`** action:
```jsonc
{
  "action": "project_bootstrap",
  "project": {
    "name": "1health Website",
    "description": "…",
    "goal": "Ship the single-page site to production via draft → staging → prod",
    "team": [
      { "role": "engineer", "specialty": "engineer",   "responsibilities": "page code + commits" },
      { "role": "devops",   "specialty": "devops",     "responsibilities": "GCP + staging/prod deploy" },
      { "role": "designer", "specialty": "designer",   "responsibilities": "design drafts" }
    ],
    "canon":   [ { "key": "deploy-flow", "text": "draft → staging (share URL) → owner approval → prod" } ],
    "context": [ { "key": "source", "kind": "drive", "ref": "<drive-file-id>", "summary": "the site HTML" } ],
    "deploy":  {
      "platform": "firebase-hosting",
      "gcp_project": "your-gcp-project",       // firebase --project (the GCP/Firebase project)
      "hosting_site": "your-hosting-site",     // firebase --site (the deploy TARGET; NOT the project)
      "source": { "kind": "drive", "ref": "<drive-file-id>" },
      "flow": "staging channel → share URL → owner approval → promote to live"
    }
  }
}
```
**The `deploy` block is how the devops teammate knows WHERE to ship.** Name the Hosting **site**
(the `--site` deploy target) and the GCP/Firebase **project** (`--project`) as **separate** fields —
they are often different (a site `your-hosting-site` can live under project `your-gcp-project`), and
conflating them deploys to the wrong place. Give `source` the canonical content locator (a Drive file
id or a git repo) so the deploy fetches the real content, not an empty dir. The devops agent reads
this verbatim — it does not guess the site.
What the system does deterministically: creates `projects/{id}` bound to this space, resolves each
teammate's **real** fleet email from the roster (name them by role/specialty — never write an
email yourself), seeds the team/canon/context, and **re-scopes this mission to the new project**.
It is idempotent — if a project is already bound to this space, it is adopted, not duplicated.

After it returns, **keep going in the same mission**: plan the actual delivery with `checkpoint_plan`
and delegate to the team. Your delegations now route through this space automatically.

**The one thing you cannot do:** add teammates as *members* of the chat space (that needs operator
/ Chat-admin rights). If a delegation later reports it was *not delivered*, the teammate isn't in
this space — use `needs_input` to ask the operator to add that exact address, then continue.

Never route a new project's work through some *other* project's space — bind to the space the ask
came from, or ask the operator.

### Keep the project's context current (do this automatically — don't wait to be asked)
A project you own or lead is a **living record**. Keep it accurate as the work moves so the next
mission — yours or a teammate's — starts from the truth, not a stale snapshot. After any of the
triggers below, update the project yourself with `project-manage`. Each tool is idempotent
(re-setting the same key/member updates in place), so it is always safe to refresh.

| When this happens | Update | Command |
|---|---|---|
| A member joins, leaves, or their role / responsibilities change | the team | `project-manage team-add <id> <email> <role> [name] [type]` (updates in place if the email is already on the team; use the JSON form `team-add <id> '{"email":"…","role":"…","name":"…","type":"agent","responsibilities":"what they do"}'` for a plain-language duty). Remove with `project-manage team-remove <id> <email>`. |
| A durable, authoritative fact is set or changes (source of truth, a required access, a lasting convention, the deploy flow) | canon | `project-manage canon-set <id> <key> "<one durable fact>"` — re-set the same key to update it |
| A lasting resource is created or moved (a Drive folder, a repo, a doc/sheet, a stable URL) | context packet | `project-manage add-context <id> <key> '{"kind":"drive_folder|repo|doc|sheet|url|convention","ref":"<id-or-url>","name":"…","summary":"<durable fact>"}'` |
| The deploy target is established or changes | the deploy descriptor | `project-manage update <id> '{"deploy":{"platform":"firebase-hosting","gcp_project":"<project>","hosting_site":"<site>","source":{"kind":"drive|git","ref":"<id>"},"flow":"…"}}'` (keep hosting site and GCP project as SEPARATE fields — see Bootstrap) |
| A secret becomes a required input (an API token, a deploy credential) | canon — **by reference only (C-8)** | `project-manage canon-set <id> <key> "Requires secret 'aps-secret-<name>'; read at use time via secret-read. Never store or paste the value."` The value stays in the secret store; the project points only at its **name**. |

**What does NOT belong in project context** (the shared validator will silently drop it): this run's
document/mission ids, transient state ("repo is at commit X", "staging currently shows Y"), history or
past failures, or a sequence of steps / a procedure. Those belong to the mission/artifact, a process,
or nowhere. Project context is the durable **40,000-ft view any future mission would reuse** (C-28).

**Don't duplicate the machine.** The daemon already auto-mines durable facts from a completed
mission's output into project context. Before adding, check what's already there
(`project-manage get <id>`, `canon-list <id>`, `team-list <id>`) and only add what's genuinely missing.

**Verify:** re-read with `project-manage get <id>` (or `canon-list` / `team-list`) and confirm the
entry reads back as intended.

### Propose an Improvement Plan
1. **Audit:** Read target files and identify the improvement opportunity.
2. **Draft:** Write the plan as a structured document containing scope, before/after description, rubric claim, acceptance criteria, and risk notes.
3. **Publish:** Upload the plan to Drive via `drive-upload`.
4. **Gate:** Submit the plan for user approval before delegating.

### Manage Responsibilities
1. List active responsibilities using `responsibility-manage list`.
2. Run updates to include new learnings:
   ```bash
   responsibility-manage update --id <responsibility-id> --prior-learnings "<new learnings>"
   ```
3. Enable or disable a responsibility as needed using `responsibility-manage update --id <id> --enabled true/false`.
4. Verify: Confirm the update successfully registers and reloads.

### Track Delegation Progress
1. Check active missions delegated by this agent:
   ```bash
   work-log-read --status active --owner <agent-email>
   ```
2. Check waiting envelopes (delegations in progress) using `work-log-read --status waiting --owner <agent-email>`.
3. Read specific delegation results using `work-log-read --id <envelope-id>`.

## Best Practices
- Always create a project before starting an improvement cycle.
- Link the project to the relevant process for traceability.
- Update `prior_learnings` on the responsibility after each cycle — this is how the agent learns. (The daemon also machine-feeds dated learnings from mission compaction digests into the `responsibility_state` Firestore overlay; your hand-authored guidance and the machine-fed lines are merged at fire time — do not duplicate them.)
- Close projects when the improvement is verified and deployed.
