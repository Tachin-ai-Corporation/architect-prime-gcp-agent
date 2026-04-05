#!/usr/bin/env bash
# Quick diagnostic script for the VM
set -euo pipefail

echo "=== 1. Services ==="
systemctl is-active control-daemon || echo "control-daemon: INACTIVE"
docker ps --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || echo "Docker: NOT RUNNING"

echo ""
echo "=== 2. Gateway Token ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo "MISSING")
echo "Token: ${TOKEN:0:8}..."

echo ""
echo "=== 3. OpenClaw Health Check ==="
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18789/ 2>/dev/null || echo "FAIL")
echo "GET / → HTTP ${HTTP_CODE}"

echo ""
echo "=== 4. Test /api/message ==="
RESP=$(curl -s --max-time 60 \
  -X POST "http://localhost:18789/api/message" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message": "ping", "channel": "api"}' 2>&1) || RESP="CURL_FAILED"
echo "Response: ${RESP:0:500}"

echo ""
echo "=== 5. Test alternative endpoints ==="
for EP in "/api/v1/message" "/v1/message" "/message" "/api/chat"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST "http://localhost:18789${EP}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"message": "test"}' 2>/dev/null || echo "FAIL")
  echo "POST ${EP} → HTTP ${CODE}"
done

echo ""
echo "=== 6. Control-daemon logs (last 10 lines) ==="
journalctl -u control-daemon -n 10 --no-pager --output=short-iso 2>/dev/null || echo "No logs"

echo ""
echo "=== 7. OpenClaw gateway recent logs ==="
docker logs openclaw-gateway --tail 15 2>&1 | tail -15

echo ""
echo "=== DONE ==="
