#!/bin/bash
# Re-apply the ADC auth patch for GCE metadata
AUTH_FILE="/app/dist/model-auth-env-B-45Q6PX.js"
sed -i 's|if (!envKey) return null;|if (!envKey) return { apiKey: "<gce-adc>", source: "gce metadata" };|' "$AUTH_FILE"
echo "=== Patch applied ==="
grep 'gce-adc' "$AUTH_FILE"
echo "=== Restarting gateway process ==="
# Kill the node process to trigger container restart
kill 1 2>/dev/null || true
