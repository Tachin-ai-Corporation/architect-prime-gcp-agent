---
description: SSH into a Prime or Fleet VM and execute commands inside the OpenClaw Docker container. Use this workflow whenever you need to debug, inspect, or test anything on a running agent VM.
---

# SSH + Docker Exec — Remote Agent Debugging

> **When to use:** SSH is for **debugging and inspection only**. For deploying changes, use the dashboard upgrade button (`/deploy-corekit`). For sending messages, use the dashboard chat or `/firestore-query`.

## Prerequisites
- `gcloud` CLI authenticated with access to `architect-prime-beta`
- Target VM must be running

## SSH into a Prime VM

// turbo
```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15
```

## SSH into a Fleet VM

// turbo
```bash
gcloud compute ssh fleet-{agent-name} --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15
```

## Execute a command inside the OpenClaw container

Once SSH'd in, all agent tools live inside Docker:

```bash
# Interactive shell
sudo docker exec -it openclaw-gateway bash

# One-shot command (preferred — no interactive session needed)
sudo docker exec openclaw-gateway <command>
```

## Common debugging patterns

```bash
# Check gateway status
sudo docker exec openclaw-gateway openclaw status

# Check container logs (gateway startup, errors)
sudo docker logs openclaw-gateway --tail 50

# Check control-daemon logs (message processing, ack forwarding)
sudo journalctl -u control-daemon --since "10 min ago" --no-pager

# Run a brain dispatch manually (bypass control-daemon)
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-exec temporal-research "test-query" 30

# Read dispatch telemetry
sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-telemetry-read --last 10

# Check PLAN.md (v5.2 compliance verification)
sudo docker exec openclaw-gateway cat /home/node/.openclaw/workspace/PLAN.md 2>/dev/null

# Check rendered gateway config
sudo docker exec openclaw-gateway cat /home/node/.openclaw/openclaw.json | python3 -m json.tool

# Check which OpenClaw version is running
sudo docker exec openclaw-gateway openclaw --version
```

## One-liner from local machine (no interactive SSH)

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo docker exec openclaw-gateway <command>"
```

## Troubleshooting
- **SSH timeout:** IAP tunnel may take 10-15s. Increase `ConnectTimeout` to 30.
- **Container not running:** `sudo docker ps` — if empty, check `sudo docker logs openclaw-gateway 2>&1 | tail 20`
- **Permission denied:** Tools must be run as root (`sudo docker exec`) not as the SSH user.
