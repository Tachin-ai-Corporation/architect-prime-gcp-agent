# Primitive: Skill

**Disk path:** `skills/{skillId}/` (core) or `specialties/{specialty}/skills/{skillId}/` (specialty)
**Installed path:** `/opt/corekit/skills/{skillId}/`

A Skill is **codified procedure** — a solved problem, written down. It occupies the deliberate middle of the determinism spectrum: too contextual to hardcode in the daemon, too settled to leave to LLM improvisation. A skill teaches an organ how to accomplish a class of work using the tools available to it, including when things go wrong.

A skill is not a tool. A tool is `drive-search`. A skill is *how to find a file in Drive when you have a name but not an ID* — the procedure that chains search → filter → download and handles "no results," "multiple results," and "permission denied." Tools are atoms; skills are molecules.

---

## Package Structure

A skill is a directory containing two required files:

```
skills/{id}/
  skill.json       # Identity and machine contract
  SKILL.md         # Procedure documentation (what the organ reads)
```

Some skills also contain scripts (executable tools) installed to `/opt/corekit/bin/` by the manifest.

---

## skill.json — Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique identifier (lowercase, hyphens: `workspace-drive`) |
| `name` | `string` | Yes | Human-readable name |
| `version` | `number` | Yes | Incremented on every change |
| `description` | `string` | Yes | What this skill does (one sentence) |
| `agent_part` | `string` | Yes | Which organ uses this skill: `motor`, `cerebellum`, `prefrontal`, `temporal-research`, `temporal-memory`, `cortex` |
| `origin` | `string` | Yes | `core` (universal), `specialty` (per-type), `learned` (created by an agent) |
| `category` | `string` | Yes | Grouping: `workspace`, `fleet`, `search`, `memory`, `infrastructure`, `verification`, `planning`, `custom` |
| `when_to_use` | `string` | Yes | One-line trigger condition (injected into the skill catalog) |
| `scripts` | `string[]` | Yes | Every command this skill governs. Empty only if the skill has no executable tools (e.g. `plan-structuring`, `verification`) |
| `tools` | `ToolDef[]` | No (MCP phase) | Typed input schemas per script, for MCP exposure |

### ToolDef (future, MCP phase)

```typescript
{
  name: string;                    // Script name (must match a scripts[] entry)
  description: string;             // What the tool does
  input_schema: JSONSchema;        // Typed arguments
  output_hint?: string;            // What the output looks like
}
```

---

## SKILL.md — Procedure

The SKILL.md is what the organ reads before acting. It has five layers, each serving a different moment in the organ's execution:

### Layer 1: Header
What the skill does and when to use it. One paragraph. Matches `skill.json.when_to_use` but may elaborate.

### Layer 2: Command Reference
Exact syntax for every command the skill governs: name, arguments, flags, output format. This is the minimum viable SKILL.md — every skill must have this if it has `scripts[]`.

### Layer 3: Procedures
Multi-step workflows for the 3–5 most common tasks this skill serves. Each procedure is a numbered sequence: do this → check this → if X then Y → if error then Z. This is what the organ follows for the 80% case instead of reasoning from scratch.

A skill without procedures is a reference manual. A skill with procedures is a training program.

### Layer 4: Error Recovery
A table of failure modes: symptom → likely cause → recovery action. The organ reads this when a command fails, instead of retrying blindly or guessing at alternatives.

### Layer 5: Examples
2–3 concrete input→output pairs showing the skill in action end-to-end. These anchor the organ's chain-of-thought more reliably than abstract instructions.

**Not every layer is always needed.** A simple skill (fleet-fire: one command, one purpose) needs Layers 1–2 and an error table. A complex skill (workspace-drive: 10 commands, dozens of workflows) needs all five. The SKILL_STANDARD guide defines the threshold.

---

## Lifecycle

```
Improvisation → Pattern → Draft → Review → Skill → Deployed → Measured → Improved
```

1. **Improvisation.** An agent solves a problem without a skill, reasoning from tools alone.
2. **Pattern.** The same class of problem appears repeatedly (detected via skill-miss telemetry or operator observation).
3. **Draft.** A skill package is created via `skill-authoring` — by a human, by Prime's skill-gap analysis, or by the agent that discovered the pattern.
4. **Review.** The draft is reviewed against the SKILL_STANDARD; `validate-contracts` (Check 14b/14c) enforces that every declared command is documented.
5. **Skill.** The package is committed to the repo.
6. **Deployed.** The manifest installs it to agents. The skill catalog advertises it.
7. **Measured.** Per-skill telemetry (success rate, stuck rate, tool count, duration) tracks effectiveness.
8. **Improved.** Skills with low effectiveness are upgraded — better procedures, better error recovery, better examples. The cycle repeats.

Know-how flows in one direction: improvised solutions that prove out are promoted into skills, never left as private habits. Memory is what one agent has lived; skills are what the system has learned.

---

## Skill Discovery and Resolution

Skills are discovered at three levels:

1. **Cortex/Prefrontal** receive the `skill_index` in every classify/decide payload — a structured table of skill name, target organ, and when to use. They reference skills by name in dispatch instructions.
2. **Motor/Cerebellum/Temporal-Research** receive the `[AVAILABLE SKILLS]` catalog in their system prompt, listing every installed skill with a `readFile` path. They read the SKILL.md before their first tool call.
3. **The daemon** owns skill resolution: before dispatch, it resolves the work against the installed skill set. An applicable skill is injected into the organ's context. Improvising beside an applicable skill is a B-17 violation.

---

## Relationship to Other Primitives

| Primitive | Relationship |
|-----------|-------------|
| **Process** | Process steps reference skills by name. A step's `description` says "Using the workspace-drive skill, ..." The skill defines *how*; the process defines *when* and *in what sequence*. |
| **Task** | A Task is dispatched to an organ. The organ reads the skill's SKILL.md to know how to execute. The skill's procedures define the expected approach; the task's `accept_criteria` define the expected outcome. |
| **Responsibility** | A scheduled Responsibility may wire to a process that references skills, or may fire a task that directly uses a skill. The skill is the procedure the agent follows regardless of how the work was initiated. |
| **Artifact** | A skill may produce Artifacts (files in `shared/`). The skill's procedures document what artifacts to create and where to put them. |

---

## Canon References

- **B-16:** Skills are codified procedure — the layer between code and judgment
- **B-17:** Where a skill exists, skill use is enforced — across every organ
- **C-10:** Skills live in the `skills/` module (core) or `specialties/` module (specialty)
- **C-9:** Manifest discipline installs skills to agent VMs
- **C-14:** The eight primitives are a closed set → Skill is the ninth

---

## Example

### skill.json
```json
{
  "id": "workspace-drive",
  "name": "Google Drive",
  "version": 2,
  "description": "Interact with Google Drive — list, search, download, upload, create folders, rename, move, delete, and share files.",
  "agent_part": "motor",
  "origin": "core",
  "category": "workspace",
  "when_to_use": "When a task involves files in Google Drive — listing, searching, downloading, uploading, organizing, or sharing.",
  "scripts": ["drive-ls", "drive-search", "drive-download", "drive-upload", "drive-mkdir", "drive-rename", "drive-move", "drive-delete", "drive-share"]
}
```

### SKILL.md (abbreviated)
```markdown
# Skill: Google Drive

## When to Use
When a task involves files in Google Drive — listing, searching, downloading, uploading, organizing, or sharing.

## Commands
- `drive-ls [FOLDER_ID] [--max 20]` — list files in a folder
- `drive-search --query "name contains 'report'"` — search files
...

## Procedures

### Find a file by name
1. `drive-search --query "name contains '<name>'"` → note the file ID
2. If no results: broaden to `fullText contains '<name>'`
3. If multiple results: filter by mimeType or modifiedTime
4. `drive-download <FILE_ID> --output /tmp/<filename>`
...

## Error Recovery
| Error | Cause | Recovery |
|-------|-------|----------|
| `403 forbidden` | No access | Ask user to share with agent email |
...

## Examples
Task: "Find the Q3 financial report and download it"
→ drive-search --query "name contains 'Q3' AND name contains 'financial'"
→ Result: [{ id: "abc123", name: "Q3 Financial Report.pdf" }]
→ drive-download abc123 --output /tmp/Q3_report.pdf
```
