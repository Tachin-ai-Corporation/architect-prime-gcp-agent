# Skill: Skill Authoring

## When to Use
When creating new skills or modifying existing skill packages, generating template directories, or validating packages against the standard.

## Commands

### Write
- `skill-author create --id <id> --name <name> --description <desc> --agent-part <part> --category <cat> --when-to-use <when> [--origin <origin>] [--author <author>] [--output-dir <dir>] [--skill-md <content>]` — Generate a new skill package (`skill.json` + `SKILL.md`) in the output directory.
  Output: Status confirmation of files created.
- `skill-author validate --dir <skill-dir>` — Validate an existing skill package structure and contents.
  Output: Validation pass message or detailed error checklist.
- `skill-author list-parts` — List the valid agent part values allowed in skill configuration.
  Output: Plain text list of valid agent parts.

## Procedures

### Create and validate a new skill package
1. Identify the new skill's details (ID, name, category, when to use, agent part).
2. Run `skill-author create` with the required flags to generate the initial files:
   ```bash
   exec skill-author create \
     --id firebase-deploy-check \
     --name "Firebase Deploy Verification" \
     --description "After running firebase deploy, fetch the deployment URL and verify the page loads correctly." \
     --agent-part cerebellum \
     --category verification \
     --when-to-use "After any Firebase Hosting deployment to verify the site is live"
   ```
3. Edit the generated `SKILL.md` in the output directory to document commands, procedures, error tables, and examples.
4. Run `skill-author validate --dir workspace/skill-staging/firebase-deploy-check` to verify completeness.
5. Verify: Ensure the validation tool outputs a PASS result.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `validate` fails with `ERRORS` | Missing required fields in `skill.json` or a stub/incomplete `SKILL.md` | Read the validation error output, update the missing fields in `skill.json` or flesh out the required sections in `SKILL.md`, and re-run the validation. |
| `create` fails with output directory not writable | Target directory does not exist or lacks write permissions | Ensure the `--output-dir` points to a path within your active workspace and that you have appropriate write permissions. |
| `create` fails with invalid `agent-part` | Specified part is not supported | Run `skill-author list-parts` to view the list of supported parts (e.g. `motor`, `cerebellum`), select a valid one, and retry the command. |
