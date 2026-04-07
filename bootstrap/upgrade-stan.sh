#!/usr/bin/env bash
# Upgrade CoreKit and restart inbox-daemon on fleet-stan
set -uo pipefail

echo "=== Upgrading CoreKit ==="
bash /opt/openclaw/.openclaw/bin/upgrade-corekit --apply main 2>&1 | tail -8

echo ""
echo "=== Clearing stale state ==="
rm -f /tmp/inbox-daemon-processed.json /tmp/inbox-daemon-highwater /tmp/inbox-daemon-spaces.json
echo "Cleared processed files"

echo ""
echo "=== Restarting inbox-daemon ==="
systemctl restart inbox-daemon
sleep 3
systemctl is-active inbox-daemon && echo "inbox-daemon: ACTIVE" || echo "inbox-daemon: FAILED"

echo ""
echo "=== inbox-daemon logs (first 10 lines after restart) ==="
journalctl -u inbox-daemon --no-pager -n 10 2>/dev/null

echo ""
echo "=== DONE ==="
