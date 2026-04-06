#!/usr/bin/env bash
# DEFINITIVE FIX:
# 1. Empty auth-profiles.json so OpenClaw doesn't fall back to literal "adc" key
# 2. Let getEnvApiKey() auto-discover GCE metadata server for ADC
# 3. Remove any stale ADC files that might interfere
set -uo pipefail

echo "=== 1. Empty auth-profiles.json ==="
docker exec -u 0 openclaw-gateway bash -c '
cat > /home/node/.openclaw/agents/main/agent/auth-profiles.json << EOF
{"version":1,"profiles":{}}
EOF
chown node:node /home/node/.openclaw/agents/main/agent/auth-profiles.json
chmod 600 /home/node/.openclaw/agents/main/agent/auth-profiles.json
echo "emptied auth-profiles.json"
'

echo ""
echo "=== 2. Remove any stale ADC files ==="
docker exec -u 0 openclaw-gateway bash -c '
rm -f /home/node/.config/gcloud/application_default_credentials.json 2>/dev/null
echo "removed stale ADC files (if any)"
'

echo ""
echo "=== 3. Verify GOOGLE_CLOUD_PROJECT is available ==="
docker exec openclaw-gateway bash -c 'echo "GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT"'

echo ""
echo "=== 4. Verify metadata server accessible from container ==="
docker exec openclaw-gateway bash -c '
TOKEN=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)
echo "Token response: ${TOKEN:0:60}..."
'

echo ""
echo "=== 5. Restart gateway ==="
docker restart openclaw-gateway
echo "Waiting 45s..."
sleep 45

echo ""
echo "=== 6. Gateway logs ==="
docker logs openclaw-gateway --tail 15 2>&1

echo ""
echo "=== 7. Test message ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 120 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -30

echo ""
echo "=== DONE ==="
