#!/usr/bin/env bash
# Test OpenClaw API endpoints to find the correct message endpoint
set -uo pipefail

TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo "no-token")
echo "Token: ${TOKEN:0:8}..."

echo ""
echo "=== Testing POST endpoints ==="
for EP in \
  "/api/sessions/main/messages" \
  "/v1/responses" \
  "/v1/chat/completions" \
  "/api/v1/sessions/main/messages" \
  "/api/v1/chat/completions" \
  "/__openclaw__/api/sessions/main/messages" \
  "/__openclaw__/v1/responses" \
; do
  BODY=$(curl -s --max-time 10 \
    -X POST "http://localhost:18789${EP}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"content": "test ping"}' 2>&1) || BODY="CURL_FAILED"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST "http://localhost:18789${EP}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"content": "test"}' 2>/dev/null || echo "000")
  echo "POST ${EP} → HTTP ${CODE} | ${BODY:0:200}"
  echo ""
done

echo ""
echo "=== Testing with docker exec (native RPC) ==="
echo "Sending message via gateway CLI..."
RESULT=$(docker exec openclaw-gateway node /app/openclaw.mjs gateway call agent.sendMessage --json --params '{"agentId":"main","message":"hello"}' 2>&1) || RESULT="CLI_FAILED"
echo "agent.sendMessage result: ${RESULT:0:500}"

echo ""
echo "=== Available RPC methods ==="
docker exec openclaw-gateway node /app/openclaw.mjs gateway call --help 2>&1 | head -30

echo ""
echo "=== DONE ==="
