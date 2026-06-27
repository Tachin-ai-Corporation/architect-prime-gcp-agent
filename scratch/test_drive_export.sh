#!/usr/bin/env bash
TOKEN=$(AGENT_USER_EMAIL=assistant-agent-millie@tachin.ag /opt/corekit/bin/ws-token --scope drive)
curl -i -s -H "Authorization: Bearer $TOKEN" "https://www.googleapis.com/drive/v3/files/1K1qmGve-zgKlpRBNSncvp7yeypiZ1AzgnqD11ggMsHk/export?mimeType=text/plain"
