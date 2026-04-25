$token = gcloud auth print-access-token 2>$null

# Query specifically for upgrade_corekit commands
$body = @'
{
  "structuredQuery": {
    "from": [{"collectionId": "commands"}],
    "where": {
      "fieldFilter": {
        "field": {"fieldPath": "type"},
        "op": "EQUAL",
        "value": {"stringValue": "upgrade_corekit"}
      }
    },
    "limit": 10
  }
}
'@

$uri = "https://firestore.googleapis.com/v1/projects/architect-prime-beta/databases/(default)/documents/primes/chucknorris:runQuery"

$result = Invoke-WebRequest -Uri $uri -Method POST -Headers @{
    "Authorization" = "Bearer $token"
    "Content-Type"  = "application/json"
} -Body $body -UseBasicParsing

$parsed = $result.Content | ConvertFrom-Json
$count = 0

foreach ($item in $parsed) {
    $doc = $item.document
    if (-not $doc) { continue }
    $count++
    $f = $doc.fields
    $status = $f.status.stringValue
    $created = if ($f.createdAt.timestampValue) { $f.createdAt.timestampValue } else { $f.createdAt.stringValue }
    
    Write-Host "[$count] upgrade_corekit | status=$status | created=$created"
    
    if ($f.args.mapValue.fields) {
        foreach ($key in $f.args.mapValue.fields.PSObject.Properties.Name) {
            Write-Host "     arg.$key = $($f.args.mapValue.fields.$key.stringValue)"
        }
    }
    if ($f.error -and $f.error.stringValue) {
        $e = $f.error.stringValue; if ($e.Length -gt 500) { $e = $e.Substring(0,500) + "..." }
        Write-Host "     ERROR: $e"
    }
    if ($f.result -and $f.result.stringValue) {
        $r = $f.result.stringValue; if ($r.Length -gt 500) { $r = $r.Substring(0,500) + "..." }
        Write-Host "     RESULT: $r"
    }
    Write-Host ""
}

if ($count -eq 0) { Write-Host "No upgrade_corekit commands found." }
