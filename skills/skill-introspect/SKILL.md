# Skill Introspection

## Overview
You see a **skill index** in your TOOLS.md — a table of skill names and when to use them. Each skill is fully documented with exact tool syntax, examples, and usage patterns. Motor, cerebellum, and temporal-research agents have the full skill documentation injected into their context.

## How Skills Work
- **Your view (cortex/prefrontal):** Skill index — name, target agent, when to use
- **Motor's view:** Full SKILL.md with exact command syntax, arguments, examples
- **Skill files on disk:** `/opt/corekit/skills/<skill-name>/SKILL.md`

## How to Use Skills in Dispatch
When dispatching motor to use a tool governed by a skill:
1. Reference the skill by name in your instruction — e.g. "Use the project-management skill to add a team member"
2. Motor has the full docs and knows the exact syntax — you don't need to specify command arguments
3. If you need to understand a skill's capabilities before deciding, dispatch motor to read the skill: `readFile /opt/corekit/skills/<name>/SKILL.md`

## Discovering Skills
- Your TOOLS.md skill index shows all installed skills for this agent type
- Custom skills may be installed at `/opt/corekit/workspace/custom-skills/`
- Each skill's `SKILL.md` is the authoritative reference for its tools

## Key Principle
Never guess at tool syntax. Skills are the single source of truth for tool usage. If you don't know how a tool works, the skill documentation tells you.
