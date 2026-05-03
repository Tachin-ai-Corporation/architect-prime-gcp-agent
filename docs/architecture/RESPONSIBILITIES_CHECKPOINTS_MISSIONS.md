# Responsibilities, Checkpoints & Missions — Implementation Plan

> **Status:** FUTURE — Design document, not yet implemented
> **Written:** 2026-04-04
> **Last reviewed:** 2026-04-11
> **Depends on:** Brain Architecture v2 (multi-agent system) being implemented first

## Overview

Three operational layers that give every OpenClaw agent the ability to work autonomously, work in sequence, and work toward big-picture goals:

```
┌─────────────────────────────────────────────────────────┐
│  MISSION                                                │
│  "Migrate billing system to Cloud Run v2"               │
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │ CP-001  │→ │ CP-002  │→ │ CP-003  │→ │ CP-004  │   │
│  │ Audit   │  │ Design  │  │ Build   │  │ Deploy  │   │
│  │ @prime  │  │ @prime  │  │ @fleet  │  │ @human  │   │
│  │    ✓    │  │ active  │  │ queued  │  │ queued  │   │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │
│                                                         │
│  Owner: PM agent  │  Status: in-progress  │  37% done   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  RESPONSIBILITIES (running independently, always)       │
│                                                         │
│  ⏰ queue-worker      every 2m   Process next checkpoint│
│  ⏰ inbox-triage      every 15m  Check email, categorize│
│  ⏰ drive-organizer   every 1h   Index shared folder    │
│  ⏰ mission-review    daily 9am  PM reviews all missions│
│  ⏰ health-check      every 30m  Report system status   │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Responsibilities

### What they are

A Responsibility is a recurring background task that an OpenClaw agent wakes up to perform on a schedule. It's the equivalent of a reliable employee who handles routine duties without being asked.

### Implementation: OpenClaw Cron + Firestore Registry

OpenClaw already has a production-grade cron system built into the gateway. Responsibilities are cron jobs with metadata stored in Firestore for dashboard management and cross-agent visibility.

### Data model

```
Firestore: /primes/{primeId}/responsibilities/{respId}
```

```json
{
  "id": "inbox-triage",
  "name": "Email Inbox Triage",
  "description": "Check support inbox, categorize emails, respond to simple ones, escalate complex ones",
  "owner": "cortex",
  "schedule": {
    "kind": "cron",
    "expr": "*/15 * * * *",
    "tz": "America/Chicago"
  },
  "session": "session:resp-inbox-triage",
  "prompt": "You are running your scheduled inbox-triage responsibility. Check the support inbox at support@company.com. For each new email: (1) categorize as [billing, technical, sales, other], (2) if billing or simple technical: draft and send a reply, (3) if complex or escalation-worthy: summarize and post to the #escalations Chat space. Report what you processed.",
  "tools": ["exec", "read", "write", "chat-send", "chat-read"],
  "model": "gemini-2.5-flash",
  "thinking": "low",
  "delivery": {
    "mode": "announce",
    "channel": "gchat",
    "to": "spaces/ESCALATION_SPACE_ID"
  },
  "retry": {
    "maxAttempts": 3,
    "backoff": [60000, 120000, 300000]
  },
  "enabled": true,
  "lastRun": "2026-04-04T20:45:00Z",
  "lastStatus": "success",
  "createdAt": "2026-04-01T00:00:00Z",
  "tags": ["email", "triage", "recurring"]
}
```

### Registration flow

When a Responsibility is created (via dashboard or chat command), two things happen:

```
1. Firestore document written to /primes/{id}/responsibilities/{respId}
   (source of truth for metadata, dashboard display, cross-agent visibility)

2. OpenClaw cron job registered on the VM:
   openclaw cron add \
     --name "inbox-triage" \
     --cron "*/15 * * * *" \
     --tz "America/Chicago" \
     --session "session:resp-inbox-triage" \
     --message "<responsibility prompt>" \
     --model "gemini-2.5-flash" \
     --announce
```

The cron job runs inside the OpenClaw gateway process, which is managed by systemd on each VM. The gateway handles retry, backoff, concurrency limits, and missed-job catchup automatically.

### Key design decisions

**Persistent sessions** for responsibilities that need context across runs. `session:resp-inbox-triage` carries conversation history, so the agent remembers what it processed last time. This prevents duplicate processing.

**Isolated sessions** for responsibilities that should start fresh each run (reports, health checks). Use `--session isolated` for these.

**Agent targeting** in multi-agent setups. Each responsibility can target a specific brain agent:

```bash
# This responsibility runs as the Specialist agent
openclaw cron add \
  --name "security-scan" \
  --cron "0 6 * * *" \
  --agent specialist \
  --session isolated \
  --message "Run daily security posture review..."
```

### The queue-worker responsibility (critical)

Every OpenClaw Prime has one special built-in responsibility: the **queue-worker**. This is the engine that processes the checkpoint queue.

```json
{
  "id": "queue-worker",
  "name": "Checkpoint Queue Worker",
  "description": "Check for queued checkpoints. If one is ready, activate it and work on it.",
  "owner": "cortex",
  "schedule": {
    "kind": "every",
    "intervalMs": 120000
  },
  "session": "session:queue-worker",
  "prompt": "[QUEUE-WORKER] Check Firestore for the next queued checkpoint. If there is an active checkpoint, continue working on it. If the active checkpoint is complete, mark it done and dequeue the next. If there are no checkpoints, report idle. Follow the checkpoint execution protocol.",
  "enabled": true,
  "system": true
}
```

### Responsibility management commands

These are implemented as CoreKit bin scripts on the VM:

```bash
# List all responsibilities
responsibility-list

# Add a new responsibility
responsibility-add \
  --name "drive-organizer" \
  --cron "0 * * * *" \
  --prompt "Check shared drive folder, read new documents, organize by type..." \
  --agent cortex

# Disable/enable
responsibility-disable inbox-triage
responsibility-enable inbox-triage

# View run history
responsibility-runs inbox-triage --limit 20

# Force immediate run
responsibility-run inbox-triage --force
```

### Built-in responsibilities (seeded at deploy time)

Every Prime gets these out of the box:

| Responsibility | Schedule | Purpose |
|---------------|----------|---------|
| `queue-worker` | every 2m | Process checkpoint queue |
| `health-check` | every 30m | Report system status, memory usage, agent health |
| `memory-consolidate` | daily 2am | Hippocampus consolidates daily logs → MEMORY.md |
| `mission-review` | daily 9am | Review all active missions, report blockers (PM specialty) |

---

## 2. Checkpoints

### What they are

A Checkpoint is a discrete, end-to-end unit of work. It has a clear goal, defined acceptance criteria, and a verifiable outcome. An OpenClaw works on exactly **one checkpoint at a time**. When multiple requests come in, they queue up and are processed sequentially.

### Data model

```
Firestore: /primes/{primeId}/checkpoints/{cpId}
```

```json
{
  "id": "CP-20260404-001",
  "title": "Audit current billing service endpoints",
  "description": "Review all billing API endpoints, document their request/response schemas, latency SLOs, and dependencies. Output: audit-report.md",
  "status": "active",
  "priority": 2,
  "assignee": {
    "type": "openclaw",
    "primeId": "alpha",
    "agentId": "cortex"
  },
  "assignedBy": {
    "type": "human",
    "name": "John",
    "via": "gchat"
  },
  "missionId": "MISSION-billing-migration",
  "missionCheckpointIndex": 0,
  "plan": null,
  "progress": {
    "stepsTotal": 0,
    "stepsCompleted": 0,
    "currentStep": null,
    "log": []
  },
  "acceptance": {
    "criteria": "Audit report covers all /billing/* endpoints with schemas and SLO data",
    "verifyCommand": "cat /opt/openclaw/.openclaw/workspace-cortex/output/audit-report.md | head -5"
  },
  "result": null,
  "queuedAt": "2026-04-04T20:00:00Z",
  "startedAt": "2026-04-04T20:02:00Z",
  "completedAt": null,
  "timeoutMinutes": 120,
  "tags": ["billing", "audit", "migration"]
}
```

### Status machine

```
                    ┌──────────┐
         assign     │          │  timeout / error
    ───────────────→│  queued  │──────────────────→ failed
                    │          │                      │
                    └────┬─────┘                      │
                         │ dequeue                    │ retry
                         ▼                            ▼
                    ┌──────────┐              ┌──────────┐
                    │          │   verify     │          │
                    │  active  │─────────────→│completed │
                    │          │              │          │
                    └────┬─────┘              └──────────┘
                         │
                         │ needs input
                         ▼
                    ┌──────────┐
                    │          │
                    │ blocked  │  (waiting on human or another openclaw)
                    │          │
                    └──────────┘
```

### How the queue-worker processes checkpoints

The queue-worker responsibility fires every 2 minutes. Here's its execution protocol:

```
queue-worker fires
    │
    ▼
Read Firestore: any checkpoint with status="active" for this Prime?
    │
    ├── YES (active checkpoint exists)
    │   │
    │   ▼
    │   Has the checkpoint timed out?
    │   ├── YES → mark failed, log reason, dequeue next
    │   └── NO  → Continue working on it:
    │             1. Hippocampus: recall checkpoint context
    │             2. Read checkpoint.plan (from Prefrontal)
    │             3. Execute next step via Motor
    │             4. Cerebellum: verify step
    │             5. Update progress in Firestore
    │             6. If all steps done → mark completed, dequeue next
    │
    └── NO (no active checkpoint)
        │
        ▼
    Read Firestore: any checkpoint with status="queued", ordered by priority then queuedAt?
        │
        ├── YES → Activate it:
        │         1. Set status="active", startedAt=now
        │         2. Hippocampus: recall relevant context
        │         3. Prefrontal: create execution plan
        │         4. Store plan in checkpoint.plan
        │         5. Begin executing first step
        │
        └── NO  → Report idle, exit
```

### Checkpoint creation paths

Checkpoints can be created by:

**1. Human via chat** — User says "Deploy the new auth service" in Google Chat or dashboard:
```
agent-ears receives message
    → Cortex classifies as a task (not a question)
    → Cortex creates a checkpoint document in Firestore
    → Status: queued
    → User gets confirmation: "Got it — queued as CP-20260404-002. Currently working on CP-001, yours is next."
```

**2. Human via dashboard** — Click "New Checkpoint" in the web UI, fill in title + description + priority.

**3. Another OpenClaw** — Fleet agent or Prime creates a checkpoint for another Prime:
```
PM OpenClaw creates checkpoint via chat-send to target Prime:
    "CHECKPOINT: Title: Build auth service | Description: ... | Priority: 1"
    → Target Prime's agent-ears parses it
    → Creates checkpoint document
    → Queues it
```

**4. From a Mission** — When a mission is created, its checkpoints are auto-distributed (see Missions below).

**5. From a Responsibility** — A responsibility discovers work that needs a checkpoint:
```
inbox-triage finds a complex email requiring investigation
    → Creates a checkpoint: "Investigate billing discrepancy reported by customer X"
    → Queues it for the main session to handle
```

### Checkpoint execution inside the brain architecture

When a checkpoint is activated, the full brain fires in sequence:

```
Checkpoint activated: "Audit billing endpoints"
    │
    ▼
CORTEX receives from queue-worker
    │
    ├──→ HIPPOCAMPUS: "What do we know about billing endpoints?"
    │    Returns: relevant memory, past decisions, API docs indexed
    │
    ├──→ PREFRONTAL: "Plan the audit of billing endpoints"
    │    Input: Hippocampus context + checkpoint description + acceptance criteria
    │    Returns: Plan with 5 steps (discover endpoints, test each, document schema, measure latency, compile report)
    │
    │    Plan written to checkpoint.plan in Firestore
    │
    ├──→ TEMPORAL: "Research billing API documentation"  (parallel with Specialist)
    │    Returns: API docs, known issues
    │
    ├──→ SPECIALIST: "What should a billing API audit cover?"
    │    Returns: Domain expertise (SRE perspective on SLOs, latency budgets)
    │
    │    For each step in the plan:
    │    ├──→ MOTOR: Execute step (run curl commands, write docs)
    │    └──→ CEREBELLUM: Verify step output
    │
    │    After all steps:
    │    ├──→ CEREBELLUM: Final verification against acceptance criteria
    │    └──→ HIPPOCAMPUS: Store learnings, update memory
    │
    ▼
CORTEX marks checkpoint completed in Firestore
    → Updates mission progress (if part of a mission)
    → Notifies assignedBy (human or OpenClaw) via chat
    → Queue-worker dequeues next checkpoint on next cycle
```

### Progress tracking

Every step completion updates the checkpoint's progress in Firestore. This enables real-time dashboard visibility:

```json
{
  "progress": {
    "stepsTotal": 5,
    "stepsCompleted": 3,
    "currentStep": "Step 4: Measure endpoint latency under load",
    "log": [
      { "step": 1, "status": "done", "summary": "Discovered 12 billing endpoints", "at": "..." },
      { "step": 2, "status": "done", "summary": "Tested all 12 — 11 healthy, 1 deprecated", "at": "..." },
      { "step": 3, "status": "done", "summary": "Documented schemas for all active endpoints", "at": "..." },
      { "step": 4, "status": "active", "summary": "Running latency tests...", "at": "..." }
    ]
  }
}
```

---

## 3. Missions

### What they are

A Mission is a multi-checkpoint project — the north-star goal that ties individual work units together. Missions can span multiple OpenClaws and humans. A Mission has a PM owner (usually a PM-specialty OpenClaw or a human) who is responsible for marshalling it forward.

### Data model

```
Firestore: /missions/{missionId}
```

```json
{
  "id": "MISSION-billing-migration",
  "title": "Migrate billing system to Cloud Run v2",
  "description": "Move all billing service endpoints from GCE to Cloud Run v2, including auth, rate limiting, and monitoring. Zero-downtime cutover.",
  "status": "in-progress",
  "owner": {
    "type": "openclaw",
    "primeId": "pm-agent",
    "name": "PM Prime"
  },
  "createdBy": {
    "type": "human",
    "name": "Sarah (VP Eng)"
  },
  "checkpoints": [
    {
      "index": 0,
      "id": "CP-20260404-001",
      "title": "Audit current billing service endpoints",
      "assignee": { "type": "openclaw", "primeId": "alpha" },
      "status": "completed",
      "dependency": null
    },
    {
      "index": 1,
      "id": "CP-20260404-002",
      "title": "Design Cloud Run v2 service architecture",
      "assignee": { "type": "openclaw", "primeId": "alpha" },
      "status": "active",
      "dependency": "CP-20260404-001"
    },
    {
      "index": 2,
      "id": "CP-20260404-003",
      "title": "Implement billing service on Cloud Run v2",
      "assignee": { "type": "openclaw", "primeId": "fleet-swe-stan" },
      "status": "queued",
      "dependency": "CP-20260404-002"
    },
    {
      "index": 3,
      "id": "CP-20260404-004",
      "title": "Load test and validate SLOs",
      "assignee": { "type": "openclaw", "primeId": "alpha" },
      "status": "queued",
      "dependency": "CP-20260404-003"
    },
    {
      "index": 4,
      "id": "CP-20260404-005",
      "title": "Execute zero-downtime cutover",
      "assignee": { "type": "human", "name": "DevOps team" },
      "status": "queued",
      "dependency": "CP-20260404-004"
    }
  ],
  "progress": {
    "total": 5,
    "completed": 1,
    "active": 1,
    "blocked": 0,
    "percentComplete": 20
  },
  "deadline": "2026-05-01T00:00:00Z",
  "tags": ["billing", "cloud-run", "migration"],
  "createdAt": "2026-04-01T00:00:00Z",
  "updatedAt": "2026-04-04T20:30:00Z"
}
```

### Mission lifecycle

```
CREATED
  │  Human or PM agent defines the mission + checkpoints
  │  Checkpoints distributed to assignees (OpenClaws + humans)
  ▼
IN-PROGRESS
  │  PM owner monitors via daily mission-review responsibility
  │  As checkpoints complete, dependent checkpoints auto-queue
  │  PM escalates blockers, reassigns stalled checkpoints
  ▼
COMPLETED (all checkpoints done)
  │  PM runs final verification
  │  Mission marked complete, report generated
  ▼
ARCHIVED
```

### Checkpoint dependency resolution

When a checkpoint completes, the mission engine checks if any downstream checkpoints are unblocked:

```
CP-001 completes
    │
    ▼
Mission engine scans checkpoints where dependency = "CP-001"
    │
    ├── CP-002 depends on CP-001 → CP-002 is now unblocked
    │   │
    │   ▼
    │   Is CP-002 assignee an OpenClaw?
    │   ├── YES → Create/queue checkpoint document on that Prime's Firestore
    │   │         Notify via Google Chat: "CP-002 is ready for you"
    │   └── NO (human) → Notify via Google Chat: "CP-002 is ready for human action"
    │
    └── No other checkpoints depend on CP-001 → done
```

### The PM responsibility: mission-review

PM-specialty OpenClaws (or any Prime with the PM responsibility) run a daily mission review:

```json
{
  "id": "mission-review",
  "name": "Daily Mission Review",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "America/Chicago"
  },
  "session": "session:mission-review",
  "prompt": "[MISSION-REVIEW] Review all active missions in Firestore. For each mission: (1) calculate progress %, (2) identify blocked checkpoints and why, (3) identify overdue checkpoints, (4) flag risks. Compile a daily mission briefing report. Post to #mission-status Chat space. If any checkpoint is >48h overdue, escalate by @-mentioning the assignee and their manager."
}
```

### Cross-OpenClaw checkpoint distribution

When a mission assigns a checkpoint to a different OpenClaw (fleet agent or another Prime), the distribution happens via Google Chat (DWD):

```
PM Prime creates mission with CP-003 assigned to fleet-swe-stan
    │
    ▼
PM Prime sends structured message via chat-send (DWD):
    To: fleet-swe-stan@company.com
    Message: "CHECKPOINT-ASSIGN: {checkpoint JSON}"
    │
    ▼
fleet-swe-stan's agent-ears picks up the message
    → Parses CHECKPOINT-ASSIGN command
    → Creates checkpoint document in fleet-swe-stan's Firestore
    → Queues it
    → Responds: "Checkpoint CP-003 accepted and queued"
```

For human-assigned checkpoints, the PM posts a task notification to Google Chat with clear instructions and acceptance criteria. The human marks it done by responding in chat, which the PM's agent-ears picks up and processes.

---

## 4. CoreKit Implementation

### New bin scripts

```
bundle/corekit/bin/
├── responsibility-add        # Register a new responsibility
├── responsibility-list       # List all responsibilities
├── responsibility-disable    # Pause a responsibility
├── responsibility-enable     # Resume a responsibility
├── responsibility-run        # Force immediate execution
├── responsibility-runs       # View run history
├── checkpoint-create         # Create and queue a checkpoint
├── checkpoint-status         # View checkpoint status
├── checkpoint-complete       # Mark checkpoint done
├── checkpoint-fail           # Mark checkpoint failed
├── checkpoint-list           # List queue (queued + active)
├── mission-create            # Create a new mission with checkpoints
├── mission-status            # View mission progress
├── mission-distribute        # Distribute checkpoints to assignees
└── queue-worker              # The checkpoint queue processing engine
```

### queue-worker script (the engine)

```bash
#!/usr/bin/env bash
# queue-worker — Process the checkpoint queue
# Called by the queue-worker cron responsibility every 2 minutes
set -euo pipefail

OC_HOST_ROOT="${OC_HOST_ROOT:-/opt/openclaw}"
PRIME_ID="${PRIME_ID:-$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/prime-id)}"
PROJECT_ID="${PROJECT_ID:-$(curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id)}"

# Get auth token
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

FIRESTORE_BASE="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents"

# 1. Check for active checkpoint
ACTIVE=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "$FIRESTORE_BASE/primes/$PRIME_ID/checkpoints?pageSize=1" \
  --data-urlencode 'structuredQuery={"where":{"fieldFilter":{"field":{"fieldPath":"status"},"op":"EQUAL","value":{"stringValue":"active"}}}}' \
  2>/dev/null || echo '{"documents":[]}')

ACTIVE_COUNT=$(echo "$ACTIVE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(len(data.get('documents', [])))
except:
    print(0)
")

if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
  # Active checkpoint exists — hand off to agent-ask for continuation
  CHECKPOINT_DOC=$(echo "$ACTIVE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
doc = data['documents'][0]
print(json.dumps(doc))
")
  echo "$CHECKPOINT_DOC" | \
    $OC_HOST_ROOT/.openclaw/corekit/bin/agent-ask --stdin \
    --context "QUEUE-WORKER: Continue working on the active checkpoint."
  exit 0
fi

# 2. No active checkpoint — check for queued
QUEUED=$(curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  "$FIRESTORE_BASE:runQuery" \
  -H "Content-Type: application/json" \
  -d '{
    "structuredQuery": {
      "from": [{"collectionId": "checkpoints"}],
      "where": {"fieldFilter": {"field": {"fieldPath": "status"}, "op": "EQUAL", "value": {"stringValue": "queued"}}},
      "orderBy": [
        {"field": {"fieldPath": "priority"}, "direction": "ASCENDING"},
        {"field": {"fieldPath": "queuedAt"}, "direction": "ASCENDING"}
      ],
      "limit": 1
    }
  }' 2>/dev/null)

HAS_QUEUED=$(echo "$QUEUED" | python3 -c "
import sys, json
data = json.load(sys.stdin)
docs = [d for d in data if 'document' in d]
print(len(docs))
")

if [[ "$HAS_QUEUED" -gt 0 ]]; then
  # Activate the next checkpoint
  NEXT_CP=$(echo "$QUEUED" | python3 -c "
import sys, json
data = json.load(sys.stdin)
doc = [d['document'] for d in data if 'document' in d][0]
print(json.dumps(doc))
")

  # Update status to active
  CP_PATH=$(echo "$NEXT_CP" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  curl -sf -X PATCH \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$FIRESTORE_BASE/$CP_PATH?updateMask.fieldPaths=status&updateMask.fieldPaths=startedAt" \
    -d "{\"fields\":{\"status\":{\"stringValue\":\"active\"},\"startedAt\":{\"stringValue\":\"$NOW\"}}}"

  # Hand off to agent-ask to begin working
  echo "$NEXT_CP" | \
    $OC_HOST_ROOT/.openclaw/corekit/bin/agent-ask --stdin \
    --context "QUEUE-WORKER: New checkpoint activated. Create a plan and begin execution."
else
  echo "QUEUE-WORKER: No checkpoints in queue. Idle."
fi
```

### checkpoint-create script

```bash
#!/usr/bin/env bash
# checkpoint-create — Create and queue a new checkpoint
# Usage: checkpoint-create --title "..." --description "..." [--priority N] [--mission MISSION_ID]
set -euo pipefail

# Parse args, write to Firestore with status=queued
# Generates CP-YYYYMMDD-NNN ID
# If --mission provided, links to mission and checks dependencies
# Returns checkpoint ID
```

### mission-create script

```bash
#!/usr/bin/env bash
# mission-create — Create a mission with checkpoints
# Usage: mission-create --title "..." --checkpoints checkpoints.json
# checkpoints.json format:
# [
#   {"title": "...", "assignee": "openclaw:alpha", "dependency": null},
#   {"title": "...", "assignee": "openclaw:fleet-stan", "dependency": 0},
#   {"title": "...", "assignee": "human:John", "dependency": 1}
# ]
set -euo pipefail

# Creates mission document
# Creates checkpoint documents for all steps
# Queues checkpoint 0 (no dependencies) on the assignee
# Distributes checkpoint-assign messages to other OpenClaws
# Notifies humans about their assigned checkpoints
```

---

## 5. Firestore Schema (Complete)

```
Firestore
├── /primes/{primeId}/
│   ├── /brain/                          ← Brain agent shared memory (from v2 architecture)
│   │   ├── decisions
│   │   ├── context
│   │   ├── plans/{planId}
│   │   ├── learnings
│   │   └── specialist
│   │
│   ├── /responsibilities/{respId}       ← Responsibility definitions + status
│   │   ├── inbox-triage
│   │   ├── queue-worker
│   │   ├── health-check
│   │   ├── memory-consolidate
│   │   └── mission-review
│   │
│   ├── /checkpoints/{cpId}              ← Checkpoint queue (per-Prime)
│   │   ├── CP-20260404-001  (completed)
│   │   ├── CP-20260404-002  (active)     ← Only 1 active at a time
│   │   └── CP-20260404-003  (queued)
│   │
│   ├── /msgs/{msgId}                    ← Chat messages (existing)
│   └── /fleet/{agentId}                 ← Fleet agents (existing)
│
└── /missions/{missionId}                ← Missions (global, cross-Prime)
    ├── MISSION-billing-migration
    └── MISSION-auth-redesign
```

---

## 6. Dashboard Integration

### New dashboard tabs/sections

**Responsibilities tab:**
- List all responsibilities with status (enabled/disabled), last run time, last status
- Enable/disable toggle per responsibility
- "Add Responsibility" button with cron expression builder
- Run history drill-down per responsibility
- Force-run button

**Checkpoints tab:**
- Queue view: ordered list of queued + active checkpoints
- Active checkpoint detail: real-time progress (steps completed, current step, time elapsed)
- Create checkpoint form
- Status filters: all / queued / active / completed / failed / blocked

**Missions tab:**
- List of active missions with progress bars
- Mission detail view: checkpoint graph with status per checkpoint
- Assignee breakdown: which checkpoints are on which OpenClaw/human
- Timeline/Gantt view showing checkpoint dependencies
- Create mission wizard

### API routes (added to Cloud Run control plane)

```
app/src/app/api/
├── primes/[id]/responsibilities/     GET, POST, PATCH, DELETE
├── primes/[id]/checkpoints/          GET, POST, PATCH
├── primes/[id]/checkpoints/queue/    GET (ordered queue view)
├── missions/                         GET, POST, PATCH
└── missions/[id]/progress/           GET (aggregated progress)
```

---

## 7. How Brain Agents Interact with R/C/M

### Cortex

- Receives checkpoint work from queue-worker
- Classifies incoming chat messages as "task" → creates checkpoint
- Reports checkpoint progress to users
- Routes checkpoint execution through the full brain loop

### Prefrontal

- Creates execution plans for each checkpoint
- Breaks mission-level goals into checkpoint-sized steps
- Assesses risk per checkpoint (flags APPROVAL_REQUIRED)

### Hippocampus

- Recalls context relevant to the current checkpoint
- Recalls mission context (what other checkpoints have been done)
- Stores checkpoint outcomes as learnings
- Maintains mission awareness across sessions

### Temporal

- Researches information needed for checkpoint execution
- Gathers external context for mission planning

### Motor

- Executes checkpoint plan steps
- Writes checkpoint progress updates
- Produces the deliverables defined in checkpoint acceptance criteria

### Cerebellum

- Verifies each checkpoint step output
- Final verification against checkpoint acceptance criteria
- Determines if a checkpoint is truly "done" or needs more work

### Specialist

- Provides domain expertise during checkpoint execution
- Validates checkpoint plans against domain best practices
- PM-specialty Specialist owns mission-review responsibility

---

## 8. Reliability Guarantees

| Concern | Solution |
|---------|----------|
| Cron job misses a run (VM restart) | OpenClaw catches up missed jobs on gateway start |
| Checkpoint times out | queue-worker detects timeout, marks failed, notifies assignedBy |
| Checkpoint step fails | Cerebellum returns FAIL, Motor retries (max 2), then checkpoint blocked |
| Blocked checkpoint holds up mission | PM's mission-review flags it within 24h, escalates |
| Multiple requests arrive simultaneously | All become checkpoints, queued by priority then arrival time |
| VM goes down mid-checkpoint | Checkpoint status stays "active" in Firestore. On VM restart, queue-worker resumes. Session context preserved in `session:queue-worker`. |
| Cross-OpenClaw message fails | DWD chat-send retries with backoff. If persistent failure, PM's mission-review catches the stalled checkpoint. |
| Human-assigned checkpoint stalled | PM's mission-review escalates at 48h overdue |

### Session persistence for reliability

The queue-worker uses a **persistent named session** (`session:queue-worker`). This means:

- Context carries across cron cycles — the agent remembers what step it was on
- If the VM restarts, the session file on disk survives (OpenClaw persists sessions to `~/.openclaw/sessions/`)
- The Firestore checkpoint document is the durable source of truth for status; the session is for conversation context

---

## 9. Migration / Implementation Steps

### Phase 1: Foundation (Week 1)

1. **Add Firestore collections**: `/responsibilities/`, `/checkpoints/`, `/missions/`
2. **Create CoreKit bin scripts**: `queue-worker`, `checkpoint-create`, `checkpoint-status`, `checkpoint-complete`, `responsibility-add`, `responsibility-list`
3. **Seed default responsibilities** in bootstrap: queue-worker, health-check, memory-consolidate
4. **Register cron jobs** in `phase2-vm.sh` bootstrap: register default responsibilities as OpenClaw cron jobs after gateway is up
5. **Test**: Create a checkpoint manually via Firestore console, verify queue-worker picks it up and processes it

### Phase 2: Brain Integration (Week 2)

6. **Update Cortex AGENTS.md**: Add checkpoint and responsibility awareness to the dispatch contract
7. **Update Cortex prompt**: When receiving a task-like message, create a checkpoint instead of executing inline
8. **Update Hippocampus**: Add checkpoint + mission context to recall procedure (read active checkpoint, read mission)
9. **Update Prefrontal**: Generate plans that map to checkpoint steps (progress trackable)
10. **Update Cerebellum**: Add checkpoint acceptance criteria to verification checklist
11. **Test**: End-to-end: send task via chat → checkpoint created → queued → planned → executed → verified → completed

### Phase 3: Missions + Cross-Agent (Week 3)

12. **Create mission-create, mission-status, mission-distribute scripts**
13. **Add agent-ears command parsing**: Recognize CHECKPOINT-ASSIGN messages from other OpenClaws
14. **Implement dependency resolution**: When checkpoint completes, auto-queue dependent checkpoints
15. **Add mission-review responsibility** with PM reporting
16. **Test**: Create a mission with 3 checkpoints across 2 OpenClaws, verify sequential execution with dependency resolution

### Phase 4: Dashboard + Polish (Week 4)

17. **Add API routes** to Cloud Run control plane for responsibilities, checkpoints, missions
18. **Add dashboard UI**: Responsibilities tab, Checkpoints tab, Missions tab
19. **Add responsibility management commands** to dashboard (enable/disable/force-run)
20. **Add checkpoint queue visualization** to dashboard
21. **Add mission progress view** with dependency graph
22. **Test**: Full workflow from dashboard — create mission → distribute → monitor → complete

---

## 10. Example: End-to-End Scenario

**Sarah (VP Eng) messages Prime in Google Chat:**

> "We need to migrate the billing service to Cloud Run v2. Zero downtime. Get it done by May 1st."

**What happens:**

1. **agent-ears** picks up the message, routes to Cortex

2. **Cortex** classifies: this is a mission, not a single task
   - Dispatches to **Hippocampus**: recalls billing service context, past discussions
   - Dispatches to **Prefrontal**: "Plan a billing migration to Cloud Run v2, zero downtime, deadline May 1"
   - Dispatches to **Specialist** (SRE): "What does a zero-downtime migration require?"

3. **Prefrontal** returns a mission plan with 5 checkpoints:
   - CP-001: Audit current endpoints (assign: alpha, no dependency)
   - CP-002: Design CR2 architecture (assign: alpha, depends: CP-001)
   - CP-003: Implement service (assign: fleet-swe-stan, depends: CP-002)
   - CP-004: Load test + SLO validation (assign: alpha, depends: CP-003)
   - CP-005: Execute cutover (assign: human/DevOps, depends: CP-004)

4. **Cortex** creates the mission in Firestore, distributes checkpoints:
   - CP-001 queued on alpha (this Prime)
   - CP-003 pre-assigned to fleet-swe-stan (will be delivered when unblocked)
   - CP-005 noted as human-assigned

5. **Cortex responds to Sarah:**
   > "Mission created: Billing Migration to Cloud Run v2. I've broken it into 5 checkpoints. Starting with the endpoint audit now. I'll keep you posted — you can track progress on the dashboard. The DevOps team will be needed for the final cutover (CP-005)."

6. **queue-worker** picks up CP-001, activates it, full brain executes the audit

7. When CP-001 completes, **dependency resolution** auto-queues CP-002

8. When CP-002 completes, **mission-distribute** sends CP-003 to fleet-swe-stan via Google Chat

9. **PM responsibility** (daily 9am) generates mission briefing:
   > "Mission: Billing Migration — 40% complete. CP-003 active on fleet-swe-stan. On track for May 1 deadline."

10. When CP-004 completes, **Cortex notifies the DevOps team** in Chat:
    > "CP-005 is ready: Execute zero-downtime cutover. Here's the runbook from the Specialist..."

11. DevOps team responds "Done" in Chat. **agent-ears** picks it up, marks CP-005 completed.

12. **Mission marked complete.** PM generates final report. Sarah gets notified.
