#!/usr/bin/env bash
# Search OpenClaw source for auth profile handling
set -uo pipefail

echo "=== Finding auth-related source files ==="
docker exec openclaw-gateway find /app -name "*.ts" -o -name "*.js" -o -name "*.mjs" 2>/dev/null | xargs grep -l "api_key\|auth-profiles\|No API key\|authProfile\|google-vertex" 2>/dev/null | head -20

echo ""
echo "=== Searching for 'adc' handling ==="
docker exec openclaw-gateway grep -rn '"adc"\|adc.*key\|key.*adc' /app/dist/ 2>/dev/null | head -10

echo ""
echo "=== Searching for profile types in dist ==="
docker exec openclaw-gateway grep -rn 'api_key\|oauth_token\|bearer\|service_account' /app/dist/ 2>/dev/null | grep -i 'type\|profile' | head -20

echo ""
echo "=== Finding google-vertex provider ==="
docker exec openclaw-gateway find /app -path "*google*vertex*" -o -path "*vertex*" 2>/dev/null | head -20

echo ""
echo "=== DONE ==="
