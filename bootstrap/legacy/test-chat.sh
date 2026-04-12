#!/usr/bin/env bash
# Test script: wait for gateway + send chat completions test
set -uo pipefail

echo "=== Waiting 30s for gateway ==="
sleep 30

echo "=== Checking gateway health ==="
docker ps --format '{{.Names}} {{.Status}}'

echo ""
echo "=== Checking new gateway logs (post-restart) ==="
docker logs openclaw-gateway --tail 10 2>&1

echo ""
echo "=== Sending test message ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 60 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -30

echo ""
echo "=== DONE ==="
