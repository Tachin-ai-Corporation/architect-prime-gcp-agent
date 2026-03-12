# Google Chat Setup (DWD — Domain-Wide Delegation)

Architect Prime communicates through Google Chat using **Domain-Wide Delegation (DWD)**. Agents impersonate Workspace user accounts — no Chat apps or Cloud Functions needed.

## Prerequisites

- Google Workspace domain with admin access
- An Architect Prime deployment (see [BOOTSTRAP.md](BOOTSTRAP.md))
- The SA Client ID (printed at the end of Phase 1 bootstrap)

## One-Time Setup (Workspace Super Admin)

### Step 1: Grant DWD

1. Go to [Admin Console](https://admin.google.com) → **Security** → **Access and data control** → **API Controls**
2. Scroll to **Domain-Wide Delegation** → click **Manage Domain Wide Delegation**
3. Click **Add new**
4. **Client ID:** Enter Prime's SA Client ID (printed by `phase1-cloudshell.sh`)
5. **OAuth Scopes:**
   ```
   https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly
   ```
6. Click **Authorize**
7. Wait up to 24 hours for propagation (usually much faster)

### Step 2: Create Agent User Accounts

Create Workspace user accounts for each agent:
- `prime@yourdomain.com` (for Architect Prime)
- Fleet agents will need their own accounts (e.g., `fleet-alpha@yourdomain.com`)

### Step 3: Create a Chat Space

1. Open Google Chat → **New space**
2. Add the agent user account (e.g., `prime@yourdomain.com`)
3. Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`)

### Step 4: Configure the Agent

Set the agent user email and space ID via VM metadata:
```bash
gcloud compute instances add-metadata architect-prime --zone us-central1-a \
  --metadata=agent_user_email=prime@yourdomain.com,chat_space_id=spaces/YOUR_SPACE_ID
```

Or set env vars before bootstrap:
```bash
export AGENT_USER_EMAIL=prime@yourdomain.com
export CHAT_SPACE_ID=spaces/YOUR_SPACE_ID
```

### Step 5: Test

@-mention the agent user in the Chat space. The `inbox-daemon` detects the mention and responds.

## How It Works

```
Human @-mentions agent user in Chat
    │
    ▼
inbox-daemon polls Chat API (spaces.messages.list)
    │ uses DWD: SA impersonates agent user via signJwt
    │
    ▼
Detects @-mention → processes message
    │
    ├── Built-in commands: help, status, whoami, fleet
    └── Everything else → agent-ask (Vertex AI Gemini)
            │
            ▼
    chat-send (DWD) → posts response as the agent user
```

## Adding Fleet Agents

When Prime hires a fleet agent (`fleet-deploy`):

1. Prime creates the fleet agent's GCP project + VM
2. You (admin) create a Workspace user for the fleet agent
3. Add the fleet user to the shared Chat space
4. Prime verifies comms (fleet intro — coming in v0.8.0)

The same DWD grant covers all agents — no per-agent Chat app configuration needed.
