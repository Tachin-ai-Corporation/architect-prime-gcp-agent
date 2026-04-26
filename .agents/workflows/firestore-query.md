---
description: Query and debug Firestore data for Prime agents — messages, tasks, dispatch telemetry, fleet status. Use when verifying daemon behavior, telemetry writes, or task lifecycle.
---

# Firestore Query

## Get access token

// turbo
```powershell
$token = (gcloud auth print-access-token 2>$null)
```

## Dispatch telemetry

```powershell
$body = '{"structuredQuery":{"from":[{"collectionId":"dispatch-log"}],"orderBy":[{"field":{"fieldPath":"startedAt"},"direction":"DESCENDING"}],"limit":10}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

## Task documents

```powershell
$body = '{"structuredQuery":{"from":[{"collectionId":"tasks"}],"orderBy":[{"field":{"fieldPath":"receivedAt"},"direction":"DESCENDING"}],"limit":5}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"
$resp = Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$resp | ConvertTo-Json -Depth 10
```

## Recent messages

```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/messages?pageSize=5&orderBy=createdAt%20desc"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).documents | ForEach-Object { $_.fields | ConvertTo-Json -Depth 3 }
```

## Prime status

```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).fields | ConvertTo-Json -Depth 3
```

## Fleet agent status

```powershell
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/fleet/{agent-name}"
(Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token"}).fields | ConvertTo-Json -Depth 3
```

## Send a test message

```powershell
$ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$body = '{"fields":{"text":{"stringValue":"your message here"},"sender":{"stringValue":"admin"},"processed":{"booleanValue":false},"createdAt":{"timestampValue":"' + $ts + '"}}}'
$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris/messages"
Invoke-RestMethod -Uri $uri -Headers @{"Authorization"="Bearer $token";"Content-Type"="application/json"} -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

## Notes
- **403:** Token expired. Re-run `gcloud auth print-access-token`.
- **400 Bad Request:** Firestore paths need even segment counts (collection/document pairs).
- **Replace `chucknorris`** with the target Prime ID as needed.
