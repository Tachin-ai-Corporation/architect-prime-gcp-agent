#!/bin/bash
set -euo pipefail
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
PROJECT="architect-prime-beta"
BODY='{"contents":[{"role":"user","parts":[{"text":"say pong"}]}],"generationConfig":{"maxOutputTokens":5}}'

echo "=== Gemini 3 Pro Preview endpoint tests ==="

# Test each endpoint one at a time
test_url() {
  local label="$1" url="$2"
  local code
  code=$(curl -s -o /tmp/g3r.json -w '%{http_code}' --max-time 15 \
    -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "$url" -d "$BODY" 2>/dev/null) || code="000"
  if [ "$code" = "200" ] || [ "$code" = "429" ]; then
    echo "  ✅ $code  $label"
  else
    local err=$(python3 -c "import json; print(json.load(open('/tmp/g3r.json')).get('error',{}).get('message','')[:120])" 2>/dev/null || echo "?")
    echo "  ❌ $code  $label  -- $err"
  fi
}

# Generative Language API (Google AI style)
test_url "generativelanguage v1beta" \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent"

# Vertex AI with different regions
for region in us-central1 us-east1 us-west1 europe-west1; do
  test_url "vertex $region v1beta1" \
    "https://${region}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${region}/publishers/google/models/gemini-3-pro-preview:generateContent"
done

# Vertex AI global
test_url "vertex global v1beta1" \
  "https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3-pro-preview:generateContent"

# Vertex AI us location  
test_url "vertex us v1beta1" \
  "https://us-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/us/publishers/google/models/gemini-3-pro-preview:generateContent"

# Try the Gemini API style (with API key style but using Bearer)
test_url "generativelanguage v1beta (project)" \
  "https://generativelanguage.googleapis.com/v1beta/projects/${PROJECT}/locations/global/publishers/google/models/gemini-3-pro-preview:generateContent"

echo ""
echo "=== Also try gemini-2.5-pro on global (as control) ==="
test_url "gemini-2.5-pro global" \
  "https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-2.5-pro:generateContent"
