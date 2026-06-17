---
description: Query and debug Firestore data for Prime agents — messages, tasks, dispatch telemetry, fleet status. Use when verifying daemon behavior, telemetry writes, or task lifecycle.
---

# Firestore Query & Agent Investigation

> All queries run **via the VM** using its metadata credentials. This avoids local auth issues.
> Follow `/ssh-vm-access` Step 1 if you don't know the VM name/zone.

## Step 0: Identify the Right VM

Each agent runs on its own VM. **Always SSH to the agent's own VM** for logs and Firestore queries.

| VM Name | Agent | Email |
|---------|-------|-------|
| `prime-chuck` | Prime orchestrator | — |
| `fleet-archie` | Product Architect Archie | product-architect-archie@tachin.ag |
| `fleet-bobby` | SWE Agent Bobby | swe-agent-bobby@tachin.ag |
| `fleet-stan` | DevOps Agent Stan | devops-agent-stan@tachin.ag |

**Zone**: All VMs are in `us-central1-a`.
**Project**: `architect-prime-beta`.

## Step 1: Start with Journal Logs (Fastest)

**Always check journal logs FIRST.** They show what the brain daemon is doing in real-time — no Firestore query needed. These work directly from PowerShell with no escaping issues.

```powershell
# Brain daemon logs — shows mission processing, cortex decisions, motor dispatches
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 80"

# Brain daemon logs — since a specific time
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 80 --since '2026-06-12 19:00'"

# Gateway logs — shows LLM calls, tool use, step progression for motor/cortex
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-neural-gateway --no-pager -n 50"

# Ears logs — shows inbound message pickup from GChat/Firestore
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -50 /var/log/agent-ears.log"

# Mouth logs — shows outbound message delivery to GChat
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -50 /var/log/agent-mouth.log"

# Service status — check if daemons are running or crash-looping
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo systemctl status agent-brain agent-neural-gateway agent-ears agent-mouth --no-pager"
```

### What to Look For in Brain Logs

| Log Pattern | Meaning |
|------------|---------|
| `Processing envelope: w-... (type=M, status=active)` | Mission being worked |
| `Cortex decision: action=checkpoint_plan` | Cortex planning work |
| `Dispatching to motor via brain/motor` | Motor executing a task |
| `Agent motor timed out` | Motor hit 300s timeout |
| `CP1 Task 1 failed (motor)` | Task failed, may retry |
| `Mission ... completed` | Mission finished |
| `Classify result: continue` | Resuming blocked mission |
| `ERR_MODULE_NOT_FOUND` | Missing file — crash loop |
| `restart counter is at N` | Service crash-looping (N > 10 = bad) |

### What to Look For in Gateway Logs

| Log Pattern | Meaning |
|------------|---------|
| `Executing tool runCommand with args: {...}` | Motor running a command |
| `Google model returned N tool call(s)` | LLM tool use step |
| `step N/50` | Motor iteration count (high = struggling) |
| `completed (N chars, ? tokens)` | LLM call finished |

## Step 2: Firestore Queries (When You Need Data)

### ⚠️ PowerShell Escaping Warning

PowerShell aliases `curl` to `Invoke-WebRequest` and mangles complex `--command` strings. **Do NOT try to inline `curl` commands** in gcloud SSH from PowerShell. Instead use the SCP Script Pattern:

1. Write a bash script locally (use `write_to_file` to a scratch path)
2. SCP it to the VM
3. Run via SSH

```powershell
# SCP script to VM
echo y | gcloud compute scp "C:\path\to\script.sh" {VM_NAME}:/tmp/script.sh --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap

# Run it (strip CRLF from Windows)
echo y | gcloud compute ssh {VM_NAME} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sed -i 's/\r$//' /tmp/script.sh && bash /tmp/script.sh"
```

### ⚠️ Composite Index Warning

**Structured queries with multiple `where` filters + `orderBy` require composite indexes.** If no index exists, Firestore returns an empty result — NO error. Use only **single-field filters** or **no filters** with `orderBy` to avoid silent failures.

### Script: List Recent Work Envelopes (Any Agent)

Use this to see what missions exist. **No composite index needed.**

```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"structuredQuery":{"from":[{"collectionId":"work"}],"orderBy":[{"field":{"fieldPath":"created_at"},"direction":"DESCENDING"}],"limit":10}}' \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery' \
  | python3 -c "
import sys, json
for item in json.load(sys.stdin):
    doc = item.get('document', {})
    if not doc: continue
    f = doc.get('fields', {})
    print(f'--- {f.get(\"id\",{}).get(\"stringValue\",\"?\")} ({f.get(\"type\",{}).get(\"stringValue\",\"?\")}) ---')
    print(f'  Owner:   {f.get(\"owner\",{}).get(\"stringValue\",\"?\")}')
    print(f'  Title:   {f.get(\"title\",{}).get(\"stringValue\",\"?\")}')
    print(f'  Status:  {f.get(\"status\",{}).get(\"stringValue\",\"?\")}')
    print(f'  Created: {f.get(\"created_at\",{}).get(\"stringValue\",\"?\")}')
    print(f'  Output:  {f.get(\"output\",{}).get(\"stringValue\",\"\")[:300]}')
    print()
"
```

### Script: Read a Specific Work Envelope

```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# Replace ENVELOPE_ID with the actual ID (e.g., w-1781293786846-31941720)
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/work/ENVELOPE_ID' \
  | python3 -c "
import sys, json
f = json.load(sys.stdin).get('fields', {})
for k, v in sorted(f.items()):
    val = v.get('stringValue', v.get('integerValue', v.get('booleanValue', v.get('arrayValue', '...'))))
    s = str(val)[:400]
    print(f'{k}: {s}')
"
```

### Script: List Projects

```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s -H "Authorization: Bearer $TOKEN" \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/projects' \
  | python3 -c "
import sys, json
for doc in json.load(sys.stdin).get('documents', []):
    f = doc.get('fields', {})
    name = doc['name'].split('/')[-1]
    title = f.get('title', {}).get('stringValue', '?')
    team = f.get('team', {}).get('arrayValue', {}).get('values', [])
    members = [m.get('mapValue',{}).get('fields',{}).get('email',{}).get('stringValue','?') for m in team]
    print(f'{name}: {title} | team: {members}')
"
```

## Collection Paths

All paths relative to: `primes/chucknorris/`

| Collection | Content |
|-----------|---------|
| `work/{id}` | M/C/T work envelopes |
| `intake/{id}` | Inbound messages from ears |
| `work_archive/{id}` | Archived envelopes |
| `projects/{id}` | Project registry (top-level, not under primes) |
| `processes/{id}` | Process definitions |
| `approvals/{id}` | Approval gates |
| `fleet/{agent_id}` | Fleet agent status |
| `messages` | Chat messages |
| `commands` | Dashboard commands |

> **Note:** `projects` is a top-level collection, NOT under `primes/chucknorris/`.

## Agent Investigation Playbook

When asked to check on an agent's work, follow this order:

1. **Service status** — Is the brain running or crash-looping?
2. **Brain journal logs** — What mission is it processing? Any errors?
3. **Gateway journal logs** — What is motor doing? How many steps? Tool calls?
4. **Firestore work query** — Only if you need envelope details not visible in logs
5. **Mouth logs** — Did the response get delivered to GChat?

### Common Failure Patterns

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERR_MODULE_NOT_FOUND` crash loop | Missing file after upgrade | Re-deploy via dashboard |
| `restart counter is at 5000+` | Crash-looping for hours | Fix the missing module, redeploy |
| Motor at step 40+/50 | Motor confused, looping on readFile | Task instruction too vague, or tool API unclear |
| `Agent motor timed out (300s)` | Motor couldn't finish in time | Brain auto-retries; may need clearer instructions |
| Empty Firestore query results | Missing composite index (silent fail) | Remove multi-field filters, use single filter + orderBy |
| No intake messages | Ears not picking up GChat | Check ears logs and service status |

## Notes
- **Zone**: All VMs in `us-central1-a`.
- **Project**: `architect-prime-beta`.
- **Token refresh**: VM metadata tokens auto-refresh; no manual auth needed.
- **400 Bad Request**: Firestore paths need even segment counts (collection/document pairs).
