#!/bin/bash
# Test probe-only and count models
result=$(GCP_PROJECT_ID=architect-prime-beta OC_HOST_ROOT=/opt/openclaw /opt/openclaw/.openclaw/bin/discover-models --probe-only 2>/dev/null)
echo "$result" | python3 -c "
import json, sys
d = json.load(sys.stdin)
models = d.get('models', [])
print(f'Total models: {len(models)}')
for m in models:
    print(f'  {m[\"name\"]}: {m[\"status\"]}')
print(f'Best: {d.get(\"bestModel\",\"\")}')
print(f'Current: {d.get(\"currentModel\",\"\")}')
"
