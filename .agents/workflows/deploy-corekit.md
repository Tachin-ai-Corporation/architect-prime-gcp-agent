---
description: Deploy code changes to a running Prime or Fleet VM without full reboot. Use after editing CoreKit scripts, brain workspace files, or gateway config.
---

# Deploy CoreKit Changes

## Philosophy
Push code to `main`, then use the **dashboard upgrade button** to deploy. SSH is for debugging, not for deploying. The dashboard tracks upgrade state, shows progress, and ensures consistency across Prime + fleet.

## Step 1: Stage and push

// turbo
```bash
git add -A && git status
```

Review staged files, then push:

```bash
git commit -m "v5.2: description of changes" && git push origin main
```

## Step 2: Deploy via Dashboard

1. Open the Architect Prime dashboard
2. Navigate to the Prime instance (e.g., ChuckNorris)
3. Click the **Upgrade** button (appears when the dashboard detects `main` is ahead of deployed version)
4. The dashboard triggers `upgrade-corekit` on the VM via the command-runner service
5. Watch the progress indicator — it shows: downloading → installing → validating → restarting

### What the upgrade does (behind the scenes)
- Reads `STATE.json` to determine role (`prime`/`fleet`) and job (specialty)
- Downloads latest manifest files from GitHub `main` branch
- Installs base + role + job manifest fragments (overwrites existing)
- Runs `validate-contracts` to ensure consistency
- Runs `render-config` to regenerate `openclaw.json` from template
- Restarts `openclaw-gateway` container and `control-daemon` service

## Step 3: Verify via Dashboard

After upgrade completes:
- Check the Prime status badge shows **Online**
- Send a test message in the dashboard chat to confirm the agent responds
- Check fleet agents if the change affects them — upgrade each via their detail page

## Fleet agents

Fleet agents are upgraded the same way — from each agent's detail page in the dashboard. The upgrade cascades through the same `upgrade-corekit` script.

## When to use SSH instead

SSH (`/ssh-vm-access`) is for **debugging**, not deploying:
- Gateway won't start after upgrade → SSH in, check `docker logs`
- Control-daemon crashing → SSH in, check `journalctl`
- Need to inspect container state → SSH in, `docker exec`
- Telemetry not writing → SSH in, run `brain-telemetry-read`

## Dashboard changes (Cloud Run)

Dashboard/API changes are NOT covered by CoreKit upgrades. After pushing app/ changes:
```bash
cd app && gcloud builds submit --tag us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --project=architect-prime-beta
gcloud run deploy architect-prime --image=us-docker.pkg.dev/architect-prime-beta/architect-prime/control-plane:latest --region=us-central1 --project=architect-prime-beta --allow-unauthenticated
```
