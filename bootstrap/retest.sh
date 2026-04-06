#!/usr/bin/env bash
# Quick test - gateway should already be running
set -uo pipefail

echo "=== Container status ==="
docker ps --format '{{.Names}} {{.Status}}'

echo ""
echo "=== Gateway logs (last 15 lines) ==="
docker logs openclaw-gateway --tail 15 2>&1

echo ""
echo "=== Sending test message ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 120 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -30

echo ""
echo "=== DONE ==="
