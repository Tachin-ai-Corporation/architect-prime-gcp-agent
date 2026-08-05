#!/usr/bin/env bash
# deploy.sh — build + deploy the sync-service to Cloud Run FROM THIS COMMITTED SOURCE.
#
# The service is a `gcloud run deploy --source` build: its image is built from THIS
# directory. Always deploy with this script (never from an ad-hoc copy) so the running
# image is provably built from committed code. Deploying from an uncommitted local dir is
# exactly what let production silently diverge from the repo (the repo held the old
# files.watch version while prod polled for a month).
#
# Required env (operator-specific — never hardcode into the template):
#   GCP_PROJECT       target GCP project (e.g. your-website-project)
#   GCS_BUCKET_NAME   target GCS bucket  (e.g. your-website-assets)
#   DRIVE_FOLDER_ID   Drive root folder to mirror (only its subfolders are synced)
#   SERVICE_URL       this service's own https URL (used as the Changes-API webhook address)
# Optional:
#   REGION            default us-central1
#   SERVICE_NAME      default sync-service
#
# The Cloud Run IAM policy (invoker) and any env vars not listed here are preserved across
# updates. min-instances stays 1 (the 10s poll loop must never scale to zero).
set -euo pipefail
cd "$(dirname "$0")"

: "${GCP_PROJECT:?set GCP_PROJECT to the target GCP project}"
: "${GCS_BUCKET_NAME:?set GCS_BUCKET_NAME to the target GCS bucket}"
: "${DRIVE_FOLDER_ID:?set DRIVE_FOLDER_ID to the Drive root folder}"
: "${SERVICE_URL:?set SERVICE_URL to the service own https URL}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-sync-service}"

echo "==> Deploying ${SERVICE_NAME} to ${GCP_PROJECT}/${REGION} from $(pwd) (committed source)"
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${GCP_PROJECT}" \
  --region "${REGION}" \
  --min-instances 1 \
  --max-instances 10 \
  --update-env-vars "GCS_BUCKET_NAME=${GCS_BUCKET_NAME},DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID},SERVICE_URL=${SERVICE_URL}"

echo "==> Done. Verify the poll loop is live:"
echo "    curl -s ${SERVICE_URL}/health | python3 -m json.tool"
