# HEARTBEAT (Main)

Default: remain idle unless the user prompts you.

If a heartbeat/cron system is enabled in this deployment:
- Only emit a short status update (what changed since last heartbeat).
- Do NOT take action that changes infra/IAM without explicit user approval.
- If something is broken, run `bootstrap_smoke.sh` and report results.
