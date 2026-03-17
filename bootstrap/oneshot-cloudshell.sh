#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — ONE-SHOT BOOTSTRAP (Cloud Shell)
# Runs Phase 1 (create/refresh SA + VM with Phase 2 startup script)
# then waits for Phase 2 to complete automatically.
#
# Usage (Cloud Shell):
#   export PROJECT_ID="your-project"
#   export CORE_REF="<PINNED_TAG_OR_BRANCH>"
#   curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/oneshot-cloudshell.sh" | bash
# ============================================================
set -euo pipefail

# ---- CONFIG (env-overridable) ----
PROJECT_ID="${PROJECT_ID:-}"
[[ -n "$PROJECT_ID" ]] || { echo "[ERROR] PROJECT_ID is required. Run: export PROJECT_ID=your-project-id"; exit 1; }
ZONE="${ZONE:-us-central1-a}"
VM="${VM:-architect-prime}"
PRIME_SA_NAME="${PRIME_SA_NAME:-architect-prime}"

GH_OWNER="${GH_OWNER:-Tachin-ai-Corporation}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"

# DWD vars (optional — Chat integration)
AGENT_USER_EMAIL="${AGENT_USER_EMAIL:-}"
CHAT_SPACE_ID="${CHAT_SPACE_ID:-}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
GCP_ORG_ID="${GCP_ORG_ID:-}"

# ---- Derived ----
PRIME_SA_EMAIL="${PRIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

echo "==> Target repo: ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "==> Project:     ${PROJECT_ID}"
echo "==> Zone:        ${ZONE}"
echo "==> VM:          ${VM}"
echo "==> Runtime SA:  ${PRIME_SA_EMAIL}"
echo

echo "==> Phase 1 (Cloud Shell): create SA + VM with Phase 2 startup script"
curl -fsSL "${CORE_BASE}/bootstrap/phase1-cloudshell.sh" | \
  PROJECT_ID="${PROJECT_ID}" \
  ZONE="${ZONE}" \
  VM="${VM}" \
  PRIME_SA_NAME="${PRIME_SA_NAME}" \
  CORE_REF="${CORE_REF}" \
  AGENT_USER_EMAIL="${AGENT_USER_EMAIL}" \
  CHAT_SPACE_ID="${CHAT_SPACE_ID}" \
  BILLING_ACCOUNT="${BILLING_ACCOUNT}" \
  GCP_ORG_ID="${GCP_ORG_ID}" \
  bash

echo
echo "==> Phase 2 is running automatically on the VM via startup script."
echo "    Polling serial port for completion (timeout: 20 minutes)..."
echo

DEADLINE=$(($(date +%s) + 1200))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  SERIAL="$(gcloud compute instances get-serial-port-output "$VM" \
    --zone "$ZONE" --project "$PROJECT_ID" --start=0 2>/dev/null | tail -20 || true)"

  if echo "$SERIAL" | grep -q "========== PHASE 2 COMPLETE =========="; then
    echo
    echo "✅ Phase 2 complete!"
    echo
    echo "==> One-shot bootstrap finished."
    echo "    SSH in: gcloud compute ssh $VM --zone $ZONE --project $PROJECT_ID"
    exit 0
  fi

  if echo "$SERIAL" | grep -q "\[ERROR\].*Line .* failed"; then
    echo
    echo "[ERROR] Phase 2 failed. Check serial output:"
    echo "  gcloud compute instances get-serial-port-output $VM --zone $ZONE --project $PROJECT_ID"
    exit 1
  fi

  echo -n "."
  sleep 20
done

echo
echo "[WARN] Timeout waiting for Phase 2. Check manually:"
echo "  gcloud compute instances get-serial-port-output $VM --zone $ZONE --project $PROJECT_ID"
exit 1
