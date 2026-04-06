#!/usr/bin/env bash
# FINAL FIX: Create proper GCE ADC credential file inside the container
# On GCE, the Google Auth library supports a credentials file that
# points to the metadata server for token exchange.
set -uo pipefail

echo "=== 1. Creating GCE ADC credentials file ==="
docker exec -u 0 openclaw-gateway bash -c '
mkdir -p /home/node/.config/gcloud

# This is the standard GCE metadata-based credential format that
# google-auth-library-nodejs recognizes. It tells the library to
# fetch tokens from the metadata server automatically.
cat > /home/node/.config/gcloud/application_default_credentials.json << ADCJSON
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/default-pool/providers/default-provider",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "credential_source": {
    "url": "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    "headers": {
      "Metadata-Flavor": "Google"
    },
    "format": {
      "type": "json",
      "subject_token_field_name": "access_token"
    }
  },
  "service_account_impersonation_url": null
}
ADCJSON

chown -R node:node /home/node/.config
chmod 600 /home/node/.config/gcloud/application_default_credentials.json
echo "ADC file created"
cat /home/node/.config/gcloud/application_default_credentials.json
'

echo ""
echo "=== 2. Also make auth-profiles.json have the adc magic key ==="
docker exec -u 0 openclaw-gateway bash -c '
cat > /home/node/.openclaw/agents/main/agent/auth-profiles.json << AUTHEOF
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
AUTHEOF
chown node:node /home/node/.openclaw/agents/main/agent/auth-profiles.json
chmod 600 /home/node/.openclaw/agents/main/agent/auth-profiles.json
echo "auth-profiles.json restored"
'

echo ""
echo "=== 3. Restart gateway ==="
docker restart openclaw-gateway
echo "Waiting 40s..."
sleep 40

echo ""
echo "=== 4. Gateway logs ==="
docker logs openclaw-gateway --tail 10 2>&1

echo ""
echo "=== 5. Test message ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 60 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"respond with just the word pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -30

echo ""
echo "=== DONE ==="
