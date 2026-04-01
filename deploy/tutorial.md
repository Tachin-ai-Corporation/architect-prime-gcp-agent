# Deploy Architect Prime

## Overview

This tutorial deploys the **Architect Prime** control plane into your GCP project.

After deployment, you'll have a web dashboard where you can:
- Deploy and manage Prime AI agent instances
- Chat with each Prime in real-time
- Manage your fleet of specialized agents

**Estimated time:** 5 minutes

---

## Select your GCP project

<walkthrough-project-setup billing="true"></walkthrough-project-setup>

Set your project:

```sh
export PROJECT_ID={{project-id}}
```

## Run the installer

The installer will:
1. Enable required GCP APIs
2. Create a Firestore database
3. Set up service accounts and IAM
4. Deploy the Cloud Run control plane

```sh
bash deploy/install.sh
```

## Open your dashboard

Once deployment completes, click the **Control Plane URL** printed in the terminal.

Sign in with your Google Workspace admin account to get started.

## Next step: Deploy a Prime

In the dashboard, click **"+ Deploy Prime"** to create your first Prime agent instance.

Prime will come online in about 10 minutes and you can start chatting!

## Domain-Wide Delegation (required for fleet agents)

When you hire fleet agents, they communicate via Google Chat using Domain-Wide Delegation.

The dashboard will guide you through configuring DWD in your Workspace Admin Console.

---

**Congratulations!** Your Architect Prime control plane is deployed. 🎉
