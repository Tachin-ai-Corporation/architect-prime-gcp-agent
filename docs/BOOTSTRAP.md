# Bootstrap Guide — Architect Prime

Complete instructions to launch Prime from an empty GCP project.

## Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- You are a project Owner
- The repo cloned (`git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent`)

## Step 1: Set your environment

```bash
# Required
export PROJECT_ID="your-gcp-project-id"

# Required for fleet agent deployment
export BILLING_ACCOUNT="your-billing-account-id"
# Find it: gcloud billing accounts list

export GCP_ORG_ID="your-gcp-org-id"
# Find it: gcloud organizations list

# Optional overrides (these have sensible defaults)
export ZONE="us-central1-a"
export VM="architect-prime"
```

## Step 2: Run Phase 1 (5 minutes)

From Cloud Shell or your local terminal:

```bash
cd architect-prime-gcp-agent
bash bootstrap/phase1-cloudshell.sh
```

Phase 1 automatically:
- Enables 10 GCP APIs
- Creates service account `architect-prime` with required roles
- Creates firewall rule for HTTPS
- Creates GCS inbox bucket for Chat relay
- Deploys the Chat handler Cloud Function
- Creates the VM with Phase 2 startup script
- Passes `billing_account` to VM metadata (for fleet-deploy)

**When it finishes, it prints all key values and next steps.**

## Step 3: Wait for Phase 2 (~15-20 minutes)

Phase 2 runs automatically on the VM. No human action needed.

It installs Docker, builds the OpenClaw container, downloads CoreKit files,
and starts the inbox-daemon service.

Monitor progress:
```bash
gcloud compute instances get-serial-port-output $VM --zone $ZONE --project $PROJECT_ID
```

Look for: `✅ PHASE 2 COMPLETE`

## Step 4: Configure Chat (one-time, ~3 minutes)

### 4a. Set up the Chat app

Go to: `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=YOUR_PROJECT`

| Setting | Value |
|---|---|
| App name | `Architect Prime` |
| Avatar URL | `https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/robot_2/default/48px.svg` |
| Description | `GCP fleet orchestrator` |
| Interactive features | ✅ Enabled |
| Connection settings | HTTP endpoint URL → paste Cloud Function URL from Phase 1 output |
| Visibility | Your domain or specific users |

Save.

### 4b. Create a Chat space

- Open Google Chat → create a new space (e.g., "Architect Prime Ops")
- Add the "Architect Prime" app to the space

### 4c. Set the space ID

Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`).

```bash
gcloud compute instances add-metadata $VM \
  --zone $ZONE --project $PROJECT_ID \
  --metadata=chat_space_id=spaces/YOUR_SPACE_ID
```

## Step 5: Test

Message `@Architect Prime help` in your Chat space.

Expected: immediate "⏳ Processing..." followed by a response with available commands.

Try `@Architect Prime status` to see VM info.

## Fleet Agents (optional)

After Prime is running, deploy fleet agents from Prime's VM:

```bash
# SSH into Prime
gcloud compute ssh $VM --zone $ZONE --project $PROJECT_ID

# Deploy a fleet agent (creates its own GCP project)
sudo /opt/openclaw/.openclaw/bin/fleet-deploy --name alpha --specialty "billing expert"

# fleet-deploy prints Chat setup instructions for the new agent
```

Each fleet agent gets its own GCP project, Cloud Function, and Chat app.
Users can @-mention fleet agents directly (e.g., `@Fleet Alpha help`).

## Summary

| Step | Duration | Human Action |
|---|---|---|
| Environment | ~30 sec | Set `PROJECT_ID` + `BILLING_ACCOUNT` |
| Phase 1 | ~5 min | Run one script |
| Phase 2 | ~15-20 min | None (automatic) |
| Chat setup | ~3 min | Console clicks + one gcloud command |
| Test | ~30 sec | Chat message |

**Total: ~25 minutes from empty project to Prime responding in Chat.**
