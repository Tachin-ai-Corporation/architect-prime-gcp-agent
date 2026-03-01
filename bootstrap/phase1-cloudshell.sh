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
  serviceusage.googleapis.com

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
  --metadata="architect_prime=true,role=prime,env=beta"

echo
echo "==> Wait for boot + show facts"
sleep 25

STATUS="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)')"
INT_IP="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].networkIP)')"
EXT_IP="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
ATTACHED_SA="$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(serviceAccounts[0].email)')"

echo "VM status      : $STATUS"
echo "VM internal IP : $INT_IP"
echo "VM external IP : ${EXT_IP:-n/a}"
echo "VM attached SA : $ATTACHED_SA"

echo
echo "============================================================"
echo "VM ready."
echo "SSH in and run Phase 2:"
echo "gcloud compute ssh $VM --zone $ZONE"
echo "Log file: $LOG_FILE"
echo "============================================================"
echo

# Safe default when invoked via: curl ... | bash
AUTO_SSH="${AUTO_SSH:-1}"
if [[ ! -t 0 ]]; then AUTO_SSH=0; fi

if [[ "${AUTO_SSH}" == "1" ]]; then
  # avoid consuming piped stdin; force interactive tty
  gcloud compute ssh "$VM" --zone "$ZONE" </dev/tty
fi
