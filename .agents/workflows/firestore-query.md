---
description: Query and debug Firestore data for Prime agents — messages, tasks, dispatch telemetry, fleet status. Use when verifying daemon behavior, telemetry writes, or task lifecycle.
---

# Firestore Query

> All queries run **via the VM** using its metadata credentials. This avoids local auth issues.
> Follow `/ssh-vm-access` Step 1 if you don't know the VM name/zone.

## Query pattern

```powershell
echo y | gcloud compute ssh {VM_NAME} --zone={ZONE} --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -H \"Authorization: Bearer $TOKEN\" '{FIRESTORE_URL}' | python3 -m json.tool"
```

## Common queries

All URLs below are relative to:
`https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents`

### Prime status

```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -H \"Authorization: Bearer \$TOKEN\" 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris' | python3 -m json.tool"
```

### Recent messages

```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -H \"Authorization: Bearer \$TOKEN\" 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/messages?pageSize=5&orderBy=createdAt%20desc' | python3 -m json.tool"
```

### Dispatch telemetry

```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -X POST -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"structuredQuery\":{\"from\":[{\"collectionId\":\"dispatch-log\"}],\"orderBy\":[{\"field\":{\"fieldPath\":\"startedAt\"},\"direction\":\"DESCENDING\"}],\"limit\":5}}' 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery' | python3 -m json.tool"
```

### Task lifecycle

```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -X POST -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"structuredQuery\":{\"from\":[{\"collectionId\":\"tasks\"}],\"orderBy\":[{\"field\":{\"fieldPath\":\"receivedAt\"},\"direction\":\"DESCENDING\"}],\"limit\":5}}' 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery' | python3 -m json.tool"
```

### Recent commands

```powershell
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"access_token\"])'); curl -s -X POST -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"structuredQuery\":{\"from\":[{\"collectionId\":\"commands\"}],\"orderBy\":[{\"field\":{\"fieldPath\":\"createdAt\"},\"direction\":\"DESCENDING\"}],\"limit\":5}}' 'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery' | python3 -m json.tool"
```

## Quick alternative: Service & container logs

Often faster than Firestore queries for debugging recent activity:

```powershell
# Agent ears logs (input processing)
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -30 /var/log/agent-ears.log"

# Agent mouth logs (output classification + delivery)
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -30 /var/log/agent-mouth.log"

# OpenClaw container logs (hooks, model calls, agent dispatch)
echo y | gcloud compute ssh prime-chucknorris --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo docker logs openclaw-gateway --tail 50 2>&1 | tail -50"
```

## Dashboard API (also works via browser)

```
GET https://architect-prime-rbkdxfrvva-uc.a.run.app/api/primes/chucknorris/commands?limit=5
GET https://architect-prime-rbkdxfrvva-uc.a.run.app/api/upgrade
```

## Notes
- **Replace `chucknorris`** with the target Prime ID as needed.
- **400 Bad Request**: Firestore paths need even segment counts (collection/document pairs).
- **Token refresh**: VM metadata tokens auto-refresh; no manual auth needed.
