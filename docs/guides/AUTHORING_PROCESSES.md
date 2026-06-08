# Authoring Processes

This guide covers how to write Process definition files for the Culture of Work system. Processes are reusable templates that define structured work sequences, stored as JSON in `corekit/config/processes/`.

---

## File Location & Naming

- **Directory:** `corekit/config/processes/`
- **Naming convention:** `p-{name}.json` (e.g., `p-implement.json`, `p-review.json`)
- **Loading:** Processes are loaded by `loadLocalProcesses()` at brain daemon startup and synced to Firestore at `primes/{id}/processes/{processId}`

---

## Schema Reference

### Top-Level Structure

```json
{
  "id": "p-example",
  "name": "Example Process",
  "description": "What this process does and when to use it.",
  "status": "active",
  "version": 1,
  "visibility": "standard",
  "parameters": { },
  "steps": [ ],
  "contextTemplate": { },
  "pre_flight": null,
  "created_by": "system",
  "execution_count": 0
}
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `id` | `string` | ✓ | Must match filename without `.json` (e.g., file `p-audit.json` → `"id": "p-audit"`) |
| `name` | `string` | ✓ | Human-readable name shown in dashboard and agent prompts |
| `description` | `string` | ✓ | Explains what the process does and when to use it. This is what cortex reads to decide whether to invoke the process. |
| `status` | `string` | ✓ | `"active"` — available for execution. `"inactive"` — disabled. |
| `version` | `number` | ✓ | Increment when changing the process definition |
| `visibility` | `string` | ✓ | `"standard"` — shown to agents in `available_processes`. `"internal"` — hidden from agent selection. |
| `parameters` | `object` | ✓ | Named parameter definitions (see below) |
| `steps` | `array` | ✓ | Ordered sequence of steps (see below) |
| `contextTemplate` | `object` | ✗ | Context packets merged into Mission at execution time |
| `pre_flight` | `string \| null` | ✗ | Pre-flight check instruction (run via motor before main steps) |
| `created_by` | `string` | ✗ | Creator identifier |
| `execution_count` | `number` | ✗ | Auto-incremented by engine. Set to `0` in definition. |

---

## Parameters

Parameters define the inputs your process accepts. They support substitution into step descriptions.

```json
"parameters": {
  "goal": {
    "description": "What to implement — feature, fix, or refactor",
    "required": true
  },
  "project_id": {
    "description": "Project context (optional)",
    "required": false,
    "default": ""
  },
  "branch_prefix": {
    "description": "Branch naming prefix",
    "required": false,
    "default": "feat"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | What this parameter is for (shown in agent prompts) |
| `required` | `boolean` | If `true` and no value provided, engine attempts auto-fill from intake text. If still missing, falls back to decide loop. |
| `default` | `string` | Default value used when parameter is not provided. Only for optional parameters. |

### Parameter Substitution Syntax

Use `${param}` or `{{param}}` in step fields. Both syntaxes are equivalent:

```json
{
  "description": "Implement ${goal} in branch ${branch_prefix}/feature-name"
}
```

Substitution applies to:
- `step.title`
- `step.description`
- `step.accept_criteria`
- `step.approval_message`
- `contextTemplate` name and summary values

### Auto-Fill Behavior

When a required parameter is missing:
1. The engine extracts the source text from the intake or decision
2. Sets the missing parameter to the full source text
3. Logs: `auto-filled parameter 'goal' from intake text`

If auto-fill fails (no source text available), the process falls back to the normal cortex decide loop.

---

## Steps

Steps are the core of a process. Each step defines a unit of work for a single agent.

### Standard Step

```json
{
  "title": "Implement changes",
  "description": "Implement ${goal}:\n1. Make code changes...\n2. Follow conventions...",
  "agent": "motor",
  "type": "standard",
  "intent": "execute",
  "accept_criteria": "Changes implemented. Tests written.",
  "checkpointBoundary": false,
  "optional": false
}
```

| Field | Type | Required | Description |
|-------|------|:---:|-------------|
| `title` | `string` | ✓ | Short name for the step |
| `description` | `string` | ✓ | Full instruction for the agent. Supports `${param}` substitution. Multi-line with `\n`. |
| `agent` | `string` | ✓ | Target agent: `"motor"`, `"cerebellum"`, `"temporal-research"`, `"temporal-memory"`, `"prefrontal"` |
| `type` | `string` | ✓ | `"standard"` or `"approval_gate"` |
| `intent` | `string` | ✓ | `"execute"`, `"research"`, or `"approval_gate"` |
| `accept_criteria` | `string` | ✓ | What constitutes successful completion |
| `checkpointBoundary` | `boolean` | ✗ | If `true`, ends the current checkpoint after this step |
| `optional` | `boolean` | ✗ | If `true`, failure doesn't fail the checkpoint |
| `specialty` | `string` | ✗ | Required agent specialty (for fleet dispatch) |
| `approval_message` | `string` | ✗ | Custom notification text for `approval_gate` steps |
| `sub_process` | `string` | ✗ | Process ID to inline (see Sub-Process Composition) |

### Approval Gate Step

```json
{
  "title": "Approve release?",
  "description": "Pre-flight checks complete. Human approval required.",
  "type": "approval_gate",
  "approval_message": "🚀 Release ${version} is ready. Reply approve or reject.",
  "agent": "motor",
  "intent": "approval_gate",
  "accept_criteria": "Human has approved or rejected."
}
```

When the executor reaches an approval gate:
1. The entire M→C→T hierarchy pauses (`awaiting_approval`)
2. A notification is sent to the operator
3. An approval document is written to `primes/{id}/approvals/{approvalId}`
4. Execution resumes only when approved, or the Mission is rejected

### Sub-Process Step

```json
{
  "title": "Verify deployment",
  "sub_process": "p-deploy-verify"
}
```

When `sub_process` is set, the engine:
1. Loads the referenced process
2. Expands its steps inline (flattened, not nested)
3. Applies parameter substitution from the parent context
4. Detects and rejects circular references

---

## Intent Types

Intent controls what an agent is allowed to do:

| Intent | Meaning | Use When |
|--------|---------|----------|
| `execute` | Agent may modify files, run commands, create resources | Steps that make changes |
| `research` | Agent must be **read-only** — examine but never modify | Audit, review, investigation steps |
| `approval_gate` | Not dispatched to agent — pauses for human approval | Before destructive or high-risk steps |

> **Best practice:** Prefix read-only step descriptions with `⚠️ READ-ONLY STEP — do NOT modify, fix, deploy, or change anything.` This reinforces the intent constraint in the agent's prompt.

---

## Checkpoint Boundaries

Steps are grouped into Checkpoints by `checkpointBoundary` markers:

```
Step 1                          ┐
Step 2 (checkpointBoundary)     ┘ → Checkpoint 1

Step 3                          ┐
Step 4 (checkpointBoundary)     ┘ → Checkpoint 2

Step 5                          ┐
Step 6 (final step)             ┘ → Checkpoint 3
```

**Rules:**
- The final step always ends a checkpoint (implicitly)
- Steps without `checkpointBoundary: true` accumulate into the current checkpoint
- Each checkpoint executes sequentially — all tasks must complete before the next begins
- Context from prior checkpoints is forwarded to subsequent ones

### When to Place Checkpoint Boundaries

Place boundaries at **natural verification points** — moments where you want to confirm progress before continuing:

- After setup/preparation steps → before implementation
- After implementation → before validation
- After research/gathering → before analysis
- Before approval gates (but the gate itself can start a new checkpoint)
- Before destructive operations (deploy, release, delete)

---

## Context Templates

Context templates inject structured information into the Mission at execution time:

```json
"contextTemplate": {
  "repo": {
    "name": "${target}",
    "summary": "Repository to review: ${target}"
  }
}
```

Template values support `${param}` substitution. The merged context is available to agents throughout the Mission.

---

## Pre-Flight Checks

The `pre_flight` field is a text instruction run by motor before the main process steps begin:

```json
"pre_flight": "Ensure git workspace is clean and on the main branch. Stash any uncommitted changes."
```

Pre-flight runs as a separate agent call (not a step in the M→C→T hierarchy). If it fails, the process still proceeds — it's a best-effort workspace preparation.

---

## Complete Example: Investigation Process

```json
{
  "id": "p-investigate",
  "name": "Investigation",
  "description": "Structured investigation process for diagnosing issues...",
  "status": "active",
  "version": 1,
  "visibility": "standard",
  "parameters": {
    "topic": {
      "description": "What to investigate",
      "required": true
    },
    "project_id": {
      "description": "Project context (optional)",
      "required": false,
      "default": ""
    }
  },
  "steps": [
    {
      "title": "Frame the question and define scope",
      "description": "⚠️ READ-ONLY STEP\n\nFrame the investigation of ${topic}:\n1. Recall memory for prior work...\n2. Define scope...\n3. List hypotheses...",
      "agent": "motor",
      "type": "standard",
      "intent": "research",
      "accept_criteria": "Question precisely framed. At least 2 hypotheses identified."
    },
    {
      "title": "Gather evidence from primary sources",
      "description": "⚠️ READ-ONLY STEP\n\nGather evidence for ${topic}:\n1. Check logs...\n2. Read config...\n3. Query infrastructure...",
      "agent": "motor",
      "type": "standard",
      "intent": "research",
      "accept_criteria": "Evidence gathered from 2+ sources. Documented with commands.",
      "checkpointBoundary": true
    },
    {
      "title": "Analyze findings and identify root cause",
      "description": "⚠️ READ-ONLY STEP\n\nAnalyze evidence for ${topic}...",
      "agent": "motor",
      "type": "standard",
      "intent": "research",
      "accept_criteria": "Root cause identified with evidence. Facts vs hypotheses distinguished."
    },
    {
      "title": "Document findings and recommendations",
      "description": "⚠️ READ-ONLY STEP\n\nProduce investigation report for ${topic}...",
      "agent": "motor",
      "type": "standard",
      "intent": "research",
      "accept_criteria": "Report complete. Recommendations specific and actionable."
    }
  ],
  "contextTemplate": {},
  "pre_flight": null,
  "created_by": "system",
  "execution_count": 0
}
```

---

## Checklist

Before committing a new process:

- [ ] `id` matches filename (without `.json`)
- [ ] `description` is clear enough for cortex to decide when to invoke it
- [ ] All required parameters have `"required": true`
- [ ] All `${param}` references match defined parameter names
- [ ] Each step has `title`, `description`, `agent`, `type`, `intent`, `accept_criteria`
- [ ] `checkpointBoundary` is set at natural verification points
- [ ] Read-only steps use `"intent": "research"` and include the `⚠️ READ-ONLY` prefix
- [ ] Approval gates have meaningful `approval_message` text
- [ ] `sub_process` references point to existing process IDs (no circular refs)
- [ ] `version` is set to `1` (or incremented from previous version)
- [ ] `status` is `"active"`
- [ ] `execution_count` is `0`
