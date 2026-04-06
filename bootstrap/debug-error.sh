#!/usr/bin/env bash
# Check the detailed gateway logs after test message
set -uo pipefail

echo "=== Send test message ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 120 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"say pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "API Response: $RESULT"

echo ""
echo "=== Gateway logs (last 25 lines AFTER test) ==="
sleep 2
docker logs openclaw-gateway --tail 25 2>&1

echo ""
echo "=== Full OpenClaw log file (last 100 lines) ==="
docker exec openclaw-gateway tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>&1

echo ""
echo "=== DONE ==="
