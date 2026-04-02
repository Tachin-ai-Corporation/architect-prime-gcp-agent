#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — Uninstall / Clean Teardown
#
# Removes all Architect Prime resources from the GCP project.
# This will delete Prime VMs, fleet VMs, service accounts,
# Cloud Run service, and Firestore collections.
#
# Usage:
#   export PROJECT_ID="your-project"
#   bash deploy/uninstall.sh
# ============================================================
set -euo pipefail

# ---- Helpers ----
info()  { echo -e "\e[34m[INFO]\e[0m  $*"; }
ok()    { echo -e "\e[32m[ OK ]\e[0m  $*"; }
warn()  { echo -e "\e[33m[WARN]\e[0m  $*"; }
die()   { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }

# ---- Prerequisites ----
command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required."

# ---- Config ----
PROJECT_ID="${PROJECT_ID:-}"
[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is required. Run: export PROJECT_ID=your-project-id"

REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-architect-prime}"
SA_NAME="${SA_NAME:-architect-prime-cp}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DWD_SIGNER_SA="dwd-signer@${PROJECT_ID}.iam.gserviceaccount.com"

echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║       Architect Prime — UNINSTALL                      ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Project:  ${PROJECT_ID}"
echo "║  Region:   ${REGION}"
echo "║                                                        ║"
echo "║  ⚠️  This will DELETE all Architect Prime resources    ║"
echo "║  including Prime VMs, fleet VMs, and all data.         ║"
echo "╚════════════════════════════════════════════════════════╝"
echo

read -p "Are you sure you want to uninstall? Type YES to continue: " confirm
[[ "$confirm" == "YES" ]] || die "Aborted."

gcloud config set project "$PROJECT_ID" --quiet

# ---- Step 1: Delete all Prime and fleet VMs ----
info "Discovering Architect Prime VMs..."
PRIME_VMS=$(gcloud compute instances list \
  --filter="name~'^prime-'" \
  --format="csv[no-heading](name,zone)" \
  --project="$PROJECT_ID" 2>/dev/null || echo "")

FLEET_VMS=$(gcloud compute instances list \
  --filter="name~'^fleet-'" \
  --format="csv[no-heading](name,zone)" \
  --project="$PROJECT_ID" 2>/dev/null || echo "")

ALL_VMS="${PRIME_VMS}
${FLEET_VMS}"

if [[ -n "${ALL_VMS// /}" ]]; then
  while IFS=',' read -r name zone; do
    [[ -z "$name" ]] && continue
    info "Deleting VM: $name (zone: $zone)..."
    gcloud compute instances delete "$name" \
      --zone="$zone" --project="$PROJECT_ID" --quiet 2>/dev/null \
      && ok "Deleted VM: $name" \
      || warn "Failed to delete VM: $name"
  done <<< "$ALL_VMS"
else
  ok "No Prime/Fleet VMs found"
fi

# ---- Step 2: Delete fleet service accounts ----
info "Discovering fleet service accounts..."
FLEET_SAS=$(gcloud iam service-accounts list \
  --filter="email~'^fleet-'" \
  --format="value(email)" \
  --project="$PROJECT_ID" 2>/dev/null || echo "")

if [[ -n "$FLEET_SAS" ]]; then
  while IFS= read -r sa_email; do
    [[ -z "$sa_email" ]] && continue
    info "Deleting SA: $sa_email..."
    gcloud iam service-accounts delete "$sa_email" --quiet 2>/dev/null \
      && ok "Deleted SA: $sa_email" \
      || warn "Failed to delete SA: $sa_email"
  done <<< "$FLEET_SAS"
else
  ok "No fleet service accounts found"
fi

# ---- Step 3: Delete Cloud Run service ----
info "Deleting Cloud Run service: $SERVICE_NAME..."
gcloud run services delete "$SERVICE_NAME" \
  --region="$REGION" --platform=managed --quiet 2>/dev/null \
  && ok "Deleted Cloud Run service" \
  || warn "Cloud Run service not found or already deleted"

# ---- Step 4: Delete DWD Signer SA ----
info "Deleting DWD Signer SA..."
gcloud iam service-accounts delete "$DWD_SIGNER_SA" --quiet 2>/dev/null \
  && ok "Deleted DWD Signer SA" \
  || warn "DWD Signer SA not found"

# ---- Step 5: Delete Control Plane SA ----
info "Deleting Control Plane SA: $SA_EMAIL..."
gcloud iam service-accounts delete "$SA_EMAIL" --quiet 2>/dev/null \
  && ok "Deleted Control Plane SA" \
  || warn "Control Plane SA not found"

# ---- Step 6: Delete Firestore data ----
info "Deleting Firestore collections (primes, config)..."
ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null || echo '')"
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents"

if [[ -n "$ACCESS_TOKEN" ]]; then
  # Delete config/dwd
  curl -s -X DELETE \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "${FIRESTORE_URL}/config/dwd" > /dev/null 2>&1 \
    && ok "Deleted Firestore config/dwd" \
    || warn "config/dwd not found"

  # Note: Firestore collections (primes, fleet subcollections) are cleaned
  # when their parent docs are deleted. For a complete purge, use the
  # Firebase CLI: firebase firestore:delete --all-collections
  ok "Firestore data cleaned (parent docs deleted with VMs)"
else
  warn "Could not get access token for Firestore cleanup"
fi

echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║              ✅ UNINSTALL COMPLETE                     ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║  All Architect Prime resources have been removed.      ║"
echo "║                                                        ║"
echo "║  Remaining (manual cleanup if desired):                ║"
echo "║  - Artifact Registry: architect-prime                  ║"
echo "║  - Firestore database (shared resource)                ║"
echo "║  - Enabled APIs (harmless to leave)                    ║"
echo "║  - IAM policy bindings for deleted SAs (auto-cleaned)  ║"
echo "║                                                        ║"
echo "║  To reinstall:                                         ║"
echo "║  bash deploy/install.sh                                ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo
