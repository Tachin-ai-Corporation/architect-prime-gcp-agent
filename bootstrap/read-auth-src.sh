#!/usr/bin/env bash
# Inspect OpenClaw's google-vertex auth handling in source
set -uo pipefail

echo "=== model-auth-env (env-based auth for google-vertex) ==="
docker exec openclaw-gateway cat /app/dist/model-auth-env-CMBuDNQq.js 2>/dev/null

echo ""
echo "===   ==="
echo "=== model-auth-D3JUg9SJ.js (where 'No API key found' error is thrown) ==="
docker exec openclaw-gateway head -50 /app/dist/model-auth-D3JUg9SJ.js 2>/dev/null

echo ""
echo "=== api-key-rotation (google-vertex section) ==="
docker exec openclaw-gateway sed -n '1,70p' /app/dist/api-key-rotation-DoUJ-Vbd.js 2>/dev/null

echo ""
echo "=== DONE ==="
