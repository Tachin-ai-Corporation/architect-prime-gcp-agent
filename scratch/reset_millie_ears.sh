#!/usr/bin/env bash
echo '{}' > /var/lib/agent-ears-state/seen.json
echo '{"spaces/AAQAWx8gWqw":"2026-06-27T16:50:00.000Z"}' > /var/lib/agent-ears-state/cursors.json
systemctl restart agent-ears
echo "Ears state reset and restarted successfully!"
