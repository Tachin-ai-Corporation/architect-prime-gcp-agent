# Google Chat Setup Guide

## Overview

Bootstrap (`phase1-cloudshell.sh`) automatically:
- Enables the Chat API
- Creates the GCS inbox bucket
- Deploys the Cloud Function (`chat-handler`)
- Prints the Cloud Function URL at the end

You only need to do **one manual step**: point the Chat app to the Cloud Function URL.

## One-Time Setup (per project)

### 1. Configure the Chat App

Go to: `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=YOUR_PROJECT_ID`

- **App name**: `Architect Prime`
- **Avatar URL**: `https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/robot_2/default/48px.svg`
- **Description**: `GCP fleet orchestrator`
- **Interactive features**: ✅ Enable
- **Connection settings**: HTTP endpoint URL → paste the Cloud Function URL from bootstrap output
- **Visibility**: Your domain or specific users
- **Save**

### 2. Create a Chat Space

- Open Google Chat
- Create a space (e.g., "Architect Prime Ops")
- Add the "Architect Prime" app to the space

### 3. Set the Space ID

Get the space ID from the Chat URL (format: `spaces/XXXXXXXXX`) and pass it to bootstrap:

    export CHAT_SPACE_ID=spaces/YOUR_SPACE_ID

Or set it in VM metadata:

    gcloud compute instances add-metadata architect-prime \
      --metadata=chat_space_id=spaces/YOUR_SPACE_ID

### 4. Test

Message `@Architect Prime help` in the Chat space. You should get a response with available commands.

## Architecture

    Chat → Cloud Function → GCS inbox/{agent-id}/pending/ → inbox-daemon → OpenClaw → chat-send → Chat
