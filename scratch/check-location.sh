#!/bin/bash
# Check how @google/genai resolves location
echo "=== @google/genai location resolution ==="
grep -n "location" /app/dist/extensions/google/node_modules/@google/genai/dist/node/index.cjs 2>/dev/null | grep -i "GOOGLE_CLOUD\|resolve\|process.env\|global" | head -15

echo ""
echo "=== How the Google provider constructs the URL ==="
# The key: how does it build the API URL?
grep -n "aiplatform\|generateContent" /app/dist/extensions/google/node_modules/@google/genai/dist/node/index.cjs 2>/dev/null | head -10

echo ""
echo "=== Bootstrap template model config ==="
cat /home/node/.openclaw/agents/main/agent/openclaw-bootstrap.json5 2>/dev/null | head -30
echo ""
echo "--- model section ---"
grep -A5 -B1 "primary\|model" /home/node/.openclaw/agents/main/agent/openclaw-bootstrap.json5 2>/dev/null | head -20

echo ""
echo "=== Docker run command (env vars) ==="
sudo docker inspect openclaw-gateway --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -i "GOOGLE\|LOCATION\|PROJECT"
