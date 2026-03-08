#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — PHASE 1 (NORMALIZED + DEBUGGABLE)
# Creates/updates runtime SA + firewall + VM in an existing project.
# Shows errors (no /dev/null) and logs to a file.
# ============================================================
set -euo pipefail

# ---- LOGGING (always) ----
LOG_FILE="${LOG_FILE:-./architect-prime-phase1-$(date +%Y%m%d-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "Logging to: $LOG_FILE"

# ---- DEBUG TRAP ----
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "See log: $LOG_FILE"; exit 1' ERR

# ---- CONFIG START (edit these) ----
PROJECT_ID="${PROJECT_ID:-architect-prime-beta}"
ZONE="${ZONE:-us-central1-a}"

VM="${VM:-architect-prime}"
PRIME_SA_NAME="${PRIME_SA_NAME:-architect-prime}"

VM_NET_TAG="${VM_NET_TAG:-allow-https}"
FW_RULE_NAME="${FW_RULE_NAME:-allow-https-chat}"

MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-200GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"

# Labels must be KEY=VALUE comma-separated
LABELS="${LABELS:-app=architect-prime,role=prime,env=beta,managed=bootstrap}"
# ---- CONFIG END ----

PRIME_SA_EMAIL="${PRIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo
echo "==== CONFIG ===="
echo "PROJECT_ID     : $PROJECT_ID"
echo "ZONE           : $ZONE"
echo "VM             : $VM"
echo "PRIME_SA_EMAIL : $PRIME_SA_EMAIL"
echo "FW_RULE_NAME   : $FW_RULE_NAME"
echo "VM_NET_TAG     : $VM_NET_TAG"
echo "MACHINE_TYPE   : $MACHINE_TYPE"
echo "BOOT_DISK_SIZE : $BOOT_DISK_SIZE"
echo "IMAGE          : $IMAGE_PROJECT/$IMAGE_FAMILY"
echo "LABELS         : $LABELS"
echo "==============="
echo

echo "==> gcloud context"
gcloud config set project "$PROJECT_ID"
gcloud config set compute/zone "$ZONE"

CURRENT_USER="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
if [[ -z "$CURRENT_USER" ]]; then
  echo "[ERROR] No active gcloud user session found. Run: gcloud auth login"
  exit 1
fi
echo "Active user: $CURRENT_USER"

echo
echo "==> Enable required APIs (idempotent)"
gcloud services enable \
  compute.googleapis.com \
  aiplatform.googleapis.com \
  chat.googleapis.com \
  iam.googleapis.com \
  serviceusage.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com

echo
echo "==> Ensure caller has Service Usage Admin (best-effort)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="user:${CURRENT_USER}" \
  --role="roles/serviceusage.serviceUsageAdmin" || true

echo
echo "==> Ensure runtime service account exists"
if ! gcloud iam service-accounts describe "$PRIME_SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$PRIME_SA_NAME" \
    --display-name="Architect Prime Runtime"
else
  echo "Service account already exists: $PRIME_SA_EMAIL"
fi

echo
echo "==> Ensure IAM bindings for runtime SA (idempotent, best-effort)"
add_bind() {
  local member="$1"
  local role="$2"
  echo "Binding: ${member} -> ${role}"
  if ! gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="$member" \
      --role="$role" >/dev/null 2>&1; then
    echo "[WARN] Failed to bind ${role} to ${member}. (Likely conditional IAM policy / unsupported role.)"
    echo "       You can inspect with: gcloud projects get-iam-policy $PROJECT_ID --format=json"
  fi
}

# Owner (explicit override, preserved)
add_bind "serviceAccount:${PRIME_SA_EMAIL}" "roles/owner"

# Minimal roles (project-level)
add_bind "serviceAccount:${PRIME_SA_EMAIL}" "roles/aiplatform.user"
add_bind "serviceAccount:${PRIME_SA_EMAIL}" "roles/compute.admin"
add_bind "serviceAccount:${PRIME_SA_EMAIL}" "roles/serviceusage.serviceUsageConsumer"

# NOTE: roles/chat.bot is NOT a project-level role; do not bind it here.
# Chat access is handled via Chat app configuration / Chat API + service identity.

echo
echo "==> Ensure firewall rule exists: $FW_RULE_NAME"
if ! gcloud compute firewall-rules describe "$FW_RULE_NAME" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$FW_RULE_NAME" \
    --allow=tcp:443 \
    --target-tags="$VM_NET_TAG" \
    --direction=INGRESS \
    --priority=1000 \
    --network=default
else
  echo "Firewall rule already exists: $FW_RULE_NAME"
fi

echo
echo "==> Create Chat inbox bucket (if not exists)"
INBOX_BUCKET="${GCP_PROJECT_ID}-chat-inbox"
if ! gsutil ls -b "gs://${INBOX_BUCKET}" &>/dev/null; then
  gsutil mb -l us-central1 "gs://${INBOX_BUCKET}"
  echo "Created: gs://${INBOX_BUCKET}"
else
  echo "Bucket already exists: gs://${INBOX_BUCKET}"
fi

# Grant service account access to inbox bucket
gsutil iam ch "serviceAccount:${PRIME_SA_EMAIL}:roles/storage.objectAdmin" "gs://${INBOX_BUCKET}"

# Grant default compute SA the Cloud Build role (required for CF deploy)
PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT_ID}" --format='value(projectNumber)')"
DEFAULT_COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:${DEFAULT_COMPUTE_SA}" \
  --role="roles/cloudbuild.builds.builder" \
  --quiet 2>/dev/null || true

echo
echo "==> Deploy Chat handler Cloud Function"
CHAT_CF_NAME="chat-handler"
CHAT_CF_SOURCE="$(cd "$(dirname "$0")/../cloud-functions/chat-handler" && pwd)"
if [[ -d "$CHAT_CF_SOURCE" ]]; then
  gcloud functions deploy "$CHAT_CF_NAME" \
    --gen2 \
    --runtime=python312 \
    --region=us-central1 \
    --source="$CHAT_CF_SOURCE" \
    --entry-point=handle_chat_event \
    --trigger-http \
    --allow-unauthenticated \
    --set-env-vars="INBOX_BUCKET=${INBOX_BUCKET},AGENT_ID=prime" \
    --memory=256MB \
    --timeout=30s \
    --quiet || echo "[WARN] Cloud Function deploy failed (may need manual setup)"

  CF_URL="$(gcloud functions describe "$CHAT_CF_NAME" --gen2 --region=us-central1 --format='value(serviceConfig.uri)' 2>/dev/null || true)"
  if [[ -n "$CF_URL" ]]; then
    echo "Cloud Function URL: $CF_URL"
    echo ">> Set this URL as the Chat app HTTP endpoint in GCP console"
  fi
else
  echo "[WARN] Cloud Function source not found at $CHAT_CF_SOURCE — skipping deploy"
fi

echo
echo "==> Hard reset VM (delete if exists)"
gcloud compute instances delete "$VM" --zone "$ZONE" --quiet || true

echo
echo "==> Create VM"
gcloud compute instances create "$VM" \
  --zone="$ZONE" \
  --image-family="$IMAGE_FAMILY" \
  --image-project="$IMAGE_PROJECT" \
  --machine-type="$MACHINE_TYPE" \
  --boot-disk-size="$BOOT_DISK_SIZE" \
  --service-account="$PRIME_SA_EMAIL" \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/chat.bot" \
  --tags="$VM_NET_TAG" \
  --labels="$LABELS" \
  --metadata="architect_prime=true,role=prime,env=beta,chat_space_id=${CHAT_SPACE_ID:-},chat_cf_url=${CF_URL:-}"

echo
echo "==> Wait for boot + show facts"
sleep 25

STATUS="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)')"
INT_IP="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].networkIP)')"
EXT_IP="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
ATTACHED_SA="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(serviceAccounts[0].email)')"

echo
echo "============================================================"
echo "  PHASE 1 COMPLETE — Architect Prime"
echo "============================================================"
echo
echo "  Project        : ${PROJECT_ID}"
echo "  VM             : ${VM} (${STATUS})"
echo "  Zone           : ${ZONE}"
echo "  External IP    : ${EXT_IP:-n/a}"
echo "  Internal IP    : ${INT_IP}"
echo "  Service Account: ${ATTACHED_SA}"
echo "  Machine Type   : ${MACHINE_TYPE}"
echo "  Disk           : ${BOOT_DISK_SIZE}"
echo "  Inbox Bucket   : gs://${INBOX_BUCKET:-${PROJECT_ID}-chat-inbox}"
echo "  Cloud Function : ${CF_URL:-not deployed}"
echo "  Log File       : ${LOG_FILE}"
echo
echo "============================================================"
echo "  WHAT HAPPENS NEXT"
echo "============================================================"
echo
echo "  Phase 2 is running automatically on the VM."
echo "  It will take ~15-20 minutes to:"
echo "    - Install Docker"
echo "    - Build the OpenClaw container"
echo "    - Install CoreKit (38 files via manifest)"
echo "    - Start the inbox-daemon service"
echo
echo "  Monitor progress:"
echo "    gcloud compute instances get-serial-port-output ${VM} --zone ${ZONE}"
echo
echo "  SSH into the VM:"
echo "    gcloud compute ssh ${VM} --zone ${ZONE}"
echo
if [[ -n "${CF_URL:-}" ]]; then
  echo "============================================================"
  echo "  CHAT SETUP (one-time manual steps)"
  echo "============================================================"
  echo
  echo "  Step 1: Configure the Chat app"
  echo "    Go to: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${PROJECT_ID}"
  echo "    - App name: Architect Prime"
  echo "    - Enable interactive features"
  echo "    - Connection settings → HTTP endpoint URL"
  echo "    - Paste: ${CF_URL}"
  echo "    - Visibility: your domain or users"
  echo "    - Save"
  echo
  echo "  Step 2: Create a Google Chat space"
  echo "    - Open Google Chat → New space"
  echo "    - Add the 'Architect Prime' app"
  echo
  echo "  Step 3: Set the space ID"
  echo "    - Get the space ID from the Chat URL (format: spaces/XXXXXXXXX)"
  echo "    - Run:"
  echo "      gcloud compute instances add-metadata ${VM} --zone ${ZONE} \\"
  echo "        --metadata=chat_space_id=spaces/YOUR_SPACE_ID"
  echo
  echo "  Step 4: Test"
  echo "    Message '@Architect Prime help' in your Chat space."
  echo
fi
echo "============================================================"
echo

