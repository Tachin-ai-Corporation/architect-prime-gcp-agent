# Skill: Skill Introspection

## When to Use
When you need to know what skills are available, what tools motor can use, or exact tool syntax for a dispatch instruction.

## Commands

No executable commands are governed directly by this skill.

## Procedures

### Discover and read skill documentation
1. Check the `skill_index` in the cortex payload to find matching skills.
2. Read the full documentation of a specific skill using `readFile` on `/opt/corekit/skills/<name>/SKILL.md`.
3. Verify: Confirm the target skill's commands and procedures are correctly understood before executing or dispatching the task.

## Key Principles
- **Single Source of Truth:** Skills are the single source of truth for tool documentation (Canon B-16).
- **No Guessing:** Never guess at tool syntax. Refer to the specific skill's SKILL.md.
- **Paths:** Core skills reside in `/opt/corekit/skills/<name>/` and custom/staging skills may reside in `/opt/corekit/workspace/custom-skills/`.
