#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME — Control Plane Deploy (Cloud Shell)
#
# Deploys the Control Plane (Cloud Run) + Firestore into the
# customer's own GCP project. Everything self-hosted.
#
# Usage:
#   export PROJECT_ID="your-project"
#   bash deploy/install.sh
# ============================================================
set -euo pipefail

# ---- Helpers ----
info()  { echo -e "\e[34m[INFO]\e[0m  $*"; }
warn()  { echo -e "\e[33m[WARN]\e[0m  $*"; }
die()   { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }

# ---- Config ----
PROJECT_ID="${PROJECT_ID:-}"
[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is required. Run: export PROJECT_ID=your-project-id"

REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-architect-prime}"
SA_NAME="${SA_NAME:-architect-prime-cp}"
IMAGE_REPO="${IMAGE_REPO:-us-docker.pkg.dev/architect-prime-public/architect-prime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Derived
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${IMAGE_REPO}/control-plane:${IMAGE_TAG}"

echo
echo "╔════════════════════════════════════════════════╗"
echo "║   Architect Prime — Control Plane Installer    ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  Project:  ${PROJECT_ID}"
echo "║  Region:   ${REGION}"
echo "║  Service:  ${SERVICE_NAME}"
echo "║  Image:    ${IMAGE}"
echo "╚════════════════════════════════════════════════╝"
echo

# ---- Step 1: Set project ----
info "Setting project context..."
gcloud config set project "$PROJECT_ID" --quiet

# ---- Step 2: Enable APIs ----
info "Enabling required APIs..."
APIS=(
  run.googleapis.com
  firestore.googleapis.com
  compute.googleapis.com
  iam.googleapis.com
  aiplatform.googleapis.com
  artifactregistry.googleapis.com
)
for api in "${APIS[@]}"; do
  gcloud services enable "$api" --quiet 2>/dev/null || warn "Failed to enable $api"
done

# ---- Step 3: Create Firestore database ----
info "Creating Firestore database (native mode)..."
gcloud firestore databases create \
  --location="$REGION" \
  --type=firestore-native \
  --quiet 2>/dev/null \
  || info "Firestore database already exists (OK)"

# ---- Step 4: Create service account for Cloud Run ----
info "Creating Cloud Run service account: ${SA_NAME}..."
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Architect Prime Control Plane" \
  --quiet 2>/dev/null \
  || info "Service account already exists (OK)"

# Grant permissions the control plane needs
ROLES=(
  roles/datastore.user            # Firestore read/write
  roles/compute.admin             # Create/delete VMs for Prime + fleet
  roles/iam.serviceAccountAdmin   # Create SAs for Prime + fleet
  roles/iam.serviceAccountUser    # Attach SAs to VMs
  roles/serviceusage.serviceUsageConsumer  # Enable APIs
)
for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --quiet > /dev/null 2>&1 || warn "Failed to bind $role"
done

# ---- Step 5: Create DWD Signer SA (shared) ----
info "Creating shared DWD Signer SA..."
DWD_SIGNER_SA="dwd-signer@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts create dwd-signer \
  --display-name="DWD Signer (shared, no roles)" \
  --quiet 2>/dev/null \
  || info "DWD Signer SA already exists (OK)"

# ---- Step 6: Deploy to Cloud Run ----
info "Deploying Cloud Run service: ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --platform=managed \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},NODE_ENV=production" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --port=8080 \
  --quiet

# ---- Step 7: Get the URL ----
SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --platform=managed --region="$REGION" --format='value(status.url)')"

echo
echo "╔════════════════════════════════════════════════╗"
echo "║            ✅ DEPLOYMENT COMPLETE              ║"
echo "╠════════════════════════════════════════════════╣"
echo "║                                                ║"
echo "║  Control Plane URL:                            ║"
echo "║  ${SERVICE_URL}"
echo "║                                                ║"
echo "║  Open the URL above to:                        ║"
echo "║  1. Sign in with your Workspace admin account  ║"
echo "║  2. Deploy your first Prime instance           ║"
echo "║  3. Start chatting with Prime                  ║"
echo "║                                                ║"
echo "╚════════════════════════════════════════════════╝"
echo
