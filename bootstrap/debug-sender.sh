#!/usr/bin/env bash
# Dump raw message sender objects to see what Chat API returns
TOKEN=$(/opt/openclaw/.openclaw/bin/dwd-token \
  --user devops-agent-stan@tachin.ai \
  --scope "https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly" 2>/dev/null)

RAW=$(curl -sf -H "Authorization: Bearer ${TOKEN}" \
  "https://chat.googleapis.com/v1/spaces/AAQAXN-eJIQ/messages?pageSize=10&orderBy=createTime%20desc" 2>/dev/null)

echo "$RAW" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for i, msg in enumerate(data.get('messages', [])[:10]):
    sender = msg.get('sender', {})
    text = (msg.get('text', '') or msg.get('argumentText', '') or '')[:60]
    print(f'MSG {i}: text={repr(text)}')
    print(f'  sender keys: {list(sender.keys())}')
    for k, v in sender.items():
        print(f'  sender.{k} = {repr(v)}')
    print()
"
