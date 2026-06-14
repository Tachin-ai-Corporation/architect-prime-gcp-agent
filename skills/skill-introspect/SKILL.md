# Skill Introspection

## Overview
Skills are the single source of truth for tool documentation (Canon B-16).
You discover what's available from the `skill_index` in your cortex payload,
then read specific skill docs on-demand.

## How Skills Work
- **Cortex/Prefrontal**: Receive `skill_index` in every classify/decide payload
  — a structured table of skill name, target agent(s), and when to use
- **All agents**: Can read any skill's full docs on-demand:
  `readFile /opt/corekit/skills/<name>/SKILL.md`
- **Skill files on disk**: `/opt/corekit/skills/<name>/SKILL.md`

## How to Use Skills in Dispatch
1. Check `skill_index` in your payload to find the right skill
2. Reference the skill by name in your dispatch instruction
3. The execution agent reads the SKILL.md for exact syntax

## Discovering Skills
- `skill_index` in cortex payload shows all installed skills
- Custom skills may be at `/opt/corekit/workspace/custom-skills/`
- List all: `ls /opt/corekit/skills/`

## Key Principle
Never guess at tool syntax. Skills are the single source of truth.
