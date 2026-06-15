# Skill: telemetry

## What this skill does
Read brain dispatch telemetry and check/set agent activity status.
Used for debugging, performance monitoring, and agent health dashboards.

## When to use
When checking agent health, reading brain dispatch metrics, debugging
dispatch failures, or updating agent activity state.

---

## Tools

### brain-telemetry-read

Query recent brain dispatch telemetry events from Firestore.

```
exec brain-telemetry-read [--last N] [--agent <id>] [--failures] [--json]
```

**Flags:**
| Flag | Default | Description |
|------|---------|-------------|
| `--last N` | `20` | Number of recent events to show |
| `--agent <id>` | — | Filter by agent ID (e.g. `motor`, `temporal-research`) |
| `--failures` | — | Show only failed dispatches |
| `--json` | — | Output as JSON array |

**Reads from:** `/primes/{primeId}/dispatch-log/`

**Output fields:** `agentId`, `task`, `startedAt`, `durationMs`, `outputBytes`,
`exitCode`, `success`, `error`, `callerAgent`

**Examples:**
```bash
# Last 20 events, table format
exec brain-telemetry-read

# Last 50 events for motor agent
exec brain-telemetry-read --last 50 --agent motor

# Only failures, as JSON
exec brain-telemetry-read --failures --json
```

---

### agent-status

Read or write the agent's current activity state. Maintains
`workspace/STATUS.json` for daemons and dashboards to query.

#### Set status
```
exec agent-status set <state> [detail] [task]
```

**States:** `idle`, `classifying`, `planning`, `dispatching`, `synthesizing`, `responding`

**Examples:**
```bash
exec agent-status set dispatching "temporal-research" "Search for Bears news"
exec agent-status set idle
```

#### Get status
```
exec agent-status get
exec agent-status get --field <name>
```

Returns the full STATUS.json or a single field value.

**Examples:**
```bash
# Full status JSON
exec agent-status get

# Just the current state
exec agent-status get --field state
```
