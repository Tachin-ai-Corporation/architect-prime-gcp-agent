---
name: fleet-work-investigation
description: "Investigate fleet agent work — check brain/ears/mouth logs, query Firestore work envelopes, diagnose stuck missions. Use when debugging agent behavior, verifying mission processing, or checking why an agent isn't responding."
---
# Fleet Work Investigation

## Critical: PowerShell + SSH Escaping

PowerShell intercepts `curl` as `Invoke-WebRequest` and mangles quotes in `--command` strings. For anything beyond simple commands, use the **SCP script pattern**:

1. Write a bash script locally
2. `gcloud compute scp` it to the VM
3. Run it via SSH

```powershell
# Step 1: Write script (use write_to_file tool to a scratch path)
# Step 2: SCP to VM
echo y | gcloud compute scp "C:\path\to\script.sh" fleet-{AGENT}:/tmp/script.sh --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap

# Step 3: Run (strip Windows CRLF first)
echo y | gcloud compute ssh fleet-{AGENT} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sed -i 's/\r$//' /tmp/script.sh && bash /tmp/script.sh"
```

> **NEVER** try to inline `curl` commands in `--command=` from PowerShell. It will fail.

## Log Checks (safe to inline)

### Brain daemon (decision-making, mission processing)
```powershell
echo y | gcloud compute ssh fleet-{AGENT} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 40"
```

### Ears (input polling, message receipt)
```powershell
echo y | gcloud compute ssh fleet-{AGENT} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -40 /var/log/agent-ears.log"
```

### Mouth (output delivery to GChat)
```powershell
echo y | gcloud compute ssh fleet-{AGENT} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo tail -40 /var/log/agent-mouth.log"
```

### Time-bounded logs
```powershell
echo y | gcloud compute ssh fleet-{AGENT} --zone=us-central1-a --project=architect-prime-beta --tunnel-through-iap --command="sudo journalctl -u agent-brain --no-pager -n 20 --since '2 minutes ago'"
```

## Firestore Data Model

### Collection Paths
All work data is under `primes/{PRIME_ID}/` (NOT `fleet/{AGENT}/`):
```
primes/chucknorris/work/{envelope_id}        — M/C/T envelopes
primes/chucknorris/intake/{intake_id}         — inbound messages
primes/chucknorris/work_archive/{id}          — archived envelopes
primes/chucknorris/projects/{project_id}      — project registry
primes/chucknorris/processes/{process_id}     — process definitions
primes/chucknorris/approvals/{approval_id}    — approval gates
primes/chucknorris/fleet/{agent_id}           — fleet agent status
```

### Envelope Types (M→C→T hierarchy)
- **M (Mission)**: Top-level goal. Has `instruction`, `title`, `accept_criteria`, `project_id`
- **C (Checkpoint)**: Phase/milestone within a mission. Has `parent_id` pointing to M
- **T (Task)**: Atomic unit of work. Has `parent_id` pointing to C

### Envelope Statuses
- `pending` — created, not yet processing
- `active` — brain is currently processing
- `complete` — finished successfully
- `failed` — processing failed
- `cancelled` — explicitly cancelled
- `needs_input` — waiting for human response
- `waiting` — waiting for delegated child work
- `archived` — moved to cold storage

### Key Fields
- `owner` — full email like `devops-agent-stan@tachin.ag` (NOT just agent ID)
- `delivery_status` — `internal` (not ready for delivery) or `pending`/`delivered`
- `iteration` — cortex decide loop count
- `source_channel` — `gchat`, `dashboard`, etc.
- `children` — array of child envelope IDs

## Firestore Query Scripts

### Check a specific envelope (SCP pattern)
```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

curl -s -H "Authorization: Bearer $TOKEN" \
  'https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/work/{ENVELOPE_ID}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d:
    print('NOT FOUND:', d['error'].get('message',''))
else:
    f = d.get('fields', {})
    for k in sorted(f.keys()):
        v = list(f[k].values())[0]
        if isinstance(v, str) and len(v) > 120:
            v = v[:120] + '...'
        print(f'{k}: {v}')
"
```

### List all active work envelopes
```bash
#!/bin/bash
TOKEN=$(curl -sH 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# Paginate — work collection can have 1000+ docs (old ack-* docs sort before w-*)
NEXT=""
while true; do
  URL="https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/work?pageSize=300"
  [ -n "$NEXT" ] && URL="${URL}&pageToken=${NEXT}"
  RESP=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL")
  echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for doc in d.get('documents', []):
    f = doc.get('fields', {})
    name = doc['name'].split('/')[-1]
    t = list(f.get('type',{}).values())[0] if 'type' in f else '?'
    s = list(f.get('status',{}).values())[0] if 'status' in f else '?'
    if s in ('active', 'pending', 'needs_input', 'waiting'):
        title = list(f.get('title',{}).values())[0] if 'title' in f else ''
        owner = list(f.get('owner',{}).values())[0] if 'owner' in f else '?'
        print(f'  {name}: type={t} status={s} owner={owner} title={title[:60]}')
"
  NEXT=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('nextPageToken',''))" 2>/dev/null)
  [ -z "$NEXT" ] && break
done
```

## Common Diagnoses

### Agent not responding to GChat
1. Check ears logs — is polling running? Did it receive the message?
2. Check brain logs — did intake get processed? What classification?
3. Check mouth logs — was a delivery attempted?

### Mission stuck (active/pending but no progress)
1. Check brain logs for the envelope ID — look for errors in decide loop
2. Query the envelope in Firestore — check `status`, `iteration`, `error`
3. Common causes:
   - Brain restart mid-processing → envelope orphaned (startup recovery handles this now)
   - `follow_process` parameter mismatch → falls back to decide loop
   - Cortex returning invalid schema → enforceSchema retry exhaustion

### Mouth not delivering
1. Check mouth logs for `synthesize` or `delivery` messages
2. Verify envelope `delivery_status` — must be `pending` (not `internal`)
3. Only M-type envelopes get delivered; C and T are always `internal`

### Title showing as fallback/truncated
1. `summarizeViaVertex` uses Gemini 2.5 Flash which has thinking enabled by default
2. Response `parts[0]` is the thought, `parts[1+]` is the answer
3. Title generation uses `disableThinking: true` to avoid this
4. Check brain DEBUG logs for `summarizeViaVertex result: N chars`
