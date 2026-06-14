---
name: skill-introspect
description: "Meta-skill for discovering and reading installed skills. Teaches cortex/prefrontal how to find tool documentation. Universal — every agent type gets this."
---

# Skill Introspection (Meta-Skill)

## Purpose
Teaches brain agents how to discover what skills are available and how to read skill documentation for exact tool syntax.

## VM Layout
- Skill index: built by brain daemon at startup, injected into cortex classify/decide payloads as structured context
- Full skill docs: `/opt/corekit/skills/<name>/SKILL.md`
- Custom skills: `/opt/corekit/workspace/custom-skills/<name>/SKILL.md`
- Skill dependencies: `requires` field in `skill.json`, installed by `skill-setup`

## Key Principle (Canon B-16/B-17)
Tool syntax lives in skills, never in SOUL files. Cortex references skills by name; motor reads the full docs.
