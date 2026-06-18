# Skill: Work & Task Logging

## When to Use
When recording work history, reviewing past task output, or reading mission logs and agent activity from Firestore.

## Commands

### Read
- `task-log-read [--last <n>] [--agent <name>] [--task <taskId>]` — Read recent task records from Firestore.
  Output: JSON array of task records containing status, agent, and output details.
- `work-log-read [--hours <n>] [--owner <name>] [--status <status>] [--type <type>] [--min-steps <n>] [--limit <n>] [--json] [--verbose]` — Query recent work envelopes (missions, checkpoints, responsibilities) from Firestore.
  Output: Table or JSON representation of work envelopes including dispatches, outcomes, and timestamps.

## Procedures

### Query an agent's recent task history
1. Identify the agent name (e.g., `stan`).
2. Run `task-log-read --agent stan --last 10` to view the last 10 task records for that agent.
3. Verify: Check that the output contains a JSON list of tasks executed by the specified agent.

### Inspect completed work envelopes
1. Define the timeframe (e.g., last 48 hours).
2. Run `work-log-read --hours 48 --status complete` to list all completed envelopes.
3. Verify: Confirm the output displays a list of completed missions or responsibilities with completion status.

### Retrieve details for a specific task
1. Obtain the target task ID (e.g., `t-1234567890-abc123`).
2. Run `task-log-read --task t-1234567890-abc123` to query its detailed record.
3. Verify: Ensure the output details match the requested task ID and show the execution log.
