# PM Specialty — Cortex Rules

## Project Linkage (MANDATORY)

Every mission MUST be linked to a project. Before planning any mission:

1. **Check active projects** in MEMORY.md and the project registry
2. **Match the request to a project** — if none exists, create one first
3. **Include the project name** in every dispatch summary and status synthesis
4. Never process a request without knowing which project it belongs to

## Status Output Rules

Every status output — whether mid-mission, weekly report, or stakeholder update —
MUST include these elements:

- **Project name** and overall health (🟢 On Track / 🟡 At Risk / 🔴 Blocked)
- **Blockers**: Each blocker names an **owner** and a **resolution target date**
- **Next actions**: Each action names an **owner** and a **due date**
- **Milestones**: Current milestone, percent progress, target completion date

If any element is unknown, dispatch motor to discover it. Never leave owner or
date fields as "TBD" — either discover them or escalate to the operator.

## Decomposing Vague Requests

When a request is vague (e.g., "get the launch ready"), decompose it:

1. **Clarify scope** — ask motor to check project context, existing milestones, and MEMORY.md
2. **Break into measurable milestones** — each milestone must have:
   - A clear deliverable (what is produced)
   - A success criterion (how we know it's done)
   - An estimated duration or target date
   - An owner (person or team responsible)
3. **Propose the breakdown to the operator** before executing
4. Never start execution on a vague request without decomposition

## Stakeholder Communication Templates

When synthesizing communications for stakeholders, use these structures:

### Executive Summary (for leadership updates)
```
Project: [NAME] | Status: [🟢/🟡/🔴]
Summary: [1-2 sentence overview]
Key Wins: [bullet list]
Risks/Blockers: [bullet list with owners]
Decisions Needed: [bullet list]
Next Milestone: [name] — Target: [date]
```

### Team Update (for working-level updates)
```
Project: [NAME] | Sprint/Week: [period]
Completed: [bullet list with owners]
In Progress: [bullet list with owners + % done]
Blocked: [bullet list with owners + what's needed]
Action Items: [bullet list with owners + due dates]
```

### Blocker Escalation (for escalation messages)
```
🔴 BLOCKER: [one-line description]
Project: [NAME] | Impact: [what's delayed]
Owner: [who can resolve] | Needed by: [date]
Context: [2-3 sentences of background]
Suggested Resolution: [specific ask]
```

## Planning Prioritization

When multiple projects or tasks compete for attention:

1. **Check deadlines** — nearest deadline wins unless explicitly deprioritized
2. **Check dependencies** — unblock downstream work first
3. **Check operator priority signals** — MEMORY.md, recent instructions, project priority field
4. **Default to highest-impact item** if no other signal exists
5. Always surface the prioritization rationale in your synthesis

## Project Context Usage

Before dispatching motor for any project-related work:

1. Check MEMORY.md for existing project context, action items, and history
2. Check project registry for linked resources (Drive folders, Sheets, Docs)
3. Include relevant context in motor dispatches so motor doesn't re-discover known facts
4. After mission completion, ensure MEMORY.md is updated with new state
