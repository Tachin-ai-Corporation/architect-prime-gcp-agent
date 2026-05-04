# Responsibilities — Implementation Specification

> **Status:** PLANNED — Design document, not yet implemented. Uses current `corekit/` path conventions.
> **Written:** 2026-04-04
> **Last reviewed:** 2026-04-11
> **Depends on:** Brain Architecture v2 and the R/C/M framework

## Design Philosophy

A Responsibility is a self-contained autonomous work package. Not a cron job with a prompt string — a portable, version-controllable bundle that includes everything the agent needs to wake up, do the work, and report back.

Inspired by the "Hands" packaging pattern: each Responsibility is a directory with a manifest, operational playbook, domain knowledge, metrics definition, and settings. The OpenClaw cron engine provides the scheduler, but the Responsibility bundle provides the *intelligence*.

---

## Directory Structure

Each Responsibility lives in its own directory under `responsibilities/`:

```
responsibilities/
├── queue-worker/
│   ├── RESPONSIBILITY.toml       # Manifest (schedule, model, tools, metadata)
│   ├── PLAYBOOK.md               # Multi-phase operational instructions
│   ├── SKILL.md                  # Domain knowledge the agent needs
│   ├── METRICS.toml              # What to track and report
│   └── SETTINGS.toml             # Tunable parameters (customer-editable)
│
├── inbox-triage/
│   ├── RESPONSIBILITY.toml
│   ├── PLAYBOOK.md
│   ├── SKILL.md
│   ├── METRICS.toml
│   └── SETTINGS.toml
│
├── drive-organizer/
│   ├── RESPONSIBILITY.toml
│   ├── PLAYBOOK.md
│   ├── SKILL.md
│   ├── METRICS.toml
│   └── SETTINGS.toml
│
├── mission-review/
│   ├── RESPONSIBILITY.toml
│   ├── PLAYBOOK.md
│   ├── SKILL.md
│   ├── METRICS.toml
│   └── SETTINGS.toml
│
├── memory-consolidate/
│   ├── RESPONSIBILITY.toml
│   ├── PLAYBOOK.md
│   ├── SKILL.md
│   ├── METRICS.toml
│   └── SETTINGS.toml
│
└── health-check/
    ├── RESPONSIBILITY.toml
    ├── PLAYBOOK.md
    ├── SKILL.md
    ├── METRICS.toml
    └── SETTINGS.toml
```

Custom (customer-defined) responsibilities go in a separate directory that persists across upgrades:

```
/opt/openclaw/.openclaw/responsibilities/
├── contract-review/
│   ├── RESPONSIBILITY.toml
│   ├── PLAYBOOK.md
│   ├── SKILL.md
│   ├── METRICS.toml
│   └── SETTINGS.toml
└── competitor-watch/
    └── ...
```

At boot, the system loads both `responsibilities/` (built-in) and the custom directory (user-defined), merging them into a single registry. Built-in responsibilities cannot be deleted, only disabled. Custom responsibilities can be fully managed.

---

## File Specifications

### RESPONSIBILITY.toml — The Manifest

The manifest declares *what* the Responsibility is and *when/how* it runs. This is the only file the registration system reads to create the cron job. Everything else is loaded at execution time.

```toml
[responsibility]
id = "inbox-triage"
name = "Email Inbox Triage"
version = "1.0.0"
description = "Check support inbox, categorize emails, respond to simple ones, escalate complex ones."
author = "your-org"

# Tags for filtering and dashboard grouping
tags = ["email", "triage", "recurring", "customer-facing"]

# Whether this is a system responsibility (cannot be deleted, only disabled)
system = false

[schedule]
# Standard cron expression (5-field)
cron = "*/15 * * * *"
timezone = "America/Chicago"

# Alternative: interval-based instead of cron
# interval = "15m"

# Alternative: one-shot at a specific time
# at = "2026-04-10T09:00:00-05:00"

[execution]
# Which brain agent handles this responsibility
agent = "cortex"

# Session strategy:
#   "persistent" = session:resp-{id}, carries context across runs
#   "isolated"   = fresh session each run, no carryover
#   "named:{id}" = custom named session for sharing context between responsibilities
session = "persistent"

# Model override (optional — defaults to the agent's configured model)
model = "gemini-2.5-flash"

# Thinking level: "none", "low", "high"
thinking = "low"

# Maximum execution time before the run is killed (seconds)
timeout = 300

# Tools this responsibility is allowed to use
# If omitted, inherits from the agent's default tool set
tools = ["exec", "read", "write", "chat-send", "chat-read", "memory_search"]

[delivery]
# How results are communicated
#   "announce" = post to a chat channel
#   "silent"   = log only, no notification
#   "webhook"  = POST to a URL
#   "conditional" = announce only if output matches a condition
mode = "conditional"

# Only announce if the output contains one of these keywords
# (only used when mode = "conditional")
condition_keywords = ["escalated", "urgent", "error", "failed"]

# Where to deliver (when mode is "announce" or "conditional")
channel = "gchat"
target = "spaces/ESCALATION_SPACE_ID"

[retry]
max_attempts = 3
backoff_seconds = [60, 120, 300]
# What errors trigger retry vs immediate failure
retry_on = ["rate_limit", "overloaded", "network", "server_error"]

[dependencies]
# Other responsibilities that must have run successfully before this one
# (checked against last run status in Firestore)
requires = []

# Responsibilities that should NOT run concurrently with this one
conflicts_with = []
```

### PLAYBOOK.md — Operational Instructions

The playbook is the system prompt injected when the Responsibility runs. It tells the agent *exactly* what to do, in what order, with what decision logic. This is not a vague instruction — it's a multi-phase operational procedure.

```markdown
# Inbox Triage — Operational Playbook

## Context
You are executing the inbox-triage responsibility. You run every 15 minutes.
Your job: process new emails in the support inbox, categorize them, handle
simple ones, escalate complex ones.

## Phase 1: Discovery
1. Check the support inbox at {{SETTINGS.inbox_address}}
2. Identify emails received since your last run
3. If no new emails, report "No new emails" and exit

## Phase 2: Classification
For each new email, classify into one of:
- **billing** — Invoice questions, payment issues, refund requests
- **technical** — Bug reports, how-to questions, integration help
- **sales** — Pricing inquiries, demo requests, partnership proposals
- **security** — Vulnerability reports, access issues, compliance questions
- **other** — Everything else

## Phase 3: Action
For each classified email:

### billing (auto-respond)
- If the question matches a known FAQ pattern, draft and send a reply
- Include relevant account details if accessible
- Tag the email as "responded"

### technical (triage)
- If simple (how-to, known issue): draft a reply with documentation links
- If complex (bug, regression, data issue): summarize in 3 lines and escalate
- Escalation = post to {{SETTINGS.escalation_target}} with:
  - Subject line
  - Sender
  - Category
  - 3-line summary
  - Recommended priority (P1-P4)

### sales (forward)
- Forward to {{SETTINGS.sales_forward}} with a 1-line summary

### security (escalate immediately)
- Always escalate to {{SETTINGS.security_target}}
- Add "URGENT" prefix
- Do not auto-respond

### other
- If actionable: draft a reply
- If spam/noise: archive silently

## Phase 4: Report
Compile a run summary:
- Emails processed: N
- Auto-responded: N
- Escalated: N
- Forwarded: N
- Archived: N

If any emails were escalated, include the escalation summaries in your output.
If no emails were escalated, report "All clear — N emails processed."

## Rules
- Never auto-respond to security-related emails
- Never include customer PII in escalation summaries (use account IDs)
- If unsure about classification, escalate with "NEEDS-REVIEW" tag
- Maximum 10 emails per run (if inbox has >10 new, process oldest 10, note overflow)
```

### SKILL.md — Domain Knowledge

The skill file provides reference knowledge the agent needs to execute the playbook well. Unlike the playbook (which is procedural), the skill is declarative — facts, patterns, examples, and context.

```markdown
# Inbox Triage — Domain Knowledge

## Common Billing Patterns
- "Where is my invoice" → Check billing portal, provide direct link
- "I was charged twice" → Escalate (never promise refunds)
- "Cancel my subscription" → Escalate to retention team
- "Update payment method" → Provide self-service link

## Common Technical Patterns
- "API returns 403" → Check if API key is valid and project has billing enabled
- "Agent not responding in Chat" → Check DWD setup, verify agent email is in the space
- "Deployment failed" → Check Cloud Build logs, common causes: quota, permissions

## Escalation Priority Guide
- P1: Production outage, data loss, security incident
- P2: Feature broken for multiple users, degraded performance
- P3: Single-user issue, cosmetic bug, feature request
- P4: Documentation error, minor UI issue

## Tone Guide
- Professional but warm
- Acknowledge the issue before providing a solution
- Keep replies under 150 words
- Always include a next-step or link
```

### METRICS.toml — What to Track

Defines the counters, gauges, and events that this Responsibility reports. These feed the dashboard and enable monitoring/alerting.

```toml
[metrics]
# Unique prefix for this responsibility's metrics
prefix = "resp_inbox_triage"

# Counters — increment on each occurrence
[[metrics.counters]]
name = "emails_processed"
description = "Total emails processed per run"

[[metrics.counters]]
name = "emails_responded"
description = "Emails auto-responded to"

[[metrics.counters]]
name = "emails_escalated"
description = "Emails escalated to humans"

[[metrics.counters]]
name = "emails_forwarded"
description = "Emails forwarded to other teams"

[[metrics.counters]]
name = "emails_archived"
description = "Emails archived (spam/noise)"

# Gauges — point-in-time values
[[metrics.gauges]]
name = "inbox_backlog"
description = "Unprocessed emails remaining in inbox after run"

# Events — notable occurrences
[[metrics.events]]
name = "security_escalation"
description = "A security-related email was escalated"
severity = "high"

[[metrics.events]]
name = "overflow"
description = "Inbox had more than max_per_run emails"
severity = "medium"

# Health signal — how the dashboard determines responsibility health
[metrics.health]
# "healthy" if last run succeeded and no high-severity events
# "degraded" if last run had warnings or medium-severity events
# "unhealthy" if last run failed or had high-severity events
signal = "last_run_status"
```

### SETTINGS.toml — Customer-Editable Configuration

Settings are the tunable knobs that customers change without modifying the playbook. The playbook references these as `{{SETTINGS.key}}`. Settings are loaded at execution time and injected into the playbook via template substitution.

```toml
[settings]
# Customer-configurable values
# These are injected into PLAYBOOK.md as {{SETTINGS.key}}

# Email inbox to monitor
inbox_address = "support@company.com"

# Where to escalate technical/billing issues
escalation_target = "spaces/SUPPORT_SPACE_ID"

# Where to escalate security issues
security_target = "spaces/SECURITY_SPACE_ID"

# Where to forward sales inquiries
sales_forward = "sales-team@company.com"

# Maximum emails to process per run
max_per_run = 10

# Auto-respond to billing questions?
auto_respond_billing = true

# Auto-respond to simple technical questions?
auto_respond_technical = true
```

---

## Registration Flow

When Architect Prime boots (or when a new Responsibility is added), the registration system:

```
1. Scan responsibilities/ and custom responsibility directories
    │
    ▼
2. For each directory, read RESPONSIBILITY.toml
    │
    ▼
3. Validate manifest (required fields, cron expression, agent exists)
    │
    ▼
4. Write/update Firestore document:
    │  /primes/{primeId}/responsibilities/{respId}
    │  {
    │    id, name, version, description, tags, system,
    │    schedule, execution config, delivery config, retry config,
    │    enabled: true,
    │    source: "builtin" | "custom",
    │    lastRegistered: timestamp,
    │    lastRun: null,
    │    lastStatus: null,
    │    runCount: 0,
    │    metrics: { counters: {}, gauges: {}, events: [] }
    │  }
    │
    ▼
5. Register OpenClaw cron job:
    │  openclaw cron add \
    │    --name "{id}" \
    │    --cron "{schedule.cron}" \
    │    --tz "{schedule.timezone}" \
    │    --session "session:resp-{id}" \  (or "isolated" based on session strategy)
    │    --message "[RESP:{id}] Execute responsibility. Read PLAYBOOK.md and follow it." \
    │    --agent "{execution.agent}" \
    │    --model "{execution.model}" \
    │    --announce  (if delivery.mode != "silent")
    │
    ▼
6. Log: "Responsibility {id} v{version} registered ({schedule.cron})"
```

### Cron job message construction

The cron job message is NOT the full playbook. It's a short trigger that tells the agent to load and execute the Responsibility bundle:

```
[RESP:inbox-triage] Execute responsibility.
Read: /opt/openclaw/.openclaw/responsibilities/inbox-triage/PLAYBOOK.md
Settings: /opt/openclaw/.openclaw/responsibilities/inbox-triage/SETTINGS.toml
Skill: /opt/openclaw/.openclaw/responsibilities/inbox-triage/SKILL.md
Follow the playbook phases in order. Report metrics at completion.
```

This keeps the cron payload small (avoiding token waste on every trigger) while giving the agent explicit file paths to load the full instructions on demand.

---

## Execution Flow

When the cron job fires:

```
OpenClaw cron fires for resp:inbox-triage
    │
    ▼
Agent session starts (persistent: session:resp-inbox-triage)
    │
    ▼
Agent reads trigger message, identifies as a Responsibility run
    │
    ▼
Step 1: Load bundle files
    ├── read SETTINGS.toml → parse into key-value map
    ├── read PLAYBOOK.md → template-substitute {{SETTINGS.*}} values
    ├── read SKILL.md → load as reference context
    └── read METRICS.toml → know what to track
    │
    ▼
Step 2: Execute playbook phases
    ├── Phase 1: Discovery (check inbox)
    ├── Phase 2: Classification (categorize emails)
    ├── Phase 3: Action (respond, escalate, forward, archive)
    └── Phase 4: Report (compile summary)
    │
    ▼
Step 3: Collect metrics
    ├── Count: emails_processed = N
    ├── Count: emails_escalated = N
    ├── Gauge: inbox_backlog = N
    └── Event: security_escalation (if any)
    │
    ▼
Step 4: Write results to Firestore
    │  /primes/{primeId}/responsibilities/inbox-triage
    │  {
    │    lastRun: now,
    │    lastStatus: "success" | "failure" | "partial",
    │    lastDuration: seconds,
    │    runCount: increment,
    │    metrics: { updated counters, gauges, events }
    │  }
    │
    ▼
Step 5: Deliver output (based on delivery config)
    ├── mode=silent → log only
    ├── mode=announce → post summary to target channel
    ├── mode=conditional → post only if condition_keywords found in output
    └── mode=webhook → POST to URL
    │
    ▼
Session suspends (context preserved for next run)
```

---

## Built-In Responsibilities

These ship with every Architect Prime deployment. They are `system = true` and cannot be deleted, only disabled.

### queue-worker

The checkpoint queue engine. Processes one checkpoint at a time.

```toml
[responsibility]
id = "queue-worker"
name = "Checkpoint Queue Worker"
version = "1.0.0"
description = "Process the next queued checkpoint. Activate, plan, execute, verify, complete."
system = true
tags = ["system", "checkpoints"]

[schedule]
cron = "*/2 * * * *"
timezone = "UTC"

[execution]
agent = "cortex"
session = "persistent"
thinking = "low"
timeout = 600

[delivery]
mode = "silent"

[retry]
max_attempts = 2
backoff_seconds = [30, 60]
```

**PLAYBOOK.md** — Checks Firestore for active/queued checkpoints. If active: continue working. If none active and queued exists: activate next by priority. If empty: report idle. Full brain loop (Hippocampus → Prefrontal → Motor → Cerebellum) fires for each checkpoint step.

**METRICS.toml** — Tracks: checkpoints_completed, checkpoints_failed, steps_executed, idle_runs, average_step_duration.

### health-check

System health reporting.

```toml
[responsibility]
id = "health-check"
name = "System Health Check"
version = "1.0.0"
description = "Check VM resources, agent status, memory usage, cron job health."
system = true
tags = ["system", "monitoring"]

[schedule]
cron = "*/30 * * * *"
timezone = "UTC"

[execution]
agent = "cortex"
session = "isolated"
model = "gemini-2.5-flash"
thinking = "none"
timeout = 120

[delivery]
mode = "conditional"
condition_keywords = ["warning", "critical", "unhealthy", "error"]
channel = "gchat"
target = "spaces/OPS_SPACE_ID"
```

**PLAYBOOK.md** — Check disk usage, memory, CPU. Verify OpenClaw gateway is running. Check cron job schedule (any missed?). Check Firestore connectivity. Check last successful checkpoint run. Report healthy/degraded/unhealthy with details.

**METRICS.toml** — Tracks: disk_percent, memory_percent, gateway_uptime_seconds, cron_jobs_healthy, last_checkpoint_age_minutes.

### memory-consolidate

Hippocampus memory maintenance.

```toml
[responsibility]
id = "memory-consolidate"
name = "Memory Consolidation"
version = "1.0.0"
description = "Review daily logs, promote durable items to MEMORY.md, archive stale entries."
system = true
tags = ["system", "memory"]

[schedule]
cron = "0 2 * * *"
timezone = "UTC"

[execution]
agent = "hippocampus"
session = "isolated"
model = "gemini-2.5-flash"
thinking = "low"
timeout = 300

[delivery]
mode = "silent"
```

**PLAYBOOK.md** — Read the last 7 days of `memory/YYYY-MM-DD.md` files. Identify items referenced 3+ times or flagged as durable decisions. Promote to MEMORY.md under the appropriate section. Verify MEMORY.md stays under 5,000 characters (archive overflow to `memory/archive-YYYY-MM.md`). Update Firestore `/brain/context` with current state summary.

### mission-review

PM-oriented daily mission briefing.

```toml
[responsibility]
id = "mission-review"
name = "Daily Mission Review"
version = "1.0.0"
description = "Review all active missions, report progress, flag blockers, escalate overdue checkpoints."
system = true
tags = ["system", "missions", "pm"]

[schedule]
cron = "0 9 * * *"
timezone = "America/Chicago"

[execution]
agent = "cortex"
session = "named:mission-review"
model = "gemini-2.5-flash"
thinking = "low"
timeout = 300

[delivery]
mode = "announce"
channel = "gchat"
target = "spaces/MISSION_STATUS_SPACE_ID"
```

**PLAYBOOK.md** — Read all active missions from Firestore `/missions/`. For each: calculate progress %, identify blocked checkpoints and why, identify overdue checkpoints (>48h since queued), flag risks. Compile daily briefing report. If any checkpoint is >48h overdue, @-mention the assignee in the report.

---

## CoreKit Scripts

### responsibility-register

Scans responsibility directories and registers all found bundles.

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-register — Scan and register all responsibility bundles
#
# Reads RESPONSIBILITY.toml from each directory in:
#   - responsibilities/ (built-in)
#   - $CUSTOM_RESP_DIR (user-defined)
#
# For each valid bundle:
#   1. Writes/updates Firestore document
#   2. Registers or updates the OpenClaw cron job
#
# Usage: responsibility-register [--dir PATH] [--force]
#
# Environment:
#   CUSTOM_RESP_DIR — Path to custom responsibilities
#                     (default: /opt/openclaw/.openclaw/responsibilities)
# ============================================================
```

**Implementation notes:**
- Parse TOML with python3 (`import tomllib` on 3.11+, or `pip install tomli`)
- Idempotent: safe to re-run. Updates existing cron jobs if schedule changed.
- `--force` re-registers everything even if version hasn't changed
- Called during `phase2-vm.sh` bootstrap after OpenClaw gateway is up

### responsibility-add

Creates a new custom responsibility from a template or from scratch.

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-add — Create a new custom responsibility
#
# Usage:
#   responsibility-add --id "contract-review" --name "Contract Review" \
#     --cron "0 9 * * 1" --description "Weekly review of executed contracts"
#
#   responsibility-add --from-template inbox-triage --id "support-triage"
#
# Creates the directory structure with template files, then registers.
# ============================================================
```

### responsibility-list

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-list — List all registered responsibilities
#
# Output: table of id, name, schedule, last run, status, enabled
# ============================================================
```

### responsibility-enable / responsibility-disable

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-enable — Enable a disabled responsibility
# responsibility-disable — Disable a responsibility (preserves config)
#
# Usage: responsibility-enable <id>
#        responsibility-disable <id>
#
# System responsibilities can be disabled but not deleted.
# ============================================================
```

### responsibility-run

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-run — Force immediate execution of a responsibility
#
# Usage: responsibility-run <id> [--force]
#
# --force: run even if another instance is currently running
# Without --force: checks Firestore for in-progress run, skips if found
# ============================================================
```

### responsibility-runs

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-runs — View run history for a responsibility
#
# Usage: responsibility-runs <id> [--limit N] [--status success|failure]
#
# Reads from Firestore /primes/{id}/responsibilities/{respId}/runs/
# ============================================================
```

### responsibility-metrics

```bash
#!/usr/bin/env bash
# ============================================================
# responsibility-metrics — View current metrics for a responsibility
#
# Usage: responsibility-metrics <id> [--json]
#
# Reads METRICS.toml to know what to display, then reads
# current values from Firestore.
# ============================================================
```

---

## Firestore Schema

### Responsibility document

```
/primes/{primeId}/responsibilities/{respId}
```

```json
{
  "id": "inbox-triage",
  "name": "Email Inbox Triage",
  "version": "1.0.0",
  "description": "Check support inbox, categorize, respond, escalate.",
  "tags": ["email", "triage", "recurring"],
  "system": false,
  "source": "custom",
  "enabled": true,

  "schedule": {
    "kind": "cron",
    "cron": "*/15 * * * *",
    "timezone": "America/Chicago"
  },

  "execution": {
    "agent": "cortex",
    "session": "persistent",
    "model": "gemini-2.5-flash",
    "thinking": "low",
    "timeout": 300
  },

  "delivery": {
    "mode": "conditional",
    "conditionKeywords": ["escalated", "urgent", "error"],
    "channel": "gchat",
    "target": "spaces/ESCALATION_SPACE_ID"
  },

  "status": {
    "lastRun": "2026-04-04T21:15:00Z",
    "lastStatus": "success",
    "lastDuration": 42,
    "runCount": 847,
    "consecutiveFailures": 0,
    "health": "healthy"
  },

  "metrics": {
    "counters": {
      "emails_processed": 3241,
      "emails_responded": 1892,
      "emails_escalated": 204,
      "emails_forwarded": 89,
      "emails_archived": 1056
    },
    "gauges": {
      "inbox_backlog": 0
    },
    "events": []
  },

  "registeredAt": "2026-04-01T00:00:00Z",
  "lastRegistered": "2026-04-04T00:00:00Z"
}
```

### Run history (subcollection)

```
/primes/{primeId}/responsibilities/{respId}/runs/{runId}
```

```json
{
  "id": "run-20260404-2115",
  "startedAt": "2026-04-04T21:15:00Z",
  "completedAt": "2026-04-04T21:15:42Z",
  "duration": 42,
  "status": "success",
  "metrics": {
    "emails_processed": 3,
    "emails_responded": 2,
    "emails_escalated": 1,
    "inbox_backlog": 0
  },
  "events": [
    {
      "name": "security_escalation",
      "severity": "high",
      "detail": "Vulnerability report from external researcher",
      "at": "2026-04-04T21:15:28Z"
    }
  ],
  "output": "Processed 3 emails. 2 auto-responded (billing). 1 escalated (security).",
  "error": null,
  "sessionId": "session:resp-inbox-triage",
  "tokensUsed": 1247
}
```

---

## Dashboard API Routes

```
GET    /api/primes/{id}/responsibilities           → List all responsibilities
POST   /api/primes/{id}/responsibilities           → Create custom responsibility
GET    /api/primes/{id}/responsibilities/{respId}   → Get responsibility detail
PATCH  /api/primes/{id}/responsibilities/{respId}   → Update (enable/disable, edit settings)
DELETE /api/primes/{id}/responsibilities/{respId}   → Delete (custom only, not system)

POST   /api/primes/{id}/responsibilities/{respId}/run   → Force immediate run
GET    /api/primes/{id}/responsibilities/{respId}/runs  → Run history
GET    /api/primes/{id}/responsibilities/{respId}/metrics → Current metrics
```

### Dashboard UI

**Responsibilities tab** layout:

```
┌─────────────────────────────────────────────────────────────────┐
│  Responsibilities                              [+ Add New]      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ● queue-worker        every 2m    ✓ healthy    847 runs   [⟳] │
│  ● health-check        every 30m   ✓ healthy    412 runs   [⟳] │
│  ● memory-consolidate  daily 2am   ✓ healthy     14 runs   [⟳] │
│  ● mission-review      daily 9am   ✓ healthy     14 runs   [⟳] │
│  ● inbox-triage        every 15m   ✓ healthy    847 runs   [⟳] │
│  ○ competitor-watch     daily 6am   ⚠ degraded    3 runs   [⟳] │
│                                                                 │
│  [●] = system  [○] = custom  [⟳] = force run now               │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  inbox-triage (detail view)                                     │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Processed│ │Responded │ │Escalated │ │ Backlog  │          │
│  │   3,241  │ │   1,892  │ │    204   │ │     0    │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  Last 10 runs:                                                  │
│  21:15  ✓  3 emails  42s  1,247 tokens                         │
│  21:00  ✓  0 emails  12s    380 tokens                         │
│  20:45  ✓  7 emails  68s  2,891 tokens                         │
│  ...                                                            │
│                                                                 │
│  [Edit Settings]  [View Playbook]  [Disable]  [Run Now]        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Template Substitution

PLAYBOOK.md uses `{{SETTINGS.key}}` placeholders that are replaced at execution time with values from SETTINGS.toml.

The substitution happens in the `responsibility-run` path, before the playbook is injected into the agent's context:

```python
import tomllib, re

def render_playbook(playbook_path, settings_path):
    with open(settings_path, 'rb') as f:
        settings = tomllib.load(f).get('settings', {})

    with open(playbook_path) as f:
        playbook = f.read()

    def replace(match):
        key = match.group(1)
        return str(settings.get(key, f'{{{{SETTINGS.{key}}}}}'))

    return re.sub(r'\{\{SETTINGS\.(\w+)\}\}', replace, playbook)
```

This keeps PLAYBOOK.md portable (same playbook, different settings per deployment) and keeps secrets out of version control (SETTINGS.toml is customer-editable, not committed to git).

---

## Writing a Custom Responsibility

### Step 1: Create the directory

```bash
responsibility-add --id "contract-review" \
  --name "Contract Review" \
  --cron "0 9 * * 1" \
  --tz "America/Chicago" \
  --description "Weekly review of executed contracts in shared Drive folder"
```

This creates the directory with template files at
`/opt/openclaw/.openclaw/responsibilities/contract-review/`.

### Step 2: Edit the files

**RESPONSIBILITY.toml** — Already populated from the command. Adjust tools, delivery, session strategy as needed.

**PLAYBOOK.md** — Write the multi-phase procedure:
```markdown
# Contract Review — Operational Playbook

## Phase 1: Scan
Check Google Drive folder {{SETTINGS.contracts_folder_id}} for new documents
added since last run.

## Phase 2: Read & Classify
For each new document:
1. Read the document content
2. Classify: NDA, MSA, SOW, Amendment, Other
3. Extract: parties, effective date, term, key obligations, value

## Phase 3: Organize
Move each document to the appropriate subfolder:
- NDAs → {{SETTINGS.nda_folder_id}}
- MSAs → {{SETTINGS.msa_folder_id}}
- SOWs → {{SETTINGS.sow_folder_id}}
- Amendments → {{SETTINGS.amendment_folder_id}}
Rename with pattern: YYYY-MM-DD_{Party}_{Type}.pdf

## Phase 4: Summarize
Compile a weekly summary report:
- New contracts: N
- By type: NDA(n), MSA(n), SOW(n), Amendment(n)
- Total contract value added: $X
- Key obligations and deadlines in next 30 days

Post summary to {{SETTINGS.report_target}}.
```

**SKILL.md** — Add domain knowledge about contract types, common clauses, red flags.

**SETTINGS.toml** — Add the configurable values referenced in the playbook.

**METRICS.toml** — Define what to track (contracts_processed, contracts_by_type, total_value_added).

### Step 3: Register

```bash
responsibility-register
```

Or it auto-registers on next gateway restart.

---

## Integration with Brain Architecture

When a Responsibility runs through Cortex, the full brain can be engaged:

| Responsibility type | Brain agents involved |
|---|---|
| Simple monitoring (health-check) | Cortex only (short-circuit) |
| Memory maintenance | Hippocampus directly (agent = hippocampus) |
| Email triage | Cortex → Temporal (research unknown issues) → Specialist (domain judgment) |
| Contract review | Cortex → Temporal (read documents) → Specialist (legal domain) → Motor (move files) |
| Mission review | Cortex → Hippocampus (recall mission state) → Prefrontal (assess risks) |
| Checkpoint queue | Cortex → full brain loop per checkpoint step |

The `execution.agent` field in the manifest determines the entry point. Cortex can dispatch to sub-agents as needed. Non-Cortex agents (like Hippocampus for memory-consolidate) run independently.

---

## Versioning and Upgrades

Built-in responsibilities are version-controlled in git under `responsibilities/`. When a CoreKit upgrade deploys a new version:

1. `responsibility-register --force` re-reads all built-in manifests
2. If `version` in RESPONSIBILITY.toml has changed, the Firestore doc is updated
3. Cron job is re-registered with any schedule changes
4. Customer's SETTINGS.toml is preserved (never overwritten by upgrades)
5. New settings keys get default values; removed keys are ignored

Custom responsibilities are untouched by upgrades since they live in a separate directory.
