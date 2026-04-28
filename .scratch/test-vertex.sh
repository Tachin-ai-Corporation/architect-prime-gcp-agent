#!/bin/bash
TOKEN="9568dbe5673ceaf031a5a1d7343faab4"
echo "=== Non-streaming (stream:false) ==="
START=$(date +%s%N)
RESP=$(timeout 60 curl -s -X POST \
  http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openclaw/cortex","messages":[{"role":"user","content":"who are you?"}],"stream":false}')
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "Time: ${ELAPSED}ms"
echo "$RESP" | python3 -m json.tool 2>/dev/null | head -30
echo ""
echo "=== Content extraction ==="
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','NO CONTENT'))" 2>/dev/null
