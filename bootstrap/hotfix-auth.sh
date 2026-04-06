#!/usr/bin/env bash
# Hot-fix the running VM: restore auth-profiles.json and restart gateway
set -uo pipefail

echo "=== 1. Restoring auth-profiles.json ==="
cat > /tmp/auth-profiles.json <<'AUTH'
{
  "version": 1,
  "profiles": {
    "google-vertex:default": {
      "type": "api_key",
      "provider": "google-vertex",
      "key": "adc"
    }
  }
}
AUTH

# Copy into the container's agent dir
docker cp /tmp/auth-profiles.json openclaw-gateway:/home/node/.openclaw/agents/main/agent/auth-profiles.json
docker exec -u 0 openclaw-gateway chown node:node /home/node/.openclaw/agents/main/agent/auth-profiles.json
docker exec -u 0 openclaw-gateway chmod 600 /home/node/.openclaw/agents/main/agent/auth-profiles.json
echo "auth-profiles.json restored."

echo ""
echo "=== 2. Restarting gateway container ==="
docker restart openclaw-gateway
echo "Container restarting..."

echo ""
echo "=== 3. Waiting 30s for gateway up ==="
sleep 30

echo ""
echo "=== 4. Gateway logs (last 10 lines) ==="
docker logs openclaw-gateway --tail 10 2>&1

echo ""
echo "=== 5. Checking auth-profiles.json inside container ==="
docker exec openclaw-gateway cat /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>&1

echo ""
echo "=== 6. Quick test — send a message via /v1/chat/completions ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 30 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"ping - respond with just the word pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -20

echo ""
echo "=== DONE ==="
