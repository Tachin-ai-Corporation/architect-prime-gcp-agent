# DevOps Specialty — Motor Operational Rules

## Infrastructure Discovery First
Before performing infrastructure changes, always discover current state first.
Never assume resource names, service accounts, or project numbers.

## Service Account Workflow
When a service account is needed:
1. List existing SAs — don't create duplicates.
2. Check if a suitable one already exists.
3. If not, create one with a descriptive display name.
4. Grant only the required roles — least privilege.
5. Report the actual email from create/list output — never fabricate one.

## Deployment Verification
After any deployment:
1. Verify the artifact registry repo exists before building.
2. After deploy, describe the service to confirm it's running.
3. Test the endpoint with a health check.

## API Enablement
Before using any GCP API, verify it's enabled first. Enable if needed.

## Error Recovery
When errors occur, follow this pattern:
- **Permission denied (403)**: Discover the actual IAM policy, report exact SA + missing role.
- **API not enabled**: Discover enabled services, enable the missing one.
- **Quota exceeded**: Report quota name + current usage.
- **Resource not found**: Verify the name, check correct project/region.

## Workspace Convention

### Git Workspace (Primary — automatic)
The Brain daemon automatically manages your git workspace for project missions:
- **Clone + branch**: On mission start, the daemon clones the project repo — its `main` branch plus your `mission/{missionId}` branch — into `shared/{missionId}/`. You do NOT need to re-clone it.
- **Inputs are NOT auto-present**: Do not assume that files produced by an upstream teammate, or files named in your delegated instruction, are already in that clone. Before you depend on a named input file, verify it exists in your workspace; if it does not, obtain it as your instruction directs (e.g. the shared Project-Context workspace, or the git ref named in the instruction), then proceed.
- **Commit + sync**: After each checkpoint, your work is committed and synced to the git ether
- **Merge**: On mission completion, your branch is merged to `main`
- Write all work products to the `shared/{missionId}/` directory — they are automatically tracked
- Use `work-status` to check uncommitted changes, `work-diff` to review, `work-log` to see history

### Drive Workspace (Stakeholder-Facing)
- **Publish artifacts**: Use `work-publish` for sharing work products with stakeholders via Drive
- **Project work**: `work-publish <file> --project <project-id>` → uploads to `{project}/{MM-DD}/`
- **Personal work**: `work-publish <file>` → uploads to `{prime}/{agent}/{MM-DD}/`
- **Read/browse**: Use `drive-ls`, `drive-download`, `drive-search` as normal
- Drive publishing also happens automatically on mission completion

## Project Context Discovery

When you discover a fact about a project during execution that would help future missions, persist it immediately:

| Discovery Type | Command |
|---|---|
| Permission requirement | `project-manage add-context '<project_id>' '<key>' '<what you learned>'` |
| Working command/path | `project-manage add-context '<project_id>' '<key>' '<verified command or path>'` |
| Resource ID (Drive folder, URL) | `project-manage add-context '<project_id>' '<key>' '{"kind":"drive_folder","ref":"<id>","summary":"<description>"}'` |
| Failure mode | `project-manage add-context '<project_id>' '<key>' 'AVOID: <what failed and why>'` |

Examples of useful discoveries:
- `sync_folder_requires_editor` → "Editor access required for all agents uploading to sync folder"
- `deploy_command_verified` → "firebase deploy --project your-website-project --only hosting"
- `staging_url` → "your-website-project--staging-abc123.web.app"
- `css_build_step_required` → "Must run npm run build before deploying; raw source files won't work"

**Rule:** If you learn something that would save the next agent time on this project, write it to project context. Don't rely on mission output alone — context is the project's institutional memory.

## Tachin Sync-Service Operations

When working on the public file service (project `tachin-public-files`), these are the verified endpoints:

| Operation | Method | URL |
|---|---|---|
| Trigger full sync | POST | `https://sync-service-m32774wz2q-uc.a.run.app/sync-all` |
| Renew Drive watch | POST | `https://sync-service-m32774wz2q-uc.a.run.app/renew-watch` |
| Health check | GET | `https://sync-service-m32774wz2q-uc.a.run.app/health` |

- `/sync-all` returns JSON with `syncedFiles`, `ignoredFiles`, `deletedFiles` arrays
- `/renew-watch` returns JSON with renewed watch channel details
- Use `web-fetch` tool to call these endpoints, NOT `run_command` with curl
- GCS bucket: `tachin-website-assets`, public URL: `https://tachin-website.web.app/public/`

