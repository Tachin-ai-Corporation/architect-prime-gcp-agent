# Architect Prime Bootstrap (One-shot)

This folder contains the **human-run** bootstrap that creates/refreshes the GCP VM and installs/runs Architect Prime inside it.

These scripts are intentionally **NOT** part of `manifest.txt` (CoreKit install contract). They are for **infra/bootstrap only**.

## What this supports

- **Fresh project**: creates runtime SA + VM, then installs/configures Prime.
- **Rebuild**: safely re-applies SA/IAM + **deletes and recreates the VM**, then re-installs Prime.

## Recommended: pin to a tag

For reliability, pin `CORE_REF` to a repo checkpoint tag (not `main`).

## Security / repo hygiene

Do **not** commit any service account keys. These scripts assume Vertex ADC via the VM-attached runtime service account.

## One-shot (Cloud Shell)

In Google Cloud Console → **Cloud Shell**, with the target project selected:

```bash
# Pin to a tag whenever possible:
export CORE_REF="v0.1.0"

# Auto-detect project from Cloud Shell config
export PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: gcloud project is not set. Run: gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi

# Optional overrides
export ZONE="us-central1-a"
export VM="architect-prime"
export PRIME_SA_NAME="architect-prime"

curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/oneshot-cloudshell.sh" | bash
