#!/bin/bash
# Investigate why Gemini 3 models return 404
set -euo pipefail

TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

PROJECT="architect-prime-beta"
REGION="us-central1"
BODY='{"contents":[{"role":"user","parts":[{"text":"say pong"}]}],"generationConfig":{"maxOutputTokens":5}}'

# Model IDs to test (from Model Garden listing + potential variants)
MODELS=(
  "gemini-3-pro-preview"
  "gemini-3.0-pro-preview"  
  "gemini-3-pro"
  "gemini-3-flash-preview"
  "gemini-3.0-flash-preview"
  "gemini-3-flash"
  "gemini-3.1-pro-preview"
  "gemini-3.1-flash-lite-preview"
)

# API versions to test
VERSIONS=("v1beta1" "v1")

echo "=== Probing Gemini 3 model variants ==="
echo ""

for model in "${MODELS[@]}"; do
  echo "--- $model ---"
  for ver in "${VERSIONS[@]}"; do
    url="https://${REGION}-aiplatform.googleapis.com/${ver}/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${model}:generateContent"
    code=$(curl -s -o /tmp/probe-response.json -w '%{http_code}' --max-time 15 \
      -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      "$url" -d "$BODY" 2>/dev/null) || code="000"
    
    # Show response body for non-200 codes
    if [ "$code" != "200" ] && [ "$code" != "429" ]; then
      error_msg=$(python3 -c "
import json
try:
    d = json.load(open('/tmp/probe-response.json'))
    msg = d.get('error',{}).get('message','')[:120]
    print(f'  {msg}')
except:
    print('  (no error body)')
" 2>/dev/null)
      echo "  ${ver}: HTTP ${code} ${error_msg}"
    else
      echo "  ${ver}: HTTP ${code} ✅ AVAILABLE"
    fi
  done
done

echo ""
echo "=== Check what gcloud returns for gemini-3 model garden entries ==="
gcloud ai model-garden models list --format=json --project=$PROJECT 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data:
    name = m.get('name','')
    if 'gemini-3' in name or 'gemini-3.' in name:
        print(f'  {name}')
        print(f'    launchStage: {m.get(\"launchStage\",\"?\")}')
        print(f'    versionId: {m.get(\"versionId\",\"?\")}')
        tmpl = m.get('publisherModelTemplate','')
        print(f'    template: {tmpl}')
        actions = list(m.get('supportedActions',{}).keys())
        print(f'    actions: {actions}')
        print()
"
