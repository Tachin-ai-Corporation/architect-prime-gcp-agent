---
description: SSH into a Prime or Fleet VM and execute commands inside the OpenClaw Docker container. Use when you need to debug, inspect, or test anything on a running agent VM. For deploying changes, use the dashboard upgrade button instead.
---

# SSH VM Access

> SSH is for **debugging only**. Deploy via dashboard. Send messages via dashboard chat.

## Prime VM

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15
```

## Fleet VM

```bash
gcloud compute ssh fleet-{agent-name} --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15
```

## One-shot Docker exec (preferred)

```bash
sudo docker exec openclaw-gateway <command>
```

## Common commands

```bash
# Gateway status
sudo docker exec openclaw-gateway openclaw status

# Container logs
sudo docker logs openclaw-gateway --tail 50

# Control-daemon logs
sudo journalctl -u control-daemon --since "10 min ago" --no-pager

# Manual brain dispatch
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-exec temporal-research "test" 30

# Read telemetry
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-telemetry-read --last 10

# Check PLAN.md
sudo docker exec openclaw-gateway cat /home/node/.openclaw/workspace/PLAN.md

# Check rendered config
sudo docker exec openclaw-gateway cat /home/node/.openclaw/openclaw.json | python3 -m json.tool

# OpenClaw version
sudo docker exec openclaw-gateway openclaw --version
```

## One-liner (no interactive SSH)

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo docker exec openclaw-gateway <command>"
```
