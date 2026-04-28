#!/bin/bash
TOKEN=$(cat /home/node/.openclaw/openclaw.json | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "=== Testing gateway HTTP API (same path as control-daemon) ==="
echo "Token: ${TOKEN:0:8}..."
START=$(date +%s%N)
RESP=$(curl -s -m 60 -w '\nHTTP_CODE: %{http_code}' -X POST \
  http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openclaw/cortex","messages":[{"role":"user","content":"say hi"}],"stream":false}')
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "Gateway HTTP: ${ELAPSED}ms"
echo "$RESP" | tail -10
echo ""
echo "=== Testing embedded CLI (bypasses gateway HTTP) ==="
START=$(date +%s%N)
RESP=$(timeout 60 openclaw agent --agent cortex -m 'say hi' --json --timeout 45 2>&1)
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "Embedded CLI: ${ELAPSED}ms"
echo "$RESP" | grep -E 'result|winnerModel|finalAssistantVisible|error' | head -5
