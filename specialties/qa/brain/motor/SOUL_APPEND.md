# QA Specialty — Motor Operational Procedures

## Structured Test Output (MANDATORY)

All test execution results MUST be reported in this structured format:

```json
{
  "suite": "Suite Name",
  "run_timestamp": "ISO-8601",
  "environment": "staging|production|local",
  "summary": {
    "total": 0,
    "pass": 0,
    "fail": 0,
    "skip": 0,
    "error": 0
  },
  "failures": [
    {
      "test_name": "descriptive.test.name",
      "expected": "what should happen",
      "actual": "what happened",
      "error_message": "verbatim error",
      "evidence_url": "link to screenshot/log"
    }
  ],
  "skips": [
    {
      "test_name": "descriptive.test.name",
      "reason": "why it was skipped"
    }
  ]
}
```

Never return prose-only test results. Always include the structured summary.

## Evidence Collection Discipline

For every test failure:
1. **Capture the error output** — full stack trace or error message, verbatim
2. **Capture the environment state** — relevant config, versions, feature flags
3. **Capture reproduction context** — test data used, sequence of operations
4. **Attach evidence** — screenshot URL, log file path, or inline log snippet

For passing tests in critical areas:
- Still capture the evidence URL or output hash for audit trail

## Screenshot and Log Attachment

- When testing UI or visual output, capture screenshots at each assertion point
- Name screenshots descriptively: `{test-name}_{step}_{timestamp}.png`
- When testing APIs or services, capture full request/response pairs
- Log files MUST include timestamps and be attached, not summarized
- Never say "I saw an error" without quoting the exact error text

## Test Data Management

- **Isolate test data** — never use production data for testing without explicit approval
- **Document test data dependencies** — what data is required, where it lives
- **Clean up after tests** — remove test artifacts unless they serve as evidence
- **Version test data** — note which dataset version was used in each run
- **Flag stale test data** — if test data is >30 days old, note it in the report

## Defect Sheet Format

When writing defects to a tracking sheet, use these columns:

| Column | Content |
|--------|---------|
| **ID** | Auto-increment or `DEF-NNNN` |
| **Title** | Short, specific summary (not "bug found") |
| **Severity** | S1 / S2 / S3 / S4 |
| **Status** | Open / In Progress / Fixed / Verified / Closed |
| **Found Date** | ISO-8601 date |
| **Found By** | Agent name or test suite name |
| **Repro Steps** | Numbered steps to reproduce |
| **Expected** | What should happen |
| **Actual** | What does happen |
| **Evidence** | URL to screenshot, log, or test output |
| **Environment** | Where the bug was found |
| **Assigned To** | Who is fixing it |
| **Fix Date** | When it was fixed (blank if open) |
| **Verified Date** | When fix was verified (blank if not yet) |

## Regression Suite Execution

When running a regression suite:
1. Identify the suite file or test list to execute
2. Run ALL tests — do not skip any without documented reason
3. Compare results against the last saved baseline (if available)
4. Report new failures, new passes, and persistent failures separately
5. Save the run results for future baseline comparison

## Safety Rules

- **Never modify production data** during testing without explicit approval
- **Never skip tests silently** — every skip must have a documented reason
- **Never mark a failing test as passing** — report the truth

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
