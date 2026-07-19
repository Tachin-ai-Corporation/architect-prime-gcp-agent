---
name: create-and-iterate-project-processes
description: Use when setting up orchestrated multi-agent project workflows — creating project infrastructure, defining processes, testing delegation chains, and iterating fixes until the end-to-end pipeline succeeds. Covers the full cycle from project registration through validated orchestration.
---
# Skill: Create and Iterate Project Processes

## When to Use
When you need to establish a working orchestrated workflow for a fleet project — where an architect agent delegates work to specialist agents (designer, engineer, devops), and the full pipeline must be validated end-to-end before going live.

## Prerequisites
- Project registered in Firestore (`project-manage create`)
- Team members assigned to project with correct emails
- Shared Drive folder with project files
- Fleet agents upgraded to latest corekit

## Methodology: Test → Diagnose → Fix → Retest

Every new project orchestration follows this iterative cycle:

```
1. Setup Infrastructure (project, processes, context)
2. Inject Test Prompt (via Firestore intake)
3. Monitor Pipeline (brain + gateway logs on each VM)
4. Diagnose Failures (trace through cortex → prefrontal → motor → cerebellum)
5. Apply Fix at the Right Level (SKILL for tool workflows, SOUL for behavioral constraints)
6. Commit + Push + Upgrade Fleet
7. Retest with UNIQUE prompt (avoid dedup guard)
```

### Key Principle: Fix at the Right Level (C-28 layer purity)

The four content layers each hold one purpose — see [`docs/MODULE_CHARTER.md`](../../../docs/MODULE_CHARTER.md).

| Problem Type | Fix Location | Example |
|---|---|---|
| Wrong decision / character (cortex picks wrong action) | **Organ** SOUL | "Don't re-delegate HTML/CSS work" |
| Missing tool workflow (motor doesn't know the procedure) | governing **Skill** | "Edit a file from Drive" in workspace-drive SKILL |
| A repeatable ordering of outcomes for a situation | a **Process** | "finalize a redlined doc: read→apply→verify→strip" |
| A durable working-area fact (a repo, folder, URL, convention) | **Project** context (resource packet) | `design_system_doc: {kind:doc, ref}` |
| Code bug | Source code | Undefined variable, arg parsing error |

> **Canon B-16/B-17 + C-28**: tool syntax lives ONLY in Skills; a SOUL never carries it. The SOUL says *what* to produce (character); the SKILL says *how* to use the tools; a PROCESS says *when and in what sequence*; a PROJECT holds durable references, never particulars or steps.

## Procedures

### 1. Setup Project Infrastructure

```bash
# Register the project
project-manage create '<project_id>' '<display_name>' '<description>'

# Add project context — durable resource references only (C-28 resource packets)
project-manage add-context '<project_id>' 'drive_folder' '{"kind":"drive_folder","ref":"<FOLDER_ID>","summary":"Root project folder"}'
project-manage add-context '<project_id>' 'staging_url' '{"kind":"url","url":"https://<project_id>--staging.web.app","summary":"Staging site"}'
project-manage add-context '<project_id>' 'prod_url' '{"kind":"url","url":"https://<project_id>.web.app","summary":"Production site"}'
# A deploy COMMAND is tool syntax — it belongs in the governing deploy skill, not project context.
# A repeatable deploy PATH belongs in a Process. The project only points at the process (add-process / --processes).

# Add team members
project-manage add-member '<project_id>' '<agent_email>' '<role>'
```

### 2. Define Processes

Create standard processes that match the project's workflow. At minimum:

- **Design/Implementation process** — Architect reads context → delegates to specialist → reviews output
- **Stage/Deploy process** — Download from Drive → deploy to staging → verify → deploy to prod
- **Content update process** — Simple file changes via Drive

Use `process-manage create` or inject directly into Firestore.

### 3. Inject a Test Prompt

Create a Firestore intake document targeting the architect agent:

```bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
BASE='https://firestore.googleapis.com/v1/projects/<GCP_PROJECT>/databases/(default)/documents'
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
ID="intake-$(date +%s)-$$"

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "$BASE/primes/<PRIME_ID>/intake?documentId=$ID" \
  -d '{
    "fields": {
      "id": {"stringValue": "'"$ID"'"},
      "source": {"stringValue": "gchat"},
      "sender": {"stringValue": "<OPERATOR_EMAIL>"},
      "text": {"stringValue": "<PROMPT_TEXT>"},
      "source_meta": {"mapValue": {"fields": {
        "agentId": {"stringValue": "<ARCHITECT_AGENT_ID>"},
        "space_id": {"stringValue": "<GCHAT_SPACE_ID>"}
      }}},
      "mentions_me": {"booleanValue": true},
      "timestamp": {"stringValue": "'"$TS"'"},
      "created_at": {"stringValue": "'"$TS"'"},
      "status": {"stringValue": "pending"}
    }
  }'
```

### 4. Monitor the Pipeline

Check each agent in the delegation chain:

```bash
# Architect brain logs (decision-making)
sudo journalctl -u agent-brain --no-pager -n 30 --since '<timestamp>'

# Specialist gateway logs (tool calls — shows readFile, writeFile, drive-download, etc.)
sudo journalctl -u agent-neural-gateway --no-pager -n 30 --since '<timestamp>'
```

**What to look for at each stage:**

| Stage | Log Source | Success Signal | Failure Signal |
|-------|-----------|---------------|----------------|
| Classify | brain | `Classify result: new_mission` | `Dedup guard: suppressing` |
| Plan | brain | `Prefrontal structured N checkpoints` | `enforceSchema invalid` |
| Motor exec | gateway | Tool calls (`writeFile`, `drive-upload`) | `report_fail` |
| Verify | gateway | `report_pass` with criteria checks | `report_fail` with evidence |
| Delegate | brain | `delegation sent to <email>` | `Unknown action` |

### 5. Diagnose Failures

For each failure, trace through the four organs:

1. **Cortex** — Did it pick the right action? Check `Cortex raw response` in brain logs.
2. **Prefrontal** — Did it structure the plan correctly? Check `Prefrontal responded` and checkpoint structure.
3. **Motor** — Did it use the right tools? Check gateway logs for tool calls. The most common failure: motor downloads a file but never calls `writeFile` before uploading.
4. **Cerebellum** — Did it catch the failure? Check `report_pass` / `report_fail` args. Cerebellum rarely false-passes.

### 6. Apply Fixes

- **Decision issues** → Cortex SOUL (e.g., "You ARE the specialist for this work, don't re-delegate")
- **Tool workflow gaps** → Governing SKILL (e.g., add "Edit a file from Drive" to workspace-drive SKILL)
- **Delegation issues** → delegation SKILL or plan-structuring SKILL
- **Tool bugs** → Fix the tool script, update manifest

### 7. Upgrade and Retest

```bash
git add . && git commit -m "<description>" && git push origin main

# Upgrade each affected agent
sudo /opt/corekit/bin/upgrade-corekit --apply main
```

**Critical**: Use a UNIQUE prompt for each retest. The dedup guard compares new prompts against recently completed missions and will suppress duplicates. Change the specific task while keeping the workflow the same.

## Common Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Dedup guard blocks retest | `Dedup guard: suppressing new_mission` | Use unique prompt text each iteration |
| Cross-VM file reference | Delegate can't find file | Never reference local paths in delegations; use Drive IDs |
| Motor skips writeFile | Uploaded file is identical to downloaded file | Ensure workspace-drive SKILL has "Edit a file from Drive" procedure |
| Designer re-delegates | Delegation chain grows instead of executing | Add "Implementation Ownership" to designer cortex SOUL |
| Overlapping test missions | Results from old tests interfere | Archive old work envelopes before retesting |
| Agent upgrade interrupts work | Mission stuck in waiting | Wait for all active missions to complete before upgrading |

## Success Criteria

The orchestration is working when:
1. Architect reads project files and creates inline instructions
2. Delegation reaches the specialist with all context inline (no cross-VM file refs)
3. Specialist executes the work directly (no re-delegation)
4. Motor calls `writeFile` to save modifications
5. Motor uploads modified files to Drive
6. Cerebellum verifies all acceptance criteria
7. Delegation result returns to architect
8. Architect synthesizes and reports to operator
