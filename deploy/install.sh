#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME v1.0 — Control Plane Installer (Cloud Shell)
#
# Deploys the Control Plane (Cloud Run) + Firestore + DWD Signer
# into the customer's own GCP project. Everything self-hosted.
#
# Usage:
#   export PROJECT_ID="your-project"
#   bash deploy/install.sh
#
# Environment variables:
#   PROJECT_ID     (required) GCP project to deploy into
#   REGION         (default: us-central1)
#   SERVICE_NAME   (default: architect-prime)
#   IMAGE_TAG      (default: latest)
# ============================================================
set -euo pipefail

# ---- Helpers ----
info()  { echo -e "\e[34m[INFO]\e[0m  $*"; }
ok()    { echo -e "\e[32m[ OK ]\e[0m  $*"; }
warn()  { echo -e "\e[33m[WARN]\e[0m  $*"; }
die()   { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }

# ---- Prerequisites ----
command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required. Install: https://cloud.google.com/sdk/docs/install"
command -v curl   >/dev/null 2>&1 || die "curl is required."

# ---- Config ----
PROJECT_ID="${PROJECT_ID:-}"
[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is required. Run: export PROJECT_ID=your-project-id"

REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-architect-prime}"
SA_NAME="${SA_NAME:-architect-prime-cp}"
IMAGE_REPO="${IMAGE_REPO:-us-docker.pkg.dev/architect-prime-public/architect-prime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
APP_VERSION="${APP_VERSION:-v1.0.0}"

# Derived
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${IMAGE_REPO}/control-plane:${IMAGE_TAG}"
DWD_SIGNER_SA="dwd-signer@${PROJECT_ID}.iam.gserviceaccount.com"

echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║       Architect Prime — Control Plane Installer        ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Version:  ${APP_VERSION}"
echo "║  Project:  ${PROJECT_ID}"
echo "║  Region:   ${REGION}"
echo "║  Service:  ${SERVICE_NAME}"
echo "║  Image:    ${IMAGE}"
echo "╚════════════════════════════════════════════════════════╝"
echo

# ---- Step 1: Set project ----
info "Setting project context..."
gcloud config set project "$PROJECT_ID" --quiet
ok "Project set to $PROJECT_ID"

# ---- Step 2: Enable APIs ----
info "Enabling required APIs (this may take a few minutes on first run)..."
APIS=(
  run.googleapis.com
  firestore.googleapis.com
  compute.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  aiplatform.googleapis.com
  artifactregistry.googleapis.com
)
for api in "${APIS[@]}"; do
  gcloud services enable "$api" --quiet 2>/dev/null && ok "$api" || warn "Failed to enable $api"
done

# ---- Step 3: Create Firestore database ----
info "Creating Firestore database (native mode)..."
gcloud firestore databases create \
  --location="$REGION" \
  --type=firestore-native \
  --quiet 2>/dev/null \
  && ok "Firestore database created" \
  || ok "Firestore database already exists"

# ---- Step 4: Create service account for Cloud Run ----
info "Creating Cloud Run service account: ${SA_NAME}..."
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Architect Prime Control Plane" \
  --quiet 2>/dev/null \
  && ok "Service account created" \
  || ok "Service account already exists"

# Grant permissions the control plane needs
info "Granting IAM roles to ${SA_EMAIL}..."
ROLES=(
  roles/datastore.user              # Firestore read/write
  roles/compute.admin               # Create/delete VMs for Prime + fleet
  roles/iam.serviceAccountAdmin     # Create SAs for Prime + fleet
  roles/iam.serviceAccountUser      # Attach SAs to VMs
  roles/iam.serviceAccountTokenCreator  # Sign JWTs for DWD
  roles/serviceusage.serviceUsageConsumer  # Enable APIs
  roles/aiplatform.user             # Vertex AI access for agent LLM
)
for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet > /dev/null 2>&1 && ok "$role" || warn "Failed to bind $role"
done

# ---- Step 5: Create DWD Signer SA (shared) ----
info "Creating shared DWD Signer SA..."
gcloud iam service-accounts create dwd-signer \
  --display-name="DWD Signer (shared, no project roles)" \
  --quiet 2>/dev/null \
  && ok "DWD Signer SA created" \
  || ok "DWD Signer SA already exists"

# Get the DWD Signer SA's unique Client ID (needed for Workspace DWD config)
info "Retrieving DWD Signer SA Client ID..."
DWD_CLIENT_ID="$(gcloud iam service-accounts describe "$DWD_SIGNER_SA" \
  --format='value(uniqueId)' 2>/dev/null || echo '')"
ok "DWD Client ID: ${DWD_CLIENT_ID:-UNKNOWN}"

# Grant the control-plane SA permission to sign tokens as dwd-signer
gcloud iam service-accounts add-iam-policy-binding "$DWD_SIGNER_SA" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --quiet > /dev/null 2>&1 \
  && ok "Token creator binding on DWD Signer SA" \
  || warn "Failed to grant tokenCreator on DWD Signer"

# ---- Step 6: Create Artifact Registry (for fleet container images) ----
info "Creating Artifact Registry repository..."
gcloud artifacts repositories create architect-prime \
  --repository-format=docker \
  --location=us \
  --description="Architect Prime container images" \
  --quiet 2>/dev/null \
  && ok "Artifact Registry created" \
  || ok "Artifact Registry already exists"

# ---- Step 7: Deploy to Cloud Run ----
info "Deploying Cloud Run service: ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --platform=managed \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},NODE_ENV=production,DWD_CLIENT_ID=${DWD_CLIENT_ID},APP_VERSION=${APP_VERSION}" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --port=8080 \
  --quiet
ok "Cloud Run service deployed"

# ---- Step 8: Seed Firestore with DWD config ----
info "Seeding Firestore config..."
ACCESS_TOKEN="$(gcloud auth print-access-token 2>/dev/null)"
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents"

curl -s -X PATCH \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"clientId\": {\"stringValue\": \"${DWD_CLIENT_ID}\"},
      \"signerSA\": {\"stringValue\": \"${DWD_SIGNER_SA}\"},
      \"configured\": {\"booleanValue\": false}
    }
  }" \
  "${FIRESTORE_URL}/config/dwd" > /dev/null 2>&1 \
  && ok "Firestore config seeded" \
  || warn "Failed to seed Firestore (non-critical)"

# ---- Step 9: Get the URL ----
SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --platform=managed --region="$REGION" --format='value(status.url)')"

echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETE                    ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║  Control Plane URL:                                    ║"
echo "║  ${SERVICE_URL}"
echo "║                                                        ║"
echo "║  Next steps:                                           ║"
echo "║  1. Open the URL above                                 ║"
echo "║  2. Deploy your first Prime instance                   ║"
echo "║  3. Configure DWD in the Setup tab                     ║"
echo "║  4. Hire your first fleet agent                        ║"
echo "║                                                        ║"
echo "║  To uninstall:                                         ║"
echo "║  bash deploy/uninstall.sh                              ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo
