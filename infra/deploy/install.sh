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
IMAGE_REPO="${IMAGE_REPO:-us-docker.pkg.dev/${PROJECT_ID}/architect-prime}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
APP_VERSION="${APP_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo 'dev')}"

# Auto-detect GitHub coordinates from local git remote if available
GIT_REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo '')"
GH_OWNER_DEFAULT="Tachin-ai-Corporation"
GH_REPO_DEFAULT="architect-prime-gcp-agent"

if [[ "$GIT_REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)? ]]; then
  GH_OWNER_DEFAULT="${BASH_REMATCH[1]}"
  GH_REPO_DEFAULT="${BASH_REMATCH[2]}"
fi

GH_OWNER="${GH_OWNER:-$GH_OWNER_DEFAULT}"
GH_REPO="${GH_REPO:-$GH_REPO_DEFAULT}"

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
echo "║  GitHub:   ${GH_OWNER}/${GH_REPO}"
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
  cloudbuild.googleapis.com
  drive.googleapis.com              # Google Drive — workspace-drive skills
  chat.googleapis.com               # Google Chat — fleet agent channel
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

# ---- Step 3b: Deploy Firestore composite indexes ----
info "Deploying Firestore composite indexes..."
if command -v firebase >/dev/null 2>&1; then
  firebase deploy --only firestore:indexes --project "$PROJECT_ID" --force 2>/dev/null \
    && ok "Firestore indexes deployed" \
    || warn "Firestore index deploy failed (non-critical — indexes can be created manually)"
else
  warn "firebase CLI not found — skipping index deploy. Run manually:"
  warn "  npm install -g firebase-tools && firebase deploy --only firestore:indexes --project $PROJECT_ID"
fi

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
  roles/cloudbuild.builds.editor    # Trigger Cloud Build (dashboard self-upgrade)
  roles/run.admin                   # Update Cloud Run service
)
for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet > /dev/null 2>&1 && ok "$role" || warn "Failed to bind $role"
done

# Grant Cloud Build / Compute SA ability to deploy to Cloud Run
# Cloud Build steps run as the default compute SA, not the Cloud Build SA
info "Granting build SAs permission to deploy..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null)
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
for build_sa in "$COMPUTE_SA" "$CLOUDBUILD_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${build_sa}" \
    --role="roles/run.admin" \
    --condition=None \
    --quiet > /dev/null 2>&1 && ok "${build_sa} → run.admin" || warn "Failed to bind run.admin to ${build_sa}"
  gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
    --member="serviceAccount:${build_sa}" \
    --role="roles/iam.serviceAccountUser" \
    --quiet > /dev/null 2>&1 && ok "${build_sa} → SA user" || warn "Failed to bind SA user for ${build_sa}"
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

# ---- Step 5b: Dashboard OAuth Setup ----
info "Configuring dashboard authentication..."
echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║           Google OAuth Setup (required)                ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║  The dashboard requires Google OAuth for login.        ║"
echo "║  You need an OAuth Client ID from Cloud Console.       ║"
echo "║                                                        ║"
echo "║  If you haven't created one yet:                       ║"
echo "║                                                        ║"
echo "║  1. Go to APIs & Services > OAuth consent screen       ║"
echo "║     Choose 'Internal' (restricts to your Workspace)    ║"
echo "║     App name: Architect Prime                          ║"
echo "║     Scopes: email, profile, openid                     ║"
echo "║                                                        ║"
echo "║  2. Go to APIs & Services > Credentials                ║"
echo "║     Create Credentials > OAuth client ID                ║"
echo "║     Type: Web application                              ║"
echo "║     Name: Architect Prime Dashboard                    ║"
echo "║     (Redirect URI will be shown after deployment)       ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo
read -rp "  Enter Google OAuth Client ID: " GOOGLE_CLIENT_ID
[[ -n "$GOOGLE_CLIENT_ID" ]] || die "OAuth Client ID is required"
read -rp "  Enter Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET
[[ -n "$GOOGLE_CLIENT_SECRET" ]] || die "OAuth Client Secret is required"
read -rp "  Enter allowed domain (e.g., yourcompany.com): " ALLOWED_DOMAIN
ok "OAuth credentials captured"

# Generate NextAuth secret
NEXTAUTH_SECRET=$(openssl rand -base64 32)
ok "NextAuth secret generated"

# Store client secret in Secret Manager
info "Storing OAuth client secret in Secret Manager..."
gcloud services enable secretmanager.googleapis.com --quiet 2>/dev/null || true
if gcloud secrets describe dashboard-oauth-secret --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo -n "$GOOGLE_CLIENT_SECRET" | gcloud secrets versions add dashboard-oauth-secret \
    --data-file=- --project="$PROJECT_ID" --quiet
  ok "Secret updated"
else
  echo -n "$GOOGLE_CLIENT_SECRET" | gcloud secrets create dashboard-oauth-secret \
    --data-file=- --project="$PROJECT_ID" --quiet
  ok "Secret created"
fi

# Grant Cloud Run SA access to manage secrets (create + read)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.admin" \
  --condition=None \
  --quiet > /dev/null 2>&1 \
  && ok "Secret Manager admin binding" \
  || warn "Failed to bind secretmanager.admin"

# ---- Step 6: Create Artifact Registry (for fleet container images) ----
info "Creating Artifact Registry repository..."
gcloud artifacts repositories create architect-prime \
  --repository-format=docker \
  --location=us \
  --description="Architect Prime container images" \
  --quiet 2>/dev/null \
  && ok "Artifact Registry created" \
  || ok "Artifact Registry already exists"

# ---- Step 6b: Build the control-plane image if not present ----
info "Checking for control-plane image..."
if gcloud artifacts docker images describe "$IMAGE" --project="$PROJECT_ID" > /dev/null 2>&1; then
  ok "Image already exists: $IMAGE"
else
  info "Image not found — building from source (this takes 2-3 minutes)..."
  if [[ -d "app" ]]; then
    gcloud builds submit app/ \
      --tag="$IMAGE" \
      --project="$PROJECT_ID" \
      --quiet \
      && ok "Image built and pushed: $IMAGE" \
      || die "Failed to build image. Ensure Cloud Build API is enabled."
  else
    die "Image not found and 'app/' directory missing. Cannot build from source."
  fi
fi
info "Deploying Cloud Run service: ${SERVICE_NAME}..."
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --platform=managed \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},NODE_ENV=production,DWD_CLIENT_ID=${DWD_CLIENT_ID},APP_VERSION=${APP_VERSION},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},NEXTAUTH_SECRET=${NEXTAUTH_SECRET},ALLOWED_DOMAIN=${ALLOWED_DOMAIN},NEXTAUTH_URL=WILL_BE_SET_AFTER_DEPLOY,GH_OWNER=${GH_OWNER},GH_REPO=${GH_REPO}" \
  --set-secrets="GOOGLE_CLIENT_SECRET=dashboard-oauth-secret:latest" \
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

# Update NEXTAUTH_URL now that we know the service URL
info "Setting NEXTAUTH_URL to ${SERVICE_URL}..."
gcloud run services update "$SERVICE_NAME" \
  --platform=managed --region="$REGION" \
  --update-env-vars="NEXTAUTH_URL=${SERVICE_URL}" \
  --quiet
ok "NEXTAUTH_URL set"

echo
echo "╔════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETE                    ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║  Control Plane URL:                                    ║"
echo "║  ${SERVICE_URL}"
echo "║                                                        ║"
echo "║  Next steps:                                           ║"
echo "║  1. Add this redirect URI to your OAuth client:        ║"
echo "║     ${SERVICE_URL}/api/auth/callback/google"
echo "║  2. Open the URL above                                 ║"
echo "║  3. Deploy your first Prime instance                   ║"
echo "║  4. Configure DWD in the Setup tab                     ║"
echo "║  5. Hire your first fleet agent                        ║"
echo "║                                                        ║"
echo "║  To uninstall:                                         ║"
echo "║  bash deploy/uninstall.sh                              ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo
