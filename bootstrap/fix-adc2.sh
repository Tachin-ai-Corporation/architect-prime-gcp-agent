#!/usr/bin/env bash
# Fix: Generate ADC JSON from metadata server and point GOOGLE_APPLICATION_CREDENTIALS to it
set -uo pipefail

echo "=== 1. Generate ADC JSON inside container ==="
# On GCE, we can create an application_default_credentials.json that
# points to the compute metadata service account
docker exec -u 0 openclaw-gateway bash -c '
mkdir -p /home/node/.config/gcloud
cat > /home/node/.config/gcloud/application_default_credentials.json << ADCEOF
{
  "type": "authorized_user",
  "credential_source": {
    "url": "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    "headers": {
      "Metadata-Flavor": "Google"
    },
    "format": {
      "type": "json",
      "subject_token_field_name": "access_token"
    }
  }
}
ADCEOF
chown -R node:node /home/node/.config
chmod 600 /home/node/.config/gcloud/application_default_credentials.json
echo "Created ADC file"
'

echo "=== 2. Stop container, add GOOGLE_APPLICATION_CREDENTIALS env, start ==="
docker stop openclaw-gateway
# Read existing env-file
cd /root/openclaw
# Add GOOGLE_APPLICATION_CREDENTIALS if not present
if ! grep -q GOOGLE_APPLICATION_CREDENTIALS .env; then
  echo "GOOGLE_APPLICATION_CREDENTIALS=/home/node/.config/gcloud/application_default_credentials.json" >> .env
fi
cat .env
echo "---"

# Re-create container with updated env
docker rm -f openclaw-gateway
DOCKER_GID="$(getent group docker | cut -d: -f3)"
docker run -d \
  --name openclaw-gateway \
  --network host \
  --restart always \
  --env-file .env \
  -v "/opt/openclaw/.openclaw:/home/node/.openclaw" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "${DOCKER_GID}" \
  openclaw:local

echo "Container recreated. Waiting 40s..."
sleep 40

# Re-create ADC file (new container)
docker exec -u 0 openclaw-gateway bash -c '
mkdir -p /home/node/.config/gcloud
cat > /home/node/.config/gcloud/application_default_credentials.json << ADCEOF
{
  "type": "authorized_user",
  "credential_source": {
    "url": "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    "headers": {
      "Metadata-Flavor": "Google"
    },
    "format": {
      "type": "json",
      "subject_token_field_name": "access_token"
    }
  }
}
ADCEOF
chown -R node:node /home/node/.config
chmod 600 /home/node/.config/gcloud/application_default_credentials.json
'

echo "=== 3. Gateway logs ==="
docker logs openclaw-gateway --tail 10 2>&1

echo "=== 4. Test ==="
TOKEN=$(cat /root/.openclaw/.gateway-token 2>/dev/null || echo 'no-token')
RESULT=$(curl -s --max-time 60 \
  -X POST "http://localhost:18789/v1/chat/completions" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"say pong"}]}' 2>&1) || RESULT="CURL_FAILED"
echo "$RESULT" | head -20

echo ""
echo "=== DONE ==="
