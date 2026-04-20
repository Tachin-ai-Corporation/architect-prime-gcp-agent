#!/bin/bash
set -euo pipefail

DOCKER_GID="$(getent group docker | cut -d: -f3)"
docker rm -f openclaw-gateway 2>/dev/null || true

docker run -d \
  --name openclaw-gateway \
  --network host \
  --restart always \
  -e "GATEWAY_BIND=loopback" \
  -e "GATEWAY_PORT=18789" \
  -e "OPENCLAW_GATEWAY_TOKEN=9568dbe5673ceaf031a5a1d7343faab4" \
  -e "OPENCLAW_CONFIG_DIR=/home/node/.openclaw" \
  -e "OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace" \
  -e "OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json" \
  -e "GOOGLE_CLOUD_PROJECT=architect-prime-beta" \
  -e "GCLOUD_PROJECT=architect-prime-beta" \
  -e "CLOUDSDK_CORE_PROJECT=architect-prime-beta" \
  -e "GOOGLE_GENAI_USE_VERTEXAI=True" \
  -e "GOOGLE_CLOUD_LOCATION=global" \
  -v "/opt/openclaw/.openclaw:/home/node/.openclaw" \
  -v "/var/run/docker.sock:/var/run/docker.sock" \
  --group-add "${DOCKER_GID}" \
  openclaw:local

echo "Waiting for gateway..."
sleep 5
docker ps
echo ""
echo "=== Verify env ==="
docker exec openclaw-gateway printenv GOOGLE_CLOUD_LOCATION
