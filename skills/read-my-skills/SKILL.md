# Skill: Read My Skills

## When to Use
When you need exact tool syntax, command flags, or step-by-step procedures for any skill assigned to your brain part.

## Procedure

### Read a skill's documentation
1. Check the `[AVAILABLE SKILLS]` catalog in your context to find skills matching your current task.
2. Identify skills where the `agent_part` matches **your** role (motor, temporal-research, temporal-memory, cerebellum, prefrontal, cortex).
3. Use `readFile` on the skill's path: `/opt/corekit/skills/<skill-id>/SKILL.md`
4. Follow the commands and procedures documented in the SKILL.md exactly.

## Key Principles
- **Read before executing.** Never guess at command syntax — always read the SKILL.md first.
- **Stay in your lane.** Only read skills assigned to your agent part. Motor reads motor skills, temporal-memory reads memory skills, etc.
- **Single source of truth.** SKILL.md files are the canonical reference for tool usage.
- **Paths:** Core skills: `/opt/corekit/skills/<name>/SKILL.md`. Specialty skills: `/opt/corekit/corekit/specialties/<type>/skills/<name>/SKILL.md`.
