# Google Chat Setup — One-Time Configuration

Architect Prime communicates with humans and fleet agents through Google Chat.
This setup is required **once per GCP project**.

## Prerequisites

- Google Workspace with Google Chat enabled
- Access to the GCP project console (`architect-prime-beta`)
- A Google Chat space where Prime will post

## Steps

### 1. Enable the Google Chat API

Already done in `phase1-cloudshell.sh` — but verify:

```bash
gcloud services list --enabled --filter="name:chat.googleapis.com" --project=architect-prime-beta
```

### 2. Configure the Chat App

1. Go to: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=architect-prime-beta
2. Click **"Configure"** (or "Configuration" tab)
3. Fill in:
   - **App name**: `Architect Prime`
   - **Avatar URL**: `https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/robot_2/default/48px.svg`
   - **Description**: `GCP fleet orchestrator`
   - **Enable Interactive features**: ✅ (for later checkpoints)
   - **Connection settings**: Choose **"Apps Script"** or **"HTTP endpoint"** (for v0.4.0, we only send outbound — this can be a placeholder)
   - **Visibility**: Make available to your domain or specific users
4. Click **Save**

### 3. Create or Choose a Chat Space

1. Open Google Chat
2. Create a space (e.g., "Architect Prime Ops") or use an existing one
3. Add the Architect Prime app to the space:
   - In the space, click the space name → "Manage webhooks" or "Apps & integrations"
   - Add "Architect Prime" app

### 4. Get the Space ID

```bash
# List spaces the bot can see (run on the VM):
curl -s -H "Authorization: Bearer $(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  | grep -o '"access_token":"[^"]*"' | sed 's/"access_token":"//;s/"//')" \
  'https://chat.googleapis.com/v1/spaces' | python3 -m json.tool
```

The space ID looks like: `spaces/AAAAxxxxxxx`

### 5. Configure Prime

Set the space ID as a VM metadata key:

```bash
gcloud compute instances add-metadata architect-prime \
  --zone=us-central1-a \
  --project=architect-prime-beta \
  --metadata=chat_space_id=spaces/YOUR_SPACE_ID
```

Or write directly to the config file on the VM:

```bash
sudo tee /opt/openclaw/.openclaw/corekit/chat-config.json <<EOF
{
  "spaceId": "spaces/YOUR_SPACE_ID",
  "botDisplayName": "Architect Prime",
  "projectId": "architect-prime-beta"
}
EOF
```

### 6. Test

```bash
# On the VM:
export CHAT_SPACE_ID="spaces/YOUR_SPACE_ID"
/opt/openclaw/.openclaw/bin/chat-send "Hello from Architect Prime!"
```

## Troubleshooting

- **403 Forbidden**: The Chat app hasn't been added to the space, or the SA doesn't have the `chat.bot` scope
- **404 Not Found**: Wrong space ID format — must start with `spaces/`
- **Token error**: VM wasn't started with `chat.bot` scope — recreate with `--scopes=...chat.bot`
