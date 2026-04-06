#!/usr/bin/env bash
# Fix: remove google-vertex from auth-profiles.json to let ADC work naturally
set -uo pipefail

echo "=== 1. Removing google-vertex from auth-profiles.json ==="
# Write empty profiles so OpenClaw doesn't try to use an API key
docker exec -u 0 openclaw-gateway bash -c 'cat > /home/node/.openclaw/agents/main/agent/auth-profiles.json << EOF
{
  "version": 1,
  "profiles": {}
}
EOF
chown node:node /home/node/.openclaw/agents/main/agent/auth-profiles.json
chmod 600 /home/node/.openclaw/agents/main/agent/auth-profiles.json'

echo "=== 2. Also try gcloud ADC inside the container ==="
# Create ADC credentials from metadata server
docker exec -u 0 openclaw-gateway bash -c '
TOKEN=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)
echo "Metadata token response: ${TOKEN:0:50}..."
'

echo "=== 3. Restarting gateway ==="
docker restart openclaw-gateway
echo "Waiting 30s..."
sleep 30

echo "=== 4. New logs ==="
docker logs openclaw-gateway --tail 5 2>&1

echo "=== 5. Test chat completions ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 60 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -30

echo ""
echo "=== DONE ==="
