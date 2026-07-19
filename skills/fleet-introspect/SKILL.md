# Skill: Fleet Introspect

## Availability (built into this skill)

> [!IMPORTANT]
> **Prime-only.** This skill is scoped to Prime agents (`skill.json` `roles: ["prime"]`) — fleet agents never see it. It is how a Prime **observes** the fleet: reading another agent's work directly, without SSHing into that agent's VM.

## When to Use
When you need to understand what a fleet agent has been doing — analyze its recent missions, diagnose why a mission failed, review its success rate, or gather evidence for a fleet improvement review. This is the **read** half of Prime's platform-engineer role; use SSH (`system-shell`) only for operations that need a shell on the agent's host (test, restart, upgrade).

## What it reads
Fleet agents write their work to the shared root `work/` Firestore collection, keyed by `owner` (their full email). A Prime can read any agent's envelopes from its own VM with the metadata token — no host access required. This is deterministic and read-only (C-4/C-5).

## Commands

`fleet-work-read` — structured read of a fleet agent's missions and their checkpoint/task trees.

```bash
fleet-work-read --agent millie                  # last 5 missions (summary)
fleet-work-read --agent millie --last 10         # last 10 missions
fleet-work-read --agent millie --status failed   # only failed missions
fleet-work-read --agent millie --type C          # checkpoints instead of missions (M is default)
fleet-work-read --agent millie --mission w-...   # drill into ONE mission's full M->C->T tree
fleet-work-read --email <full-email> ...         # explicit target (agent under a different Prime)
fleet-work-read --agent millie --json            # machine-readable
```

- `--agent <name>` resolves the short name to an email via **this** Prime's fleet registry (`primes/{primeId}/fleet/{name}`). For an agent registered under a different Prime, pass `--email` directly.
- List mode returns the newest missions with status, iteration, project, title, and a truncated output/error. Each row prints the exact `--mission` drill command to inspect it further.
- Drill mode walks the whole envelope tree (checkpoints and their tasks), printing per-node status and any error — the fastest way to see *where* a mission actually broke.

## Procedure: analyze a fleet agent's failures
1. `fleet-work-read --agent <name> --last 10` — get the recent mission list; note the ones with `failed`/`blocked`/`cancelled` status.
2. `fleet-work-read --agent <name> --mission <id>` on each — the tree shows which checkpoint/task failed and its error text.
3. Read the failing task's error to classify the root cause (tool error, auth, missing input, verification rejection).
4. If the fix belongs in the product (a skill, a daemon, a tool), surface it to the operator with a concrete recommendation. (The structured self-improvement pipeline is being reimplemented; a verified fix may still be proposed upstream as a human-gated draft PR via the github-pr skill.)

## Related skills (don't duplicate)
- **fleet-status** — registry + live health/liveness of agents (brain state, heartbeat). Use for "is agent X up?"
- **telemetry** — token/cache/cost metrics. Use for "how much is agent X spending?"
- **fleet-introspect (this)** — the *work itself*: what missions ran and how they turned out.

## Notes / Limitations
- Read-only. This skill never mutates fleet state; use `fleet-upgrade`/`fleet-verify` or `system-shell` for actions.
- Large result sets are streamed to a temp file, never passed as a shell argument (avoids the `ARG_MAX` failure mode that broke the old `work-log-read`).
- The query filters `owner` server-side (exact email) and sorts client-side, so no composite Firestore index is required.

## Error Recovery
| Symptom | Likely cause | Recovery |
|---|---|---|
| "Agent 'X' not found in {prime}'s fleet registry" | Agent is registered under a different Prime | Pass `--email <full-email>` explicitly. |
| `HTTP 400` on the query | Missing index / malformed filter | The tool avoids composite indexes by design; re-run, and if it persists check the `owner` value is a full email. |
| Empty result for an agent you know is active | Wrong email, or its work predates the shared `work/` collection | Confirm the email via `fleet-status --name X --json`; widen `--last`. |
| Mission drill shows `missing` children | Child envelope was hard-deleted/archived out | Expected for old missions; the surviving nodes still show the failure point. |
