# Skill: Brain Telemetry & Agent Status

## When to Use
When checking agent health, reading brain dispatch metrics, debugging dispatch failures, or updating agent activity state in Firestore or status logs.

## Commands

### Read
- `brain-telemetry-read [--last <n>] [--agent <id>] [--failures] [--json]` — Query recent brain dispatch telemetry events from Firestore.
  Output: Table or JSON list of dispatch events (times, duration, success/fail details).
- `agent-status get [--field <name>]` — Read the agent's current activity state from `workspace/STATUS.json`.
  Output: Full status JSON or the value of the requested field.

### Write
- `agent-status set <state> [detail] [task]` — Write/update the agent's activity state.
  Output: Status confirmation. (Valid states: `idle`, `classifying`, `planning`, `dispatching`, `synthesizing`, `responding`).

## Procedures

### Inspect recent dispatch failures
1. Run `brain-telemetry-read --failures --last 10` to query the last 10 failed dispatches.
2. Verify: Ensure the output contains details about the failed task and its error message or exit code.

### Check current agent state
1. Run `agent-status get --field state` to fetch the status state.
2. Verify: Ensure the output displays the correct active state (e.g., `planning` or `idle`).

### Set agent state to active or idle
1. To set the state during a task, run `agent-status set dispatching "Running research task" "t-123"`.
2. To clear the state when finished, run `agent-status set idle`.
3. Verify: Run `agent-status get` and confirm the JSON matches the newly set state.
