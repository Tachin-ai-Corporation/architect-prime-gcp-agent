# Skill: Fleet Status

## When to Use
When checking the live status of deployed fleet agents, agent health, or **which version of
the corekit an agent is actually running**.

## Commands

### Read
- `fleet-status` [--name <name>] [--json] — Query status and health records of deployed fleet
  agents from Firestore.
  Output: table or JSON of agent status, liveness, details, and the **reported** corekit ref.
- `fleet-status --probe` [--json] — As above, and additionally read each VM's **installed**
  corekit ref over SSH and compare the two. Adds `installedRef` and `refDrift` per agent.
  Slower — one SSH per agent — and the only command that can answer "what is actually running".

## Two different refs, and why the difference matters

| Field | Where it comes from | What it proves |
|---|---|---|
| `reportedRef` | the registry: what the agent last **told** it, written on upgrade | that an upgrade reported, whenever that was |
| `installedRef` | `--probe`, read from `/opt/corekit/corekit/STATE.json` on the VM | what is running **now** |

`reportedRef` is written on upgrade **and by nothing else**. An agent upgraded by any path
that does not report leaves it stale, and a stale value reads exactly like a current one.

> Real incident: asked to compare installed refs against registered refs, an agent had no way
> to read the installed ref — `--probe` did not exist. It filled both columns from the same
> source, found no disagreement, and reported **"zero drift detected"** across a fleet where
> every single agent had drifted by ten days. Nothing in the output was flagged as uncertain.

So: **never present `reportedRef` as the installed version, and never compare it to itself.**
If a question is about what is deployed, `--probe` is the answer or you do not have one.

## Procedures

### List all fleet agents
1. Run `fleet-status` for a summary of every deployed agent.
2. Read the liveness marker, not just `status`: `status` is deploy-time and stays `online`
   through a crash-looping brain. `⚪ UNKNOWN` means no health data — that is not "healthy".
3. Verify: every agent you expect appears, and each row carries a liveness marker.

### Inspect one agent
1. `fleet-status --name <agent>` — services, heartbeat age, deploy progress, reported ref.
2. Verify: the output names that agent and shows a heartbeat age you can reason about.

### Answer "what version is the fleet running?" / find drift
1. Run `fleet-status --probe --json`.
2. Every agent with `refDrift: true` is running something other than what the registry says.
   An agent with no `reportedRef` at all counts as drift — *unknown* is not *agreement*.
3. If `probeError` is set for an agent, its installed ref is **UNKNOWN**. Report it as unknown.
   Do not fall back to `reportedRef` and present it as the installed version; that is the exact
   substitution that produced the false report above.
4. Verify: the number of agents in the output matches the number in the registry, and every
   row has either an `installedRef` or a `probeError` — never neither.

## Error Recovery

| Symptom | Cause | Fix |
|---|---|---|
| `probeError: TimeoutExpired` | VM unreachable or IAP slow | Report that agent's installed ref as UNKNOWN; do not substitute the reported ref. |
| `probeError: no coreRef in STATE.json` | Bootstrap did not finish, or a pre-`STATE.json` install | Treat as UNKNOWN and flag the agent for inspection. |
| `reportedRef: UNREPORTED` | Agent has never completed a reporting upgrade | Expected on an agent last upgraded by an older path. `--probe` gives the real answer. |
| Every agent shows `⚪ UNKNOWN` liveness | Health checks are not running | A liveness-reporting gap, not proof the agents are down — say so rather than guessing either way. |
