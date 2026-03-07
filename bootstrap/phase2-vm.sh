#!/usr/bin/env bash
# ============================================================
# ARCHITECT PRIME – PHASE 2 (ONE-SHOT)
# GitHub CoreKit + OpenClaw (Vertex ADC)
#
# NORMALIZED:
#   Host state lives at: /opt/openclaw/.openclaw   (user-independent)
#
# DEBUGGABLE:
#   - Logs to /tmp/architect-prime-phase2-YYYYmmdd-HHMMSS.log
#   - Fails fast with line + command on error
#
# HARDENED (doctor-clean):
#   - Inside container: /home/node/.openclaw = 700
#   - /home/node/.openclaw/openclaw.json = 600 (if present)
#   - bin/oc + bootstrap_smoke remain executable
#
# NOTES:
#   - This script intentionally uses sudo for docker + /opt reads/writes.
#   - After hardening, reading /opt/openclaw/.openclaw from SSH user may require sudo.
# ============================================================
set -euo pipefail

# Ensure HOME and USER are set (unset when running as GCE startup script)
export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="${LOG_FILE:-/tmp/architect-prime-phase2-$(date +%Y%m%d-%H%M%S).log}"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }
die(){ echo -e "\n[ERROR] $*\nLog: $LOG_FILE\n"; exit 1; }

# --- CONFIG START ---
MY_TOKEN="${MY_TOKEN:-$(openssl rand -hex 16)}"
GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
EXPECTED_RUNTIME_SA_EMAIL="${EXPECTED_RUNTIME_SA_EMAIL:-architect-prime@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"

GH_OWNER="${GH_OWNER:-Tachin-ai-Corporation}"
GH_REPO="${GH_REPO:-architect-prime-gcp-agent}"
CORE_REF="${CORE_REF:-main}"

OC_HOST_ROOT="${OC_HOST_ROOT:-/opt/openclaw}"
OC_HOST_DIR="${OC_HOST_DIR:-${OC_HOST_ROOT}/.openclaw}"

# OpenClaw version pin — commit SHA (preferred) or empty for latest.
# Obtain a SHA with: git ls-remote https://github.com/openclaw/openclaw.git HEAD
OPENCLAW_PIN_SHA="${OPENCLAW_PIN_SHA:-}"
# --- CONFIG END ---

CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Logging to: $LOG_FILE"
info "CoreKit: ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "CORE_BASE   : ${CORE_BASE}"
echo "OC_HOST_DIR : ${OC_HOST_DIR}"
echo "PROJECT     : ${GCP_PROJECT_ID}"
echo "TOKEN       : ${MY_TOKEN}"

# 0) Verify attached VM service account (ADC source)
info "Verifying attached VM service account..."
META="http://metadata.google.internal/computeMetadata/v1"
ATTACHED_SA_EMAIL="$(curl -fsS -H 'Metadata-Flavor: Google' "${META}/instance/service-accounts/default/email")"
echo "Attached VM service account: ${ATTACHED_SA_EMAIL}"
[[ "${ATTACHED_SA_EMAIL}" == "${EXPECTED_RUNTIME_SA_EMAIL}" ]] || die "VM SA mismatch. Expected=${EXPECTED_RUNTIME_SA_EMAIL} Actual=${ATTACHED_SA_EMAIL}"

# 1) Prereqs
info "Installing prereqs..."
sudo apt-get update -y
sudo apt-get install -y curl git python3 ca-certificates gnupg

# 2) Docker (idempotent) + validate daemon
info "Installing Docker (if missing)..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sudo sh /tmp/get-docker.sh
fi
sudo groupadd -f docker || true
sudo usermod -aG docker "$USER" || true

DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "${DOCKER_GID}" ]] || die "Could not determine docker group GID"
echo "Docker group GID: ${DOCKER_GID}"

info "Validating Docker daemon via sudo..."
sudo docker version

# 3) Prepare normalized host dirs
info "Preparing normalized host directories..."
sudo mkdir -p "${OC_HOST_DIR}"
sudo chmod 755 "${OC_HOST_ROOT}" || true

# Remove wrong-path leftovers from earlier bug (/opt/openclaw/openclaw/*)
if sudo test -d "${OC_HOST_ROOT}/openclaw"; then
  info "Removing stale wrong-path install: ${OC_HOST_ROOT}/openclaw"
  sudo rm -rf "${OC_HOST_ROOT}/openclaw"
fi

# 4) Install CoreKit via install.sh (manifest-driven, writes STATE.json)
info "Installing CoreKit via install.sh..."
curl -fsSL "${CORE_BASE}/install.sh" | \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  CORE_REF="${CORE_REF}" \
  OC_HOST_ROOT="${OC_HOST_ROOT}" \
  INSTALL_USE_SUDO=1 \
  bash

info "CoreKit install OK."

# 5) Build & run OpenClaw container (pinned stable commit)
info "Cloning/updating OpenClaw repo..."
cd "${HOME}"
if [[ ! -d openclaw/.git ]]; then
  git clone https://github.com/openclaw/openclaw.git
fi

cd openclaw
git fetch --all --prune

if [[ -n "${OPENCLAW_PIN_SHA}" ]]; then
  STABLE_COMMIT="${OPENCLAW_PIN_SHA}"
  git cat-file -t "${STABLE_COMMIT}" >/dev/null 2>&1 || die "OPENCLAW_PIN_SHA=${OPENCLAW_PIN_SHA} not found in repo"
else
  STABLE_COMMIT="$(git rev-parse origin/main)"
fi
[[ -n "${STABLE_COMMIT}" ]] || die "Failed to resolve STABLE_COMMIT"
git checkout "${STABLE_COMMIT}"
info "Using OpenClaw commit: ${STABLE_COMMIT}"

cat > .env <<EOF
GATEWAY_BIND=loopback
GATEWAY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=${MY_TOKEN}
OPENCLAW_CONFIG_DIR=/home/node/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json

GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
GCLOUD_PROJECT=${GCP_PROJECT_ID}
CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}

GOOGLE_GENAI_USE_VERTEXAI=True
GOOGLE_CLOUD_LOCATION=global
EOF

info "Building Docker image openclaw:local ..."
sudo docker build -t openclaw:local .

info "Removing old container (if any)..."
sudo docker rm -f openclaw-gateway >/dev/null 2>&1 || true

info "Starting OpenClaw container..."
sudo docker run -d \
  --name openclaw-gateway \
  --network host \
  --restart always \
  --env-file .env \
  -v "${OC_HOST_DIR}:/home/node/.openclaw" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "${DOCKER_GID}" \
  openclaw:local

info "Waiting 45s for first boot..."
sleep 45

# 6) Harden inside container (doctor-clean; preserve executables)
info "Hardening /home/node/.openclaw inside container (doctor-clean)..."
sudo docker exec -u 0 openclaw-gateway bash -lc '
set -e
mkdir -p /home/node/.openclaw/credentials

chmod 700 /home/node/.openclaw
chmod 700 /home/node/.openclaw/credentials
chmod 700 /home/node/.openclaw/bin 2>/dev/null || true

chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/bootstrap_smoke.sh 2>/dev/null || true

chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chmod 600 /home/node/.openclaw/corekit/SOURCE.json 2>/dev/null || true

chown -R node:node /home/node/.openclaw
'

# 7) Render config template + apply via RPC (baseHash-safe)
# NOTE: After hardening, OC_HOST_DIR becomes 700-owned by uid 1000, so render with sudo.
info "Rendering /tmp/openclaw-bootstrap.json5 (sudo due to hardened perms)..."
sudo python3 - <<PY
import pathlib
oc = pathlib.Path("${OC_HOST_DIR}")
tmpl_path = oc / "corekit" / "openclaw-bootstrap.json5.tmpl"
out_path = pathlib.Path("/tmp/openclaw-bootstrap.json5")

tmpl = tmpl_path.read_text(encoding="utf-8")
tmpl = tmpl.replace("\${GCP_PROJECT_ID}", "${GCP_PROJECT_ID}")
tmpl = tmpl.replace("\${MY_TOKEN}", "${MY_TOKEN}")
out_path.write_text(tmpl, encoding="utf-8")
print("Wrote", out_path)
PY

info "Reading baseHash from gateway config.get..."
CONFIG_GET_RAW="$(sudo docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.get --json --params '{}' 2>&1)"

BASE_HASH="$(python3 -c 'import json,sys,re
raw=sys.stdin.read()
m=re.search(r"\{.*\}", raw, re.S)
raw_json=m.group(0) if m else raw
try:
  j=json.loads(raw_json)
except Exception:
  sys.exit(0)
print(j.get("hash") or (j.get("payload") or {}).get("hash") or ((j.get("result") or {}).get("payload") or {}).get("hash") or "")
' <<<"$CONFIG_GET_RAW")"

[[ -n "${BASE_HASH}" ]] || die "Could not read baseHash from config.get. Raw: ${CONFIG_GET_RAW}"
echo "baseHash: ${BASE_HASH}"

PARAMS="$(python3 - <<PY
import json
raw=open("/tmp/openclaw-bootstrap.json5","r",encoding="utf-8").read()
print(json.dumps({"raw": raw, "baseHash": "${BASE_HASH}", "note": "bootstrap"}))
PY
)"

info "Applying config via RPC (config.apply)..."
sudo docker exec openclaw-gateway node /app/openclaw.mjs gateway call config.apply --json --params "${PARAMS}"

info "Post-apply harden..."
sudo docker exec -u 0 openclaw-gateway bash -lc '
set -e
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/oc 2>/dev/null || true
chmod 700 /home/node/.openclaw/bin/bootstrap_smoke.sh 2>/dev/null || true
chown -R node:node /home/node/.openclaw
' || true

# 8) Inject host Docker CLI into container (proven pattern)
info "Injecting host Docker CLI into container..."
sudo docker cp "$(which docker)" openclaw-gateway:/usr/local/bin/docker || true
sudo docker exec -u 0 openclaw-gateway chmod +x /usr/local/bin/docker || true
sudo docker exec -u 0 openclaw-gateway groupadd -g "${DOCKER_GID}" -o -r docker 2>/dev/null || true
sudo docker exec -u 0 openclaw-gateway chown -R node:node /usr/local/bin/docker || true
sudo docker exec -u 0 openclaw-gateway chown -R node:node /home/node/.openclaw || true

# 8.5) Seed workspace state files (repeatability)
info "Seeding workspace state files..."
BOOTSTRAP_TS="$(date -Is)"
sudo docker exec openclaw-gateway bash -lc "
set -e
mkdir -p /home/node/.openclaw/workspace/checkpoint
mkdir -p /home/node/.openclaw/shared

# STATE.md — initial bootstrap state
cat > /home/node/.openclaw/workspace/STATE.md <<'STATE'
# STATE

## Current phase
Bootstrap complete. No plans executed yet.

## Environment
- **Bootstrap timestamp:** ${BOOTSTRAP_TS}
- **CoreKit ref:** ${GH_OWNER}/${GH_REPO}@${CORE_REF}
- **OpenClaw commit:** ${STABLE_COMMIT}
- **GCP project:** ${GCP_PROJECT_ID}
- **Runtime SA:** ${ATTACHED_SA_EMAIL}

## Active plan
None.
STATE

# checkpoint/progress.json — initial empty checkpoint
cat > /home/node/.openclaw/workspace/checkpoint/progress.json <<'CKPT'
{
  \"version\": 1,
  \"bootstrapTimestamp\": \"${BOOTSTRAP_TS}\",
  \"coreRef\": \"${CORE_REF}\",
  \"openclawCommit\": \"${STABLE_COMMIT}\",
  \"gcpProject\": \"${GCP_PROJECT_ID}\",
  \"runtimeSA\": \"${ATTACHED_SA_EMAIL}\",
  \"checkpoints\": [],
  \"activePlan\": null
}
CKPT

chown -R node:node /home/node/.openclaw/workspace/checkpoint
chown -R node:node /home/node/.openclaw/shared
"

# 9) Doctor + smoke
info "Running doctor..."
sudo docker exec openclaw-gateway bash -lc '/home/node/.openclaw/bin/oc doctor --fix || true'
sudo docker exec openclaw-gateway bash -lc '/home/node/.openclaw/bin/oc doctor --non-interactive'

info "Running bootstrap_smoke..."
sudo docker exec openclaw-gateway bash -lc "/home/node/.openclaw/bin/bootstrap_smoke.sh" || true

# 10) Configure Chat + announce (best-effort, non-blocking)
info "Configuring Google Chat..."
CHAT_SPACE_ID="${CHAT_SPACE_ID:-}"
if [[ -z "$CHAT_SPACE_ID" ]]; then
  # Try to read from VM metadata
  CHAT_SPACE_ID="$(curl -s -f -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/attributes/chat_space_id' 2>/dev/null || true)"
fi

if [[ -n "$CHAT_SPACE_ID" ]]; then
  # Write chat-config.json
  chat_config="${OC_HOST_DIR}/corekit/chat-config.json"
  cat > "$chat_config" <<CHATEOF
{
  "spaceId": "${CHAT_SPACE_ID}",
  "botDisplayName": "Architect Prime",
  "projectId": "${GCP_PROJECT_ID}"
}
CHATEOF
  chmod 644 "$chat_config"
  chown 1000:1000 "$chat_config" 2>/dev/null || true
  echo "Chat config written to: $chat_config"

  # Auto-announce (best-effort)
  info "Announcing in Google Chat..."
  export CHAT_SPACE_ID
  export OC_HOST_ROOT="${OC_HOST_ROOT}"
  "${OC_HOST_DIR}/bin/chat-send" \
    "🏛 *Architect Prime* is online.
Project: \`${GCP_PROJECT_ID}\`
CoreKit: \`${GH_OWNER}/${GH_REPO}@${CORE_REF}\`
Time: $(date -Is)" || warn "Chat announce failed (non-blocking)"
else
  warn "No CHAT_SPACE_ID found — skipping Chat announce. See docs/CHAT_SETUP.md"
fi

echo
echo "✅ PHASE 2 COMPLETE (ONE-SHOT)"
echo "---------------------------------------------------"
echo "LOG FILE: ${LOG_FILE}"
echo "YOUR ACCESS TOKEN: ${MY_TOKEN}"
echo "CoreKit: ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "OpenClaw commit: ${STABLE_COMMIT}"
echo "CoreKit host dir: ${OC_HOST_DIR}"
echo "Attached VM SA verified: ${ATTACHED_SA_EMAIL}"
echo
echo "Next steps (run on your LOCAL machine):"
echo "gcloud compute ssh architect-prime --zone us-central1-a --tunnel-through-iap -- -L 18889:127.0.0.1:18789"
echo "Then open: http://127.0.0.1:18889/?token=${MY_TOKEN}"
