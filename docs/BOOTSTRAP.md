# Bootstrap Guide — Architect Prime (v0.7.1+ DWD)

Complete instructions to launch Prime from an empty GCP project.

## Prerequisites

| Requirement | How to get it |
|---|---|
| **GCP project** with billing enabled | [Create project](https://console.cloud.google.com/projectcreate) + [link billing](https://console.cloud.google.com/billing) |
| **gcloud CLI** installed and authenticated | `gcloud auth login` |
| **Project Owner** role for your user | Required for Phase 1 IAM bindings |
| **Google Workspace domain** | Required for DWD (Chat agent user accounts) |
| **Workspace Super Admin** access | Required for DWD grant (one-time) |
| **Repo cloned** | `git clone https://github.com/Tachin-ai-Corporation/architect-prime-gcp-agent` |
| **(Fleet only)** GCP Organization | `gcloud organizations list` |

## Step 1: Set your environment

```bash
# Required
export PROJECT_ID="your-gcp-project-id"

# Required for DWD Chat
export AGENT_USER_EMAIL="prime@yourdomain.com"  # Workspace user for Prime
export CHAT_SPACE_ID="spaces/XXXXXXXXX"         # Chat space ID (get from Step 3a)

# Required for fleet agent deployment
export BILLING_ACCOUNT="your-billing-account-id"   # gcloud billing accounts list
export GCP_ORG_ID="your-gcp-org-id"                # gcloud organizations list

# Optional overrides (these have sensible defaults)
export ZONE="us-central1-a"
export VM="architect-prime"
```

## Step 2: Pre-bootstrap manual setup (~10 min)

These steps CANNOT be automated — they require Workspace admin console access.

### 2a. Create the agent Workspace user

In [Google Admin Console](https://admin.google.com) → Users → Add new user:
- Create `prime@yourdomain.com` (or your preferred agent email)
- No special license needed, just a basic Workspace user

### 2b. Create a Google Chat space

1. Open Google Chat
2. Create a new space (e.g., "Architect Prime Ops")
3. Add `prime@yourdomain.com` to the space
4. Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`)
5. Set: `export CHAT_SPACE_ID=spaces/XXXXXXXXX`

### 2c. Grant DWD (after Phase 1 completes)

> **This step requires the SA Client ID from Phase 1 output.** Run Phase 1 first, then come back here.

1. Admin Console → **Security** → **Access and data control** → **API Controls**
2. Scroll to **Domain-Wide Delegation** → **Manage Domain Wide Delegation**
3. Click **Add new**
4. **Client ID:** the SA unique ID printed by Phase 1
5. **Scopes:**
   ```
   https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly
   ```
6. Click **Authorize**
7. May take up to 24 hours to propagate (usually minutes)

## Step 3: Run Phase 1 (~5 min)

From Cloud Shell or your local terminal:

```bash
cd architect-prime-gcp-agent
bash bootstrap/phase1-cloudshell.sh
```

Phase 1 automatically:
- Enables GCP APIs (Compute, AI Platform, Chat, IAM, Storage)
- Creates service account `architect-prime` with required roles
- Grants `roles/iam.serviceAccountTokenCreator` (needed for DWD `signJwt`)
- Creates firewall rule for HTTPS
- Creates the VM with Phase 2 startup script
- Passes all config to VM metadata
- Prints the **SA Client ID** needed for Step 2c (DWD grant)
- If `GCP_ORG_ID` is set, auto-grants org-level `projectCreator` + `billing.admin`

**⚠️  After Phase 1 completes:** Go back and complete Step 2c (DWD grant) using the SA Client ID.

## Step 4: Wait for Phase 2 (~15-20 min)

Phase 2 runs automatically on the VM. No human action needed.

It installs Docker, builds the OpenClaw container, downloads CoreKit files,
and starts the inbox-daemon service (DWD Chat polling mode).

Monitor progress:
```bash
gcloud compute instances get-serial-port-output $VM --zone $ZONE --project $PROJECT_ID
```

Look for: `✅ PHASE 2 COMPLETE`

## Step 5: Test

@-mention `prime@yourdomain.com` in the Chat space.

Expected: The inbox-daemon detects the @-mention and responds.

Try `@prime help` to see available commands, or `@prime status` for VM info.

> **Note:** If DWD hasn't propagated yet (up to 24h), the inbox-daemon will log auth errors. It will start working once DWD is active.

## Summary

| Step | Duration | Human Action |
|---|---|---|
| Environment | ~1 min | Set env vars |
| Create user + space | ~5 min | Admin Console + Chat UI |
| Phase 1 | ~5 min | Run one script |
| DWD grant | ~3 min | Admin Console (uses SA Client ID from Phase 1) |
| Phase 2 | ~15-20 min | None (automatic) |
| Test | ~30 sec | Chat message |

**Total: ~30 minutes from empty project to Prime responding in Chat.**

## Fleet Agents (optional)

After Prime is running, deploy fleet agents from Prime's VM:

```bash
# SSH into Prime
gcloud compute ssh $VM --zone $ZONE --project $PROJECT_ID

# Deploy a fleet agent (creates its own GCP project)
sudo /opt/openclaw/.openclaw/bin/fleet-deploy --name alpha --specialty "billing expert"
```

Each fleet agent needs:
1. A Workspace user account (e.g., `fleet-alpha@yourdomain.com`)
2. To be added to the shared Chat space
3. The same DWD grant already covers all agents (one SA Client ID per project)
