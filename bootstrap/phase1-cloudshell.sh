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

# ---- CONFIG START ----
PROJECT_ID="${PROJECT_ID:-}"
[[ -n "$PROJECT_ID" ]] || { echo "[ERROR] PROJECT_ID is required. Run: export PROJECT_ID=your-project-id"; exit 1; }
ZONE="${ZONE:-us-central1-a}"

VM="${VM:-architect-prime}"
PRIME_SA_NAME="${PRIME_SA_NAME:-architect-prime}"

VM_NET_TAG="${VM_NET_TAG:-allow-https}"
FW_RULE_NAME="${FW_RULE_NAME:-allow-https-chat}"

MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-200GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"

# Optional: billing account for fleet-deploy (passed as VM metadata)
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"

# Optional: Workspace user email for DWD impersonation (the agent sends/reads Chat as this user)
AGENT_USER_EMAIL="${AGENT_USER_EMAIL:-}"

# Optional: GCP org ID for fleet-deploy project creation (passed as VM metadata)
# Find it: gcloud organizations list
GCP_ORG_ID="${GCP_ORG_ID:-}"

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
echo "===> Enable required APIs (idempotent)"
gcloud services enable \
  compute.googleapis.com \
  aiplatform.googleapis.com \
  chat.googleapis.com \
  iam.googleapis.com \
  serviceusage.googleapis.com \
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

# NOTE: roles/chat.bot is NOT needed — agents use DWD user impersonation.

# Token Creator role (allows SA to call signJwt for DWD)
add_bind "serviceAccount:${PRIME_SA_EMAIL}" "roles/iam.serviceAccountTokenCreator"

# Org-level roles for fleet-deploy (only if GCP_ORG_ID is set)
if [[ -n "${GCP_ORG_ID:-}" ]]; then
  echo
  echo "==> Granting org-level roles for fleet deployment"
  for org_role in roles/resourcemanager.projectCreator roles/billing.admin; do
    echo "Binding: serviceAccount:${PRIME_SA_EMAIL} -> ${org_role} (org: ${GCP_ORG_ID})"
    gcloud organizations add-iam-policy-binding "$GCP_ORG_ID" \
      --member="serviceAccount:${PRIME_SA_EMAIL}" \
      --role="$org_role" \
      --quiet > /dev/null 2>&1 || echo "[WARN] Failed to bind ${org_role} at org level"
  done
else
  echo
  echo "[INFO] GCP_ORG_ID not set — skipping org-level IAM (fleet-deploy will require manual setup)"
fi

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
echo "==> (Skipped: Cloud Function and GCS inbox — replaced by DWD Chat polling)"

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
  --scopes="https://www.googleapis.com/auth/cloud-platform" \
  --tags="$VM_NET_TAG" \
  --labels="$LABELS" \
  --metadata="architect_prime=true,role=prime,env=beta,agent_user_email=${AGENT_USER_EMAIL:-},chat_space_id=${CHAT_SPACE_ID:-},billing_account=${BILLING_ACCOUNT:-},gcp_org_id=${GCP_ORG_ID:-},admin_email=${CURRENT_USER}"

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
echo "  Agent User     : ${AGENT_USER_EMAIL:-not set}"
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
# Get SA Client ID for DWD setup
SA_UNIQUE_ID="$(gcloud iam service-accounts describe "$PRIME_SA_EMAIL" --format='value(uniqueId)' 2>/dev/null || echo 'unknown')"

echo "============================================================"
echo "  DWD SETUP (one-time, by Workspace admin)"
echo "============================================================"
echo
echo "  The inbox-daemon now uses Domain-Wide Delegation (DWD)"
echo "  to read/send Chat messages as a Workspace user."
echo
echo "  Step 1: Grant DWD in Admin Console"
echo "    Go to: https://admin.google.com → Security → API Controls → Domain-Wide Delegation"
echo "    Click 'Add new' and enter:"
echo "    - Client ID: ${SA_UNIQUE_ID}"
echo "    - Scopes:"
echo "      https://www.googleapis.com/auth/chat.messages,https://www.googleapis.com/auth/chat.messages.create,https://www.googleapis.com/auth/chat.messages.readonly,https://www.googleapis.com/auth/chat.spaces.readonly"
echo "    Click 'Authorize' (may take up to 24h to propagate)"
echo
echo "  Step 2: Create a Workspace user for Prime"
echo "    e.g., prime@yourdomain.com"
echo "    Then set: export AGENT_USER_EMAIL=prime@yourdomain.com"
echo "    And re-run bootstrap, or update VM metadata:"
echo "      gcloud compute instances add-metadata ${VM} --zone ${ZONE} \\"
echo "        --metadata=agent_user_email=prime@yourdomain.com"
echo
echo "  Step 3: Create a Chat space and add the user"
echo "    Open Google Chat → New space → Add the agent user"
echo "    Get the space ID from the URL (format: spaces/XXXXXXXXX)"
echo "    Set: gcloud compute instances add-metadata ${VM} --zone ${ZONE} \\"
echo "      --metadata=chat_space_id=spaces/YOUR_SPACE_ID"
echo
echo "  Step 4: Test"
echo "    @-mention the agent user in Chat. The inbox-daemon will"
echo "    detect the mention and respond."
echo
echo "============================================================"
echo

