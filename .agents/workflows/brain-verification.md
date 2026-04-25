---
description: Test the brain dispatch system end-to-end — send a message, verify PLAN.md compliance, check dispatch telemetry, and confirm the response. Use after any brain architecture changes.
---

# Brain Verification — End-to-End Test

## When to use
- After modifying SOUL.md, TOOLS.md, or BRAIN_CARD.md
- After changing brain-exec, control-daemon, or the gateway config
- After upgrading OpenClaw or deploying a new CoreKit version

## Step 1: Deploy changes

Follow `/deploy-corekit` — push to main, then upgrade via dashboard.

## Step 2: Verify gateway is healthy

Use the dashboard to check the Prime status badge shows **Online**. If you need deeper inspection:

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo docker exec openclaw-gateway openclaw status"
```

## Step 3: Send test messages via dashboard

Send each of these messages through the **dashboard chat** and verify the response:

| # | Message | Expected Category | Expected Behavior |
|---|---------|------------------|-------------------|
| 1 | "What's your name?" | `identity` | Direct answer, no dispatch |
| 2 | "What is the latest OpenClaw version?" | `research` | Dispatches temporal-research, real web data in response |
| 3 | "Research OpenClaw and plan our next upgrade" | `research-plan` | Dispatches temporal-research → prefrontal |
| 4 | "Fleet status" | `fleet-command` | Runs fleet-status directly |
| 5 | "Hire a new devops agent named bob" | `fleet-command` | Runs fleet-hire directly |

## Step 4: Verify telemetry (SSH debugging)

After the dispatch-triggering messages (#2, #3), SSH in to check:

```bash
# Check dispatch telemetry was written to Firestore
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo docker exec openclaw-gateway /home/node/.openclaw/bin/brain-telemetry-read --last 5"
```

Or query Firestore directly with `/firestore-query`:

```powershell
$token = (gcloud auth print-access-token 2>$null)
$body = '{"structuredQuery":{"from":[{"collectionId":"dispatch-log"}],"orderBy":[{"field":{"fieldPath":"startedAt"},"direction":"DESCENDING"}],"limit":5}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

## Step 5: Check PLAN.md compliance (SSH debugging)

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo docker exec openclaw-gateway cat /home/node/.openclaw/workspace/PLAN.md 2>/dev/null || echo 'No PLAN.md found'"
```

For dispatch messages (#2, #3), PLAN.md should exist and contain the classification + dispatch sequence.

## Step 6: Verify Task lifecycle (Firestore)

```powershell
$token = (gcloud auth print-access-token 2>$null)
$body = '{"structuredQuery":{"from":[{"collectionId":"tasks"}],"orderBy":[{"field":{"fieldPath":"receivedAt"},"direction":"DESCENDING"}],"limit":3}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

Each message should have a Task document with `status: complete` and timing data.

## Step 7: Check SSE ack forwarding

For dispatch messages (#2, #3), look at the dashboard chat — you should see a `🔄` acknowledgment message appear within a few seconds, followed by the full response.

If you need to verify from logs:

```bash
gcloud compute ssh prime-chucknorris --zone=us-central1-f --project=architect-prime-beta --tunnel-through-iap -- -o ConnectTimeout=15 "sudo journalctl -u control-daemon --since '5 min ago' --no-pager -o cat | grep -E 'Ack forwarded|Completed'"
```
