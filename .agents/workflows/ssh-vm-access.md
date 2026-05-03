---
description: SSH into a Prime or Fleet VM and execute commands inside the OpenClaw Docker container. Use when you need to debug, inspect, or test anything on a running agent VM. For deploying changes, use the dashboard upgrade button instead.
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
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sudo docker exec openclaw-gateway {COMMAND}"
```

Example (gateway status):
```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo docker exec openclaw-gateway openclaw status"
```

## Common commands

Substitute into the `--command=` pattern above:

```bash
# Gateway status
sudo docker exec openclaw-gateway openclaw status

# Container logs
sudo docker logs openclaw-gateway --tail 50

# Agent ears logs
sudo tail -20 /var/log/agent-ears.log

# Agent mouth logs
sudo tail -20 /var/log/agent-mouth.log

# Manual brain dispatch (plan-exec mode)
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-exec --plan-exec temporal-research "test" 30

# Read telemetry
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-telemetry-read --last 10

# Check PLAN.md
sudo docker exec openclaw-gateway cat /home/node/.openclaw/workspace/PLAN.md

# Check rendered config hooks
sudo docker exec openclaw-gateway grep -A 20 hooks /home/node/.openclaw/openclaw.json

# OpenClaw version
sudo docker exec openclaw-gateway openclaw --version

# CoreKit install state
sudo docker exec openclaw-gateway cat /home/node/.openclaw/corekit/STATE.json

# List workspace files
sudo docker exec openclaw-gateway find /home/node/.openclaw/workspace -name '*.md' -type f
```

## Interactive SSH (when needed)

```powershell
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap
# then inside:
sudo docker exec -it openclaw-gateway bash
```
