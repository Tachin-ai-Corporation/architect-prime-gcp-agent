---
description: Query and debug Firestore data for Prime agents — messages, tasks, dispatch telemetry, fleet status. Use when verifying daemon behavior, telemetry writes, or task lifecycle.
---

# Firestore Query

> All queries run **via the VM** using its metadata credentials. This avoids local auth issues.
> Follow `/ssh-vm-access` Step 1 if you don't know the VM name/zone.

## ⚠️ PowerShell Escaping Warning

PowerShell aliases `curl` to `Invoke-WebRequest` and mangles complex `--command` strings. **Do NOT try to inline `curl` commands** in gcloud SSH from PowerShell. Instead:

### Recommended: SCP Script Pattern

1. Write a bash script locally (use `write_to_file` to a scratch path)
2. SCP it to the VM
3. Run via SSH

```powershell
# SCP script to VM
echo y | gcloud compute scp "C:\path\to\script.sh" {VM_NAME}:/tmp/script.sh --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap

# Run it (strip CRLF from Windows)
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sed -i 's/\r$//' /tmp/script.sh && bash /tmp/script.sh"
```

### Script Template

```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# Simple document read
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/{COLLECTION_PATH}' \
  | python3 -m json.tool

# Structured query (requires composite indexes)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"structuredQuery":{"from":[{"collectionId":"{COLLECTION}"}],"limit":5}}' \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery' \
  | python3 -m json.tool
```

## Collection Paths

All paths relative to: `primes/chucknorris/`

| Collection | Content |
|-----------|---------|
| `work/{id}` | M/C/T work envelopes |
| `intake/{id}` | Inbound messages from ears |
| `work_archive/{id}` | Archived envelopes |
| `projects/{id}` | Project registry |
| `processes/{id}` | Process definitions |
| `approvals/{id}` | Approval gates |
| `fleet/{agent_id}` | Fleet agent status |
| `messages` | Chat messages |
| `commands` | Dashboard commands |

## Safe Inline Commands

These don't use `curl` and work directly from PowerShell:

```powershell
# Brain daemon logs
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 50"

# Ears logs
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -30 /var/log/agent-ears.log"

# Mouth logs
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -30 /var/log/agent-mouth.log"

# Brain gateway logs
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain-gateway --no-pager -n 50"

# Workspace files
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="find /opt/corekit/workspace -name '*.md' -type f"

# Contracts config
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="cat /opt/corekit/corekit/contracts.json"
```

## Dashboard API

```
GET https://architect-prime-rbkdxfrvva-uc.a.run.app/api/primes/chucknorris/commands?limit=5
GET https://architect-prime-rbkdxfrvva-uc.a.run.app/api/upgrade
```

> Dashboard API requires authentication (returns 401 without valid session).

## Notes
- **Replace `chucknorris`** with the target Prime ID as needed.
- **Replace `{VM_NAME}`** with `fleet-stan`, `prime-chucknorris`, etc.
- **Zone**: All current VMs are in `us-central1-a`.
- **400 Bad Request**: Firestore paths need even segment counts (collection/document pairs).
- **Token refresh**: VM metadata tokens auto-refresh; no manual auth needed.
- **Index errors**: Structured queries with filters + orderBy may need composite indexes. Use raw REST `GET` on collection URL to avoid.
