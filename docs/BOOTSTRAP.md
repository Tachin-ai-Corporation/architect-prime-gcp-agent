# Bootstrap Guide — Architect Prime

Complete instructions to launch Prime from an empty GCP project.

## Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- You are a project Owner
- The repo cloned (`git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent`)

## Step 1: Run Phase 1 (5 minutes)

From Cloud Shell or your local terminal:

```bash
cd architect-prime-gcp-agent
export PROJECT_ID=your-gcp-project-id    # required
export ZONE=us-central1-a                # optional, this is the default
bash bootstrap/phase1-cloudshell.sh
```

Phase 1 automatically:
- Enables 10 GCP APIs
- Creates service account `architect-prime` with required roles
- Creates firewall rule for HTTPS
- Creates GCS inbox bucket for Chat relay
- Deploys the Chat handler Cloud Function
- Creates the VM with Phase 2 startup script

**When it finishes, it prints all key values and next steps.**

## Step 2: Wait for Phase 2 (~15-20 minutes)

Phase 2 runs automatically on the VM. No human action needed.

It installs Docker, builds the OpenClaw container, downloads 38 CoreKit files,
and starts the inbox-daemon service.

Monitor progress:
```bash
gcloud compute instances get-serial-port-output architect-prime --zone us-central1-a
```

Look for: `✅ PHASE 2 COMPLETE`

## Step 3: Configure Chat (one-time, ~3 minutes)

### 3a. Set up the Chat app

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

### 3b. Create a Chat space

- Open Google Chat → create a new space (e.g., "Architect Prime Ops")
- Add the "Architect Prime" app to the space

### 3c. Set the space ID

Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`).

```bash
gcloud compute instances add-metadata architect-prime \
  --zone us-central1-a \
  --metadata=chat_space_id=spaces/YOUR_SPACE_ID
```

## Step 4: Test

Message `@Architect Prime help` in your Chat space.

Expected: immediate "⏳ Processing..." followed by a response with available commands.

Try `@Architect Prime status` to see VM info.

## Summary

| Step | Duration | Human Action |
|---|---|---|
| Phase 1 | ~5 min | Run one script |
| Phase 2 | ~15-20 min | None (automatic) |
| Chat setup | ~3 min | Console clicks + one gcloud command |
| Test | ~30 sec | Chat message |

**Total: ~25 minutes from empty project to Prime responding in Chat.**
