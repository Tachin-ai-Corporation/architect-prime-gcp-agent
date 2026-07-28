#!/usr/bin/env bash
# provision-firestore-indexes.sh — Idempotent composite index creation
#
# Called by prime-bootstrap.sh during initial setup.
# Each index creation is async and idempotent (no-op if already exists).
# Errors are non-fatal — indexes can be created manually later.
#
# Usage:
#   GCP_PROJECT_ID=your-gcp-project bash provision-firestore-indexes.sh

set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID required}"
DB="(default)"

info(){ echo "  [index] $*"; }

create_index() {
  local collection="$1"
  shift
  # Build --field-config flags from remaining args (field:order pairs)
  local flags=()
  for spec in "$@"; do
    local field="${spec%%:*}"
    local order="${spec##*:}"
    flags+=(--field-config "field-path=${field},order=${order}")
  done

  info "Creating: ${collection} → $*"
  gcloud firestore indexes composite create \
    --collection-group="${collection}" \
    --database="${DB}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet \
    "${flags[@]}" 2>&1 || info "  (may already exist or is building)"
}

echo "==> Provisioning Firestore composite indexes..."

# 1. work: prime_id (asc) + type (asc) + created_at (desc)
create_index work  prime_id:ascending  type:ascending  created_at:descending

# 2. work: prime_id (asc) + status (asc)
create_index work  prime_id:ascending  status:ascending

# 3. work: owner (asc) + type (asc) + status (asc) + created_at (desc)
#    Used by daemon work-finding: owner == AGENT_EMAIL, type in [M,R], status in [active,...]
create_index work  owner:ascending  type:ascending  status:ascending  created_at:descending

# 4. approvals: prime_id (asc) + requestedAt (desc)
create_index approvals  prime_id:ascending  requestedAt:descending

# 5. approvals: prime_id (asc) + status (asc) + requestedAt (desc)
create_index approvals  prime_id:ascending  status:ascending  requestedAt:descending

# 6. plans: prime_id (asc) + created_at (desc)
create_index plans  prime_id:ascending  created_at:descending

# 7. skill-proposals: prime_id (asc) + proposed_at (desc)
create_index skill-proposals  prime_id:ascending  proposed_at:descending

echo "==> Firestore index provisioning complete (indexes build asynchronously)."
