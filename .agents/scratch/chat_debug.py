#!/usr/bin/env python3
"""Diagnose inbox-daemon message pickup on fleet-stan."""
import json, subprocess, urllib.request

email = "devops-agent-stan@tachin.ag"
scope = "https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.readonly"
token = subprocess.check_output(
    ["/opt/openclaw/.openclaw/bin/dwd-token", "--user", email, "--scope", scope],
    stderr=subprocess.DEVNULL
).decode().strip()

hw = open("/var/lib/inbox-daemon/highwater").read().strip()
print(f"Highwater: {hw}")

seen = json.load(open("/var/lib/inbox-daemon/seen.json"))
print(f"Seen entries: {len(seen)}")
for k in list(seen.keys())[-5:]:
    print(f"  last seen: {k}")

url = "https://chat.googleapis.com/v1/spaces/AAQAXN-eJIQ/messages?pageSize=10" + "&orderBy=createTime%20desc"
req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
data = json.loads(urllib.request.urlopen(req).read())
msgs = data.get("messages", [])
print(f"\nMessages from API: {len(msgs)}")
for m in reversed(msgs):
    ct = m.get("createTime", "")
    name = m.get("name", "")
    text = (m.get("text", "") or "")[:80]
    sender = m.get("sender", {})
    sender_type = sender.get("type", sender.get("domainId", ""))
    in_seen = name in seen
    after_hw = ct > hw if ct else False
    skip_reason = "SEEN" if in_seen else ("OLD" if not after_hw else "NEW")
    print(f"  {ct} | {skip_reason:4s} | type={sender_type:10s} | {text}")
