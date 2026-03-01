# Architect Prime Bootstrap (Repo-managed)

This folder contains the **human-run** bootstrap scripts that create/refresh the GCP VM and then install/run Architect Prime inside it.

These scripts are intentionally **NOT** part of `manifest.txt` (CoreKit install contract). They are for **infra/bootstrap only**.

## What this supports

- **Fresh project**: creates runtime SA + VM and performs Prime install/config.
- **Reboot / rebuild**: idempotently re-applies SA/IAM + **deletes and recreates the VM**, then re-installs Prime.

## Recommended: pin to a tag

For reliability, pin `CORE_REF` to a repo tag (checkpoint) instead of `main`.

## Quickstart (Cloud Shell) — One-shot

In Google Cloud Console → **Cloud Shell** (in the project you want Prime to live in):

```bash
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export ZONE="us-central1-a"
export VM="architect-prime"
export PRIME_SA_NAME="architect-prime"

# Pin to a tag whenever possible:
export CORE_REF="main"   # TODO: replace with a checkpoint tag

curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/oneshot-cloudshell.sh" | bash
```

## Two-step (Cloud Shell → VM)

### Phase 1 (Cloud Shell): create/refresh SA + VM

```bash
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export ZONE="us-central1-a"
export VM="architect-prime"
export PRIME_SA_NAME="architect-prime"
export CORE_REF="main"   # TODO: replace with a checkpoint tag

curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/phase1-cloudshell.sh" | bash
```

This will drop you into an SSH session on the VM (unless `AUTO_SSH=0`).

### Phase 2 (on the VM): install CoreKit + run Prime

```bash
export GH_OWNER="Tachin-ai-Corporation"
export GH_REPO="architect-prime-gcp-agent"
export CORE_REF="main"   # TODO: replace with a checkpoint tag

export GCP_PROJECT_ID="$PROJECT_ID"
export EXPECTED_RUNTIME_SA_EMAIL="architect-prime@${PROJECT_ID}.iam.gserviceaccount.com"

curl -fsSL "https://raw.githubusercontent.com/Tachin-ai-Corporation/architect-prime-gcp-agent/${CORE_REF}/bootstrap/phase2-vm.sh" | bash
```

## Configuration knobs (env vars)

### Phase 1
- `PROJECT_ID`, `ZONE`, `VM`, `PRIME_SA_NAME`
- `MACHINE_TYPE`, `BOOT_DISK_SIZE`, `IMAGE_FAMILY`, `IMAGE_PROJECT`
- `FW_RULE_NAME`, `VM_NET_TAG`, `LABELS`
- `AUTO_SSH` (default `1`)

### Phase 2
- `GH_OWNER`, `GH_REPO`, `CORE_REF`
- `GCP_PROJECT_ID`, `EXPECTED_RUNTIME_SA_EMAIL`
- `MY_TOKEN` (optional; auto-generated if omitted)

## Logs

- Phase 1 writes `./architect-prime-phase1-YYYYmmdd-HHMMSS.log` in Cloud Shell.
- Phase 2 writes `/tmp/architect-prime-phase2-YYYYmmdd-HHMMSS.log` on the VM.

## Security / repo hygiene

Do **not** commit any service account keys. These scripts assume Vertex ADC via the VM-attached runtime service account.
