# Google Chat Setup (DWD — Domain-Wide Delegation)



Architect Prime and fleet agents communicate through Google Chat using **Domain-Wide Delegation (DWD)**. Agents impersonate Workspace user accounts — no Chat apps or Cloud Functions needed.

## Prerequisites

- Google Workspace domain with admin access
- An Architect Prime deployment (see [BOOTSTRAP.md](BOOTSTRAP.md))
- The SA Client ID (printed at the end of Phase 1 bootstrap)

## One-Time Setup (Workspace Super Admin)

### Step 1: Grant DWD

1. Go to [Admin Console](https://admin.google.com) → **Security** → **Access and data control** → **API Controls**
2. Scroll to **Domain-Wide Delegation** → click **Manage Domain Wide Delegation**
3. Click **Add new**
4. **Client ID:** Enter the DWD Signer SA Client ID (shown in the Dashboard → Setup tab)
5. **OAuth Scopes:**
   ```
   https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/admin.directory.orgunit,https://www.googleapis.com/auth/admin.directory.user
   ```
6. Click **Authorize**
7. Wait up to 24 hours for propagation (usually much faster)

> **Note:** This DWD grant covers ALL agents — Prime and every fleet agent. It only needs to be done once per SA Client ID.

### Step 2: Create Agent User Accounts

Create Workspace user accounts for each agent. The naming pattern is `job-agent-name@yourdomain.com`:

- **Prime:** `architect-agent-prime@yourdomain.com`
- **Fleet agents** (created as needed):
  - `devops-agent-stan@yourdomain.com`
  - `finance-agent-amy@yourdomain.com`
  - `qa-agent-felix@yourdomain.com`

### Step 3: Create a Chat Space

1. Open Google Chat → **New space**
2. Add the agent user account(s)
3. Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`)

### Step 4: Configure the Agent

Set the agent user email and space ID via VM metadata:
```bash
gcloud compute instances add-metadata architect-prime --zone us-central1-a \
  --metadata=agent_user_email=architect-agent-prime@yourdomain.com,chat_space_id=spaces/YOUR_SPACE_ID
```

Or set env vars before bootstrap:
```bash
export AGENT_USER_EMAIL=architect-agent-prime@yourdomain.com
export CHAT_SPACE_ID=spaces/YOUR_SPACE_ID
```

### Step 5: Test

@-mention the agent user in the Chat space. The `agent-ears` service detects the mention and routes it to the brain gateway. `agent-mouth` delivers the response.

## How It Works

```
Human @-mentions agent user in Chat
    │
    ▼
agent-ears polls Chat API (spaces.messages.list)
    │ uses DWD: SA impersonates agent user via signJwt
    │
    ▼
Detects @-mention → fires gateway POST (non-blocking)
    │
    └── Brain gateway (Vertex AI Gemini)
            │
            ├── Pure Q&A → conversational response
            └── Tool invocation (if needed)
                    │
                    ▼
    agent-mouth polls gateway logs → classifies → delivers
    │
    └── chat-send (DWD) → posts response as the agent user
```

## Adding Fleet Agents

When Prime hires a fleet agent (`fleet-deploy`):

1. **Prime creates the fleet agent's VM** (single-project — all agents share Prime's GCP project):
   ```bash
   fleet-deploy --name stan --specialty devops --agent-email devops-agent-stan@yourdomain.com
   ```
   Or tell Prime colloquially via the dashboard: _"hire a devops agent named stan"_

2. **You (admin) create a Workspace user** for the fleet agent:
   - Go to [Admin Console](https://admin.google.com) → **Users** → **Add new user**
   - Create: `devops-agent-stan@yourdomain.com`

3. **Move the user to the AI Agents OU** (restricts external Drive sharing):
   - Go to **Admin Console** → **Directory** → **Organizational Units**
   - Move `devops-agent-stan@yourdomain.com` into the **AI Agents** OU
   - This is checked automatically by `fleet-health-check` every 15 minutes.
     If the agent isn't in the correct OU, the dashboard will show a warning.

4. **Add the fleet user to the Chat space:**
   - Open your Chat space → **Add people** → `devops-agent-stan@yourdomain.com`

5. **Verify comms:**
   ```bash
   fleet-verify --name stan
   ```
   Or: @-mention `@Devops Agent Stan help` directly in Chat

The same DWD grant covers all agents — **no per-agent Chat app configuration needed**.

## Upgrading Fleet Agents

```bash
fleet-upgrade --name stan --ref v0.8.0
```
Or colloquially to Prime: _"Upgrade stan to latest"_

## Removing Fleet Agents

```bash
fleet-teardown --name stan
```
Or colloquially: _"Tear down the stan agent"_
