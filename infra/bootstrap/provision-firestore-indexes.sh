#!/usr/bin/env bash
# provision-firestore-indexes.sh — Apply the single index authority, then wait.
#
# There used to be two authorities: this script hand-listed 7 composite indexes
# while `firestore.indexes.json` declared a different 6. Neither was a superset —
# the script still named `prime_id` fields (work moved to root-level `owner`
# scoping under C-1) and a `plans` collection that no aggregate writes. A fresh
# deployment therefore got a different index set depending on which path ran, and
# a query could work on one deployment and fail on another.
#
# `firestore.indexes.json` is now the only authority (C-7). This script reads it
# and applies it — nothing is declared here.
#
# It also waits for the indexes to reach READY. Composite index creation is
# asynchronous; returning as soon as the API accepts the request meant bootstrap
# could hand a "provisioned" deployment to an agent whose very first query would
# fail with FAILED_PRECONDITION.
#
# Usage:
#   GCP_PROJECT_ID=your-gcp-project bash provision-firestore-indexes.sh
#   INDEX_WAIT_SECONDS=0 ...   # apply without waiting

set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
DB="(default)"
INDEX_WAIT_SECONDS="${INDEX_WAIT_SECONDS:-600}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo layout: infra/bootstrap/ → repo root. On a VM the file ships to CORE_ROOT.
INDEX_FILE="${FIRESTORE_INDEX_FILE:-}"
if [[ -z "$INDEX_FILE" ]]; then
  for candidate in \
    "${SCRIPT_DIR}/../../firestore.indexes.json" \
    "${CORE_ROOT:-/opt/corekit}/corekit/firestore.indexes.json" \
    "${SCRIPT_DIR}/firestore.indexes.json"; do
    [[ -f "$candidate" ]] && { INDEX_FILE="$candidate"; break; }
  done
fi
[[ -f "$INDEX_FILE" ]] || { echo "[ERROR] firestore.indexes.json not found (set FIRESTORE_INDEX_FILE)" >&2; exit 1; }

info(){ echo "  [index] $*"; }

echo "==> Provisioning Firestore composite indexes from ${INDEX_FILE}"

# Emit one `collection<TAB>scope<TAB>field:order,field:order` line per index.
# python3 rather than jq: jq is not guaranteed on a freshly booted VM.
INDEX_SPECS="$(python3 - "$INDEX_FILE" <<'PYEOF'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for idx in doc.get("indexes", []):
    fields = ",".join(
        f'{f["fieldPath"]}:{f.get("order", "ASCENDING").lower()}'
        for f in idx.get("fields", [])
        if "fieldPath" in f
    )
    if not fields:
        continue
    print(f'{idx["collectionGroup"]}\t{idx.get("queryScope", "COLLECTION")}\t{fields}')
PYEOF
)"

[[ -n "$INDEX_SPECS" ]] || { echo "[ERROR] no indexes declared in ${INDEX_FILE}" >&2; exit 1; }

APPLIED=0
while IFS=$'\t' read -r collection scope fields; do
  [[ -n "$collection" ]] || continue
  flags=()
  IFS=',' read -ra SPECS <<< "$fields"
  for spec in "${SPECS[@]}"; do
    flags+=(--field-config "field-path=${spec%%:*},order=${spec##*:}")
  done
  [[ "$scope" == "COLLECTION_GROUP" ]] && flags+=(--query-scope=COLLECTION_GROUP)

  info "Applying: ${collection} → ${fields}"
  gcloud firestore indexes composite create \
    --collection-group="${collection}" \
    --database="${DB}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet \
    "${flags[@]}" >/dev/null 2>&1 || info "  (already exists or is building)"
  APPLIED=$((APPLIED + 1))
done <<< "$INDEX_SPECS"

info "Applied ${APPLIED} index declaration(s)"

# ---- Wait for READY ----
if [[ "$INDEX_WAIT_SECONDS" -le 0 ]]; then
  echo "==> Skipping readiness wait (INDEX_WAIT_SECONDS=0)"
  exit 0
fi

echo "==> Waiting up to ${INDEX_WAIT_SECONDS}s for indexes to become READY..."
DEADLINE=$(( $(date +%s) + INDEX_WAIT_SECONDS ))
while :; do
  BUILDING="$(gcloud firestore indexes composite list \
    --database="${DB}" --project="${GCP_PROJECT_ID}" \
    --format='value(state)' 2>/dev/null | grep -c -v '^READY$' || true)"

  if [[ "${BUILDING:-0}" -eq 0 ]]; then
    echo "==> All Firestore indexes are READY."
    exit 0
  fi
  if [[ "$(date +%s)" -ge "$DEADLINE" ]]; then
    # Non-fatal: indexes finish building on their own, and blocking a bootstrap
    # forever on Google's build queue helps nobody. But say so loudly — an agent
    # that queries before this completes will see FAILED_PRECONDITION.
    echo "[WARN] ${BUILDING} index(es) still building after ${INDEX_WAIT_SECONDS}s."
    echo "[WARN] Queries against them will fail until they finish."
    exit 0
  fi
  info "${BUILDING} still building..."
  sleep 10
done
