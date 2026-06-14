# Skill: work-logging

## What this skill does
Read and write task lifecycle records and work envelope logs.
Used for mission history, agent activity dashboards, and readback.

## When to use
When you need to record task outcomes, review what agents have done,
or query recent mission history from Firestore.

---

## Tools

### task-log-write

Write a task lifecycle record to Firestore. Typically called internally
by `agent-mouth` after delivering output or on timeout — **not usually
invoked directly by Motor.**

```
exec task-log-write <taskId> <agentId> <channel> <status> \
  <startedAt> <durationMs> <outputChars> <classified> \
  [text] [error]
```

**Arguments:**
| Arg | Description |
|-----|-------------|
| `taskId` | Unique task identifier |
| `agentId` | Agent that performed the task |
| `channel` | Communication channel |
| `status` | `delivered`, `timed_out`, or `error` |
| `startedAt` | ISO timestamp when task started |
| `durationMs` | Execution duration in milliseconds |
| `outputChars` | Character count of output |
| `classified` | `external`, `internal`, or `unknown` |
| `text` | Optional task text (truncated to 500 chars) |
| `error` | Optional error message |

**Writes to:**
- Prime: `/primes/{primeId}/tasks/{taskId}`
- Fleet: `/primes/{primeId}/fleet/{agentName}/tasks/{taskId}`

**Error handling:** Never fails fatally — logs a warning and exits 0.

---

### task-log-read

Read recent task records from Firestore.

```
exec task-log-read [--last N] [--agent <name>] [--task <taskId>]
```

**Flags:**
| Flag | Default | Description |
|------|---------|-------------|
| `--last N` | `5` | Show last N tasks |
| `--agent <name>` | — | Filter by fleet agent name (e.g. `stan`) |
| `--task <taskId>` | — | Get a specific task by ID |

**Output:** JSON array of task records on stdout.

**Examples:**
```bash
# Last 5 tasks (default)
exec task-log-read --last 5

# Last 10 from a specific fleet agent
exec task-log-read --last 10 --agent stan

# Lookup a specific task
exec task-log-read --task t-1234567890-abc123
```

---

### work-log-read

Query recent work envelopes (missions, checkpoints, responsibilities)
from Firestore. Shows what agents were dispatched, outcomes, and timing.

```
exec work-log-read [OPTIONS]
```

**Flags:**
| Flag | Default | Description |
|------|---------|-------------|
| `--hours N` | `24` | Look back N hours |
| `--owner <name>` | — | Filter by agent owner (e.g. `stan`, `anora`) |
| `--status <status>` | — | Filter: `complete`, `failed`, `active`, `pending` |
| `--type <type>` | — | Filter by envelope type: `M` (mission), `C` (child), `R` (responsibility) |
| `--min-steps N` | `0` | Only show envelopes with N+ child dispatches |
| `--limit N` | `50` | Max results |
| `--json` | — | Output as JSON array |
| `--verbose` | — | Include result/instruction text in output |

**Reads from:** `/primes/{primeId}/work/`

**Examples:**
```bash
# Last 24h, all agents, table format
exec work-log-read --hours 24

# Stan's completed work, last 48h
exec work-log-read --hours 48 --owner stan --status complete

# Missions only, JSON output
exec work-log-read --hours 24 --type M --json

# Multi-step work with full details
exec work-log-read --hours 24 --min-steps 3 --verbose
```
