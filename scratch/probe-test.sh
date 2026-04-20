#!/usr/bin/env bash
set -euo pipefail
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

probe() {
  local url="$1"
  local label="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    "$url" \
    -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":5}}' \
    2>/dev/null) || code="000"
  echo "$label: $code"
}

echo "=== Testing gemini-3.1-pro-preview ==="
probe "https://us-central1-aiplatform.googleapis.com/v1/projects/architect-prime-beta/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent" "v1 us-central1"
probe "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/architect-prime-beta/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent" "v1beta1 us-central1"

echo ""
echo "=== Testing Claude 3.7 Sonnet ==="
probe "https://us-central1-aiplatform.googleapis.com/v1/projects/architect-prime-beta/locations/us-central1/publishers/anthropic/models/claude-3-7-sonnet:generateContent" "claude-3.7 v1"

echo ""
echo "=== gcloud model-garden list ==="
gcloud ai model-garden models list --project=architect-prime-beta --format="table(name,displayName)" 2>&1 | head -20 || echo "(model-garden list failed)"
