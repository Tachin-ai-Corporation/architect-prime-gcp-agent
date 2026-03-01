#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — ONE-SHOT BOOTSTRAP (Cloud Shell)
# Runs Phase 1 (create/refresh SA + VM) then runs Phase 2 remotely.
#
# Usage (Cloud Shell):
#   export PROJECT_ID="your-project"
#   export ZONE="us-central1-a"
#   export VM="architect-prime"
#   export PRIME_SA_NAME="architect-prime"
#   export CORE_REF="<PINNED_TAG_OR_BRANCH>"
#   curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/oneshot-cloudshell.sh" | bash
# ============================================================
set -euo pipefail

# ---- CONFIG (env-overridable) ----
PROJECT_ID="${PROJECT_ID:-architect-prime-beta}"
ZONE="${ZONE:-us-central1-a}"
VM="${VM:-architect-prime}"
PRIME_SA_NAME="${PRIME_SA_NAME:-architect-prime}"

GH_OWNER="${GH_OWNER:-Tachin-ai-Corporation}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"

# ---- Derived ----
PRIME_SA_EMAIL="${PRIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

echo "==> Target repo: ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "==> Project:     ${PROJECT_ID}"
echo "==> Zone:        ${ZONE}"
echo "==> VM:          ${VM}"
echo "==> Runtime SA:  ${PRIME_SA_EMAIL}"
echo

echo "==> Phase 1 (Cloud Shell): create/refresh SA + VM"
curl -fsSL "${CORE_BASE}/bootstrap/phase1-cloudshell.sh" |   PROJECT_ID="${PROJECT_ID}"   ZONE="${ZONE}"   VM="${VM}"   PRIME_SA_NAME="${PRIME_SA_NAME}"   AUTO_SSH=0   bash

echo
echo "==> Phase 2 (on VM): install CoreKit + start OpenClaw + apply config"
REMOTE_ENV="GH_OWNER='${GH_OWNER}' GH_REPO='${GH_REPO}' CORE_REF='${CORE_REF}' GCP_PROJECT_ID='${PROJECT_ID}' EXPECTED_RUNTIME_SA_EMAIL='${PRIME_SA_EMAIL}'"

gcloud config set project "${PROJECT_ID}"
gcloud config set compute/zone "${ZONE}"

# Run Phase 2 non-interactively on the VM
gcloud compute ssh "${VM}" --zone "${ZONE}" --command \
  "set -euo pipefail; $REMOTE_ENV bash -lc 'curl -fsSL "${CORE_BASE}/bootstrap/phase2-vm.sh" | bash'"

echo
echo "✅ One-shot bootstrap finished."
