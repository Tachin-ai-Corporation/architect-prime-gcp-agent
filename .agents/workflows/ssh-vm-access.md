---
description: SSH into a Prime or Fleet VM and execute commands directly on the GCE host. Use when you need to debug, inspect, or test anything on a running agent VM. For deploying changes, use the dashboard upgrade button instead.
---

# SSH VM Access

> SSH is for **debugging only**. Deploy via dashboard. Send messages via dashboard chat.

## Step 1: Find the VM name and zone

```powershell
gcloud compute instances list --project=architect-prime-beta --format="table(name,zone,status)"
```

## Step 2: SSH in

Use `echo y |` to auto-accept host key, and `--command=` for one-shot execution:

```powershell
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="{COMMAND}"
```

Example (gateway status check):
```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo systemctl status agent-brain-gateway"
```

## Common commands

Substitute into the `--command=` pattern above:

```bash
# Brain Gateway status
sudo systemctl status agent-brain-gateway

# Brain Gateway logs
sudo journalctl -u agent-brain-gateway --no-pager -n 50

# Agent ears logs
sudo journalctl -u agent-ears --no-pager -n 20
sudo tail -20 /var/log/agent-ears.log

# Agent mouth logs
sudo journalctl -u agent-mouth --no-pager -n 20
sudo tail -20 /var/log/agent-mouth.log

# Agent brain daemon status/logs
sudo systemctl status agent-brain
sudo journalctl -u agent-brain --no-pager -n 50

# Read telemetry
/opt/corekit/bin/brain-telemetry-read --last 10

# Check SOUL.md (Cortex decision framework)
cat /opt/corekit/workspace/SOUL.md | head -30

# Check rendered config
cat /opt/corekit/corekit/config.json

# CoreKit install state
cat /opt/corekit/corekit/STATE.json

# List workspace files
find /opt/corekit/workspace -name '*.md' -type f
```

## Interactive SSH (when needed)

```powershell
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap
```
