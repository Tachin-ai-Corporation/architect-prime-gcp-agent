#!/usr/bin/env bash
set -euo pipefail

echo "== bootstrap_smoke: basic sanity checks =="

echo "-- whoami / pwd"
whoami
pwd

echo "-- oc wrapper"
command -v oc || true
oc --help >/dev/null 2>&1 || true

echo "-- OpenClaw repo present"
test -d /app
test -f /app/package.json

echo "-- doctor (non-interactive)"
oc doctor --non-interactive || true

echo "-- ADC metadata token reachable (GCE only; non-fatal on non-GCE)"
set +e
curl -sS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" | head -c 200 || true
set -e

echo "== bootstrap_smoke: done =="
