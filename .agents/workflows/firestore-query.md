---
description: Query and debug Firestore data for Prime agents — messages, tasks, dispatch telemetry, fleet status. Use when verifying daemon behavior, telemetry writes, or task lifecycle.
---

# Firestore Query — Debug Agent State

## Prerequisites
- `gcloud` CLI authenticated
- Access to `architect-prime-beta` project

## Get an access token

// turbo
```powershell
$token = (gcloud auth print-access-token 2>$null)
```

## Common queries

### List recent messages for a Prime
```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/messages?pageSize=5&orderBy=createdAt%20desc"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).documents | ForEach-Object { $_.fields | ConvertTo-Json -Depth 3 }
```

### Read dispatch telemetry
```powershell
$body = '{"structuredQuery":{"from":[{"collectionId":"dispatch-log"}],"orderBy":[{"field":{"fieldPath":"startedAt"},"direction":"DESCENDING"}],"limit":10}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

### Read Task documents
```powershell
$body = '{"structuredQuery":{"from":[{"collectionId":"tasks"}],"orderBy":[{"field":{"fieldPath":"receivedAt"},"direction":"DESCENDING"}],"limit":10}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

### Write a test message (trigger control-daemon)
```powershell
$body = '{"fields":{"text":{"stringValue":"Hello, test message"},"sender":{"stringValue":"admin"},"processed":{"booleanValue":false},"createdAt":{"timestampValue":"' + (Get-Date -Format o) + '"}}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/messages"
Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

### Check Prime status
```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).fields | ConvertTo-Json -Depth 3
```

### Check fleet agent status
```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/fleet/stan"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).fields | ConvertTo-Json -Depth 3
```

## Troubleshooting
- **403 Forbidden:** `gcloud auth print-access-token` may have expired. Re-run it.
- **404 Not Found:** Check the document path — collection/document segments must alternate.
- **400 Bad Request:** Firestore REST requires even segment counts in document paths. See `brain-telemetry-write` path fix for context.
