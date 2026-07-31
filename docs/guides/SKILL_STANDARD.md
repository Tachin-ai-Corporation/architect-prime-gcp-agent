# Skill Standard — Completeness Guide

> **Purpose:** Define what a complete, deployable skill looks like. Grade existing skills. Guide skill creation and improvement.
> **Audience:** Anyone writing, reviewing, or improving a skill — human or agent.
> **Canon reference:** B-16 (five-layer anatomy), B-17 (skill enforcement), 09-SKILL.md (primitive definition)

---

## Grading

Every skill is graded 1–5 based on which layers are present and substantive. The grade is structural — it checks for the presence and density of specific sections, not subjective quality.

| Grade | Layers present | What it means |
|-------|---------------|---------------|
| 1 | Identity only | `skill.json` exists; SKILL.md is a stub. Unusable. |
| 2 | Identity + Commands | Command syntax documented. Motor can call tools but must reason through workflows from scratch. Reference manual. |
| 3 | + Procedures | Multi-step workflows documented. Motor follows a procedure for common cases instead of improvising. Usable. |
| 4 | + Error Recovery | Failure-mode table documented. Motor handles errors structurally instead of retrying blindly. Production-grade. |
| 5 | + Examples | Worked input→output pairs. Motor's chain-of-thought is anchored on known-good patterns. Excellent. |

**Target grades:**
- Every skill: ≥ 2 (no stubs)
- High-traffic skills (workspace-drive, workspace-gmail, workspace-docs, workspace-sheets, workspace-chat, gcp-devops, firebase): ≥ 4
- Skills with measured success rate below 80%: upgrade until success rate exceeds 80%

---

## Layer Specifications

### Layer 1 — Header

```markdown
# Skill: {name}

## When to Use
{One paragraph: the trigger condition. When should an organ reach for this skill?
Be specific — "when a task involves files in Google Drive" not "when working with files."}

## Prerequisites
{Optional. What must be true before this skill works: auth configured, CLI installed,
project context fields present, etc.}
```

**Grading rule:** Present if SKILL.md has a `# Skill:` or `# ` heading and a `## When to Use` section with ≥ 1 sentence.

### Layer 2 — Command Reference

```markdown
## Commands

### Read
- `command-name ARG [--flag VALUE]` — what it does
  Output: {description of what the command returns}

### Write
- `command-name ARG [--flag VALUE]` — what it does
  Output: {description of what the command returns}
```

Group by Read/Write when the skill has both. Include output format — motor needs to know what to parse. Every entry in `skill.json.scripts[]` must have a corresponding entry here.

**Grading rule:** Present if SKILL.md has a section with ≥ 1 command documented with syntax and description. Every `scripts[]` entry has a matching command entry (checked by `validate-skills`).

### Layer 3 — Procedures

```markdown
## Procedures

### {Procedure name — the goal, not the first step}
1. `{command}` → {what to check in the output}
2. If {condition}: `{command}` → {what to check}
3. If {error condition}: {recovery action from Layer 4, or inline}
4. `{command}` → {verify the outcome by a different path than step 1 — re-derive, not re-read (B-28)}

### {Another procedure}
...
```

Each procedure is a numbered sequence that a motor agent follows step by step. The procedure names the goal ("Find a file by name"), not the first step ("Run drive-search"). Include decision points (if/then) and verification steps that re-derive the outcome by an independent route (B-28: verification is re-derivation, not recognition).

**How many procedures:** Cover the 3–5 most common tasks this skill serves. If you're unsure which tasks are most common, check the `skill_miss` and `motor_dispatch` telemetry — the tasks motor is dispatched for most frequently with this skill are the procedures to write.

**Grading rule:** Present if SKILL.md has a `## Procedures` section (or equivalent: `## Diagnostic Procedure`, `## Workflow`, `## Steps`) with ≥ 1 numbered multi-step sequence.

### Layer 4 — Error Recovery

```markdown
## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | No access to resource | Ask user to share with agent's email |
| `404 notFound` | Wrong ID or deleted | Re-search by name |
| `429 rateLimitExceeded` | Too many requests | Wait 30s, retry once |
| Command exits 0 but output empty | Filter too narrow | Broaden search query |
| Timeout after 60s | Service overloaded | Retry once; if still fails, report |
```

Cover the 3–5 most common failure modes. Include both error-code failures (403, 404, 429) and semantic failures (command succeeds but output is wrong). The "Recovery" column is what motor does — not "report the error" but "take this specific action."

**Grading rule:** Present if SKILL.md has a table or list with ≥ 3 error→cause→recovery entries.

### Layer 5 — Examples

```markdown
## Examples

### Example: {task description}
```
Task: "Find the Q3 financial report and download it"

Step 1: drive-search --query "name contains 'Q3' AND name contains 'financial'"
→ Result: [{ id: "abc123", name: "Q3 Financial Report.pdf", mimeType: "application/pdf" }]

Step 2: drive-download abc123 --output /tmp/Q3_report.pdf
→ Result: Downloaded 2.4MB to /tmp/Q3_report.pdf

Step 3: readFile /tmp/Q3_report.pdf
→ Result: [PDF content preview]

Outcome: File found and downloaded. Ready for analysis.
```

### Example: {another task, ideally showing error recovery}
...
```

Each example is a complete task→tool-sequence→output trace. Include at least one example that shows error recovery (a command fails, motor handles it per Layer 4). Examples are the highest-leverage content for motor — LLMs anchor on concrete patterns more reliably than abstract instructions.

**Grading rule:** Present if SKILL.md has ≥ 1 concrete multi-step example with tool calls and expected outputs.

---

## skill.json Completeness Rules

1. **`scripts[]` must list every command the SKILL.md documents.** If the SKILL.md says "use `drive-search`" then `scripts` must include `"drive-search"`. A skill with `scripts: []` when the SKILL.md documents commands is incomplete.
2. **`when_to_use` must be specific enough for catalog matching.** "When working with Drive" is too vague. "When a task involves listing, searching, downloading, uploading, or organizing files in Google Drive" is specific.
3. **`agent_part` must match the organ that actually uses this skill.** A skill with `agent_part: "motor"` should not contain procedures for cerebellum.
4. **`version` must increment on every SKILL.md or skill.json change.** This enables rollback and effectiveness comparison across versions.

---

## Writing a New Skill

1. **Start from a real task.** Don't write skills speculatively. Write them when motor has attempted a class of work ≥ 3 times (from `skill_miss` telemetry) or when an operator identifies a recurring pattern.
2. **Write Layer 3 first.** The procedures are the highest-value content. Write the step-by-step workflow before filling in the command reference — the reference falls out of the procedures naturally.
3. **Test the procedure manually.** Run the commands in the procedure on a real system. Capture the actual output. Use that output in your Layer 5 examples — real output is better than fabricated output.
4. **Add error recovery from experience.** The first version of a skill won't have a complete error table. Add entries as motor encounters failures — each failure is a row in the table.
5. **Use `skill-authoring` for the package.** The `skill-author create` command generates `skill.json` + `SKILL.md` scaffolding. Fill in the layers.
6. **Grade with `validate-skills`.** Run before committing. Target ≥ 3 for new skills, ≥ 4 for high-traffic skills.

---

## Improving an Existing Skill

1. **Check the per-skill telemetry.** Success rate below 80%? High stuck rate? High average tool count? These are signals the procedure is weak.
2. **Read motor's actual tool logs** for recent tasks that used this skill. Where did motor deviate from the procedure? Where did it get stuck? Each deviation is either a procedure gap (add a step) or a motor error (the procedure is fine, the model missed it).
3. **Add the missing layer.** Most skills are Grade 2 (command reference only). Adding procedures (→ Grade 3) is the single highest-leverage improvement. Adding error recovery (→ Grade 4) is the second.
4. **Bump the version.** Compare per-skill success rate before and after. If the new version is worse, roll back.

---

## Template

```markdown
# Skill: {name}

## When to Use
{Trigger condition — when should the organ reach for this skill?}

## Prerequisites
{What must be true: auth, CLI, project context fields, etc. Omit if none.}

## Commands

### Read
- `{command} {args}` — {description}

### Write
- `{command} {args}` — {description}

## Procedures

### {Goal 1}
1. `{command}` → {check}
2. If {condition}: `{command}` → {check}
3. Verify: `{command}` → {expected outcome — re-derive by a different route, not re-read (B-28)}

### {Goal 2}
1. ...

### {Goal 3}
1. ...

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| {error} | {cause} | {specific action} |
| {error} | {cause} | {specific action} |
| {error} | {cause} | {specific action} |

## Examples

### Example: {task description}
```
Task: "{natural language task}"

Step 1: {command}
→ Result: {actual output}

Step 2: {command}
→ Result: {actual output}

Outcome: {what was accomplished}
```
```
