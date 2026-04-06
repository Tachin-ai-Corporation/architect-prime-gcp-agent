#!/usr/bin/env bash
# Search OpenClaw source for how it handles google-vertex auth
set -uo pipefail

echo "=== Searching for 'No API key' error message ==="
docker exec openclaw-gateway grep -rn "No API key" /app/dist/ --include="*.js" --include="*.mjs" 2>/dev/null | grep -v "theme\|horizon\|houston\|tokyo\|slack\|poimandres\|common-lisp\|material" | head -5

echo ""
echo "=== Searching for 'google-vertex' in dist ==="
docker exec openclaw-gateway grep -rn "google-vertex" /app/dist/ --include="*.js" --include="*.mjs" 2>/dev/null | grep -v "theme\|horizon\|houston\|tokyo\|slack\|poimandres\|common-lisp\|material" | head -10

echo ""
echo "=== Checking if there's a 'gcloud' or 'service_account' auth type ==="
docker exec openclaw-gateway grep -rn '"gcloud"\|"service_account"\|"oauth"\|"oauth2"\|"bearer"' /app/dist/ --include="*.js" --include="*.mjs" 2>/dev/null | grep -v "theme\|horizon\|houston\|tokyo\|slack\|poimandres\|common-lisp\|material" | head -10

echo ""
echo "=== DONE ==="
