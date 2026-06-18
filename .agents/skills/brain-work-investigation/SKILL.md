---
name: brain-work-investigation
description: "Investigate brain activity, decision loops, and work envelopes across Cortex, Prefrontal, Motor, and Cerebellum."
---
# Skill: Brain and Work Investigation

## When to Use
Use this skill when you need to audit, debug, or report on the brain daemon's decision loops (Cortex, Prefrontal, Motor, Cerebellum), or trace work envelope hierarchies (M-type, C-type, T-type) and resolve blocked missions.

## Procedures

### 1. Reconstruct Mission Hierarchies
To map out a root mission and all its nested child missions, checkpoints, and tasks:
1. Locate the target `owner` (e.g., `devops-agent-stan@tachin.ag`) or specific `mission_id` (e.g., `w-1781811338796-3d0b1c0f`).
2. Run the `query-tree.py` script from the VM (e.g., `prime-chuck`) or copy its execution path:
   ```bash
   python3 scripts/query-tree.py [owner_email] [mission_id]
   ```
3. Verify that all parent-child relationships are correctly mapped and sorted by `created_at`.

### 2. Identify Blocked and Stale Work
To find why a mission is stuck or what is currently blocking execution:
1. Run the `query-blocked.py` script to list all documents with status `blocked` or `failed`:
   ```bash
   python3 scripts/query-blocked.py [owner_email]
   ```
2. For any blocked document, check the `blocker`, `blocker_type`, and `error` fields.
3. Retrieve the full details of the failing task using `query-task-details.py`:
   ```bash
   python3 scripts/query-task-details.py [task_id]
   ```

### 3. Trace Brain Daemon Logs
To follow the Cortex/Prefrontal/Cerebellum decide-loop in real-time or audit past decisions:
1. SSH into the target VM (e.g., `fleet-stan`) using IAP:
   ```powershell
   gcloud compute ssh [VM_NAME] --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 200"
   ```
2. Look for the following signature log events:
   - `Calling Cortex: mode=classify` (Intake intake routing)
   - `Calling Prefrontal: analyze` (Brief decomposition)
   - `Calling Cortex: mode=decide` (Decision loop action selection)
   - `[checkpoint-executor] CP[X] Task [Y]: dispatching to cerebellum` (Auto-verification)
   - `[checkpoint-executor] Cerebellum PASS/FAIL on CP[X] Task [Y]` (Verdict)
   - `Post-unblock guard: blocking...` (Self-unblock failure loop safety trigger)

---

## Troubleshooting Guide

| Issue | Likely Cause | Recommended Audit Step |
|-------|--------------|------------------------|
| Task fails immediately with `Unknown agent` | Prefrontal generated a plan containing a skill/tool name instead of a registered agent (`motor`, `temporal-research`, `temporal-memory`). | Nudge Cortex to generate an inline plan directly, bypassing Prefrontal structuring. |
| Tool fails with `Unknown arg` | The tool documentation in `SKILL.md` is out of sync with the binary parameter parser (e.g., missing parameter flags like `--url`). | Audit the binary script under `/opt/corekit/brain/` or `/opt/corekit/bin/` to check its parameter parsing. |
| Mission silently completes despite verification failure | A legacy transport-layer check in `callAgent` intercepted a `FAIL` verdict and bypassed structural verification. | Verify `agent-brain.mjs` is calling `extractVerdict()` on `verifyResult.output` rather than short-circuiting. |
