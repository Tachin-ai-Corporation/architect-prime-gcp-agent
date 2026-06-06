#!/usr/bin/env bash
# ============================================================
# prime-bootstrap.sh — Prime VM setup (Native Node.js Brain)
#
# Downloaded and executed by the deploy API's boot stub.
# All config is read from VM metadata attributes.
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/prime-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
PRIME_ID="$(curl -sf -H "$MH" "$META/instance/attributes/prime_id" || echo 'unknown')"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'prime')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'Tachin-ai-Corporation')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"

MY_TOKEN="$(openssl rand -hex 16)"
CORE_ROOT="/opt/corekit"
CORE_DIR="${CORE_ROOT}"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Prime VM Bootstrap: $(date -Is)"
echo "Prime ID    : ${PRIME_ID}"
echo "Agent       : ${AGENT_ID}"
echo "CoreRef     : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "Project     : ${GCP_PROJECT_ID}"

# ============================================================
# PHASE 1 — System setup
# ============================================================

# ---- 1) Install system packages ----
info "Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git python3 ca-certificates gnupg jq openssl

# ---- 2) Install Docker CE (for subagent/motor task execution) ----
info "Installing Docker CE..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
systemctl enable docker
systemctl start docker
DOCKER_GID="$(getent group docker | cut -d: -f3)"
[[ -n "${DOCKER_GID}" ]] || { echo "[ERROR] Could not determine docker group GID"; exit 1; }

# ---- 3) Install Node.js & npm ----
info "Installing Node.js & npm..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

# ---- 4) Install CoreKit via manifest (base + prime) ----
info "Installing CoreKit..."
mkdir -p "${CORE_DIR}"
curl -sfL "${CORE_BASE}/infra/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
CORE_REF="${CORE_REF}" \
  GH_OWNER="${GH_OWNER}" \
  GH_REPO="${GH_REPO}" \
  CORE_ROOT="${CORE_ROOT}" \
  bash /tmp/install.sh --role prime

# ---- 5) Read contracts.json for cross-cutting values ----
CONTRACTS="${CORE_DIR}/corekit/contracts.json"
if [[ -f "$CONTRACTS" ]]; then
  C_LOCATION="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['vertex']['location'])")"
  C_GATEWAY_PORT="$(python3 -c "import json; print(json.load(open('$CONTRACTS'))['gateway']['port'])")"
  info "Contracts loaded: location=${C_LOCATION} port=${C_GATEWAY_PORT}"
else
  warn "contracts.json not found — using defaults"
  C_LOCATION="us-central1"
  C_GATEWAY_PORT="18789"
fi

# ---- 6) Save gateway token for ears/mouth ----
echo "${MY_TOKEN}" > "${CORE_DIR}/.gateway-token"
chmod 600 "${CORE_DIR}/.gateway-token"

# ============================================================
# PHASE 2 — Brain Module setup
# ============================================================

# ---- 7) Install brain dependencies ----
info "Installing brain module dependencies..."
cd "${CORE_DIR}/corekit/brain"
npm install --omit=dev 2>&1 | tail -5
chown -R 1000:1000 node_modules 2>/dev/null || true

# ---- 8) Write agent configs from contracts ----
info "Writing agent configs..."
C_SUBAGENT_IDS="$(python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
print(' '.join(c['agents']['subagentIds']))
" 2>/dev/null || echo "temporal-research temporal-memory prefrontal motor cerebellum")"

for AGENT_ID in cortex ${C_SUBAGENT_IDS}; do
  AGENT_DIR="${CORE_DIR}/workspace-${AGENT_ID}"
  if [[ "${AGENT_ID}" == "cortex" ]]; then
    AGENT_DIR="${CORE_DIR}/workspace"
  fi
  mkdir -p "${AGENT_DIR}"
  
  # config.json: model, fallback, maxSteps
  python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
agent_config = {
  'model': c['vertex']['models'].get('cortex' if '${AGENT_ID}' == 'cortex' else 'subagent', 'vertex-google/gemini-2.5-flash'),
  'fallbackModel': c['vertex']['models'].get('cortexFallback', 'vertex-google/gemini-2.5-flash'),
  'maxSteps': c['brain']['max_iterations'],
}
json.dump(agent_config, open('${AGENT_DIR}/config.json', 'w'), indent=2)
"
done

# ---- 9) Start brain as systemd service ----
info "Starting brain gateway service..."
cat > /etc/systemd/system/agent-brain-gateway.service <<UNIT
[Unit]
Description=Architect Prime Brain Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${CORE_DIR}/corekit/brain
Environment=GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID}
Environment=GOOGLE_CLOUD_LOCATION=${C_LOCATION}
Environment=BRAIN_PORT=${C_GATEWAY_PORT}
Environment=CONTRACTS_PATH=${CONTRACTS}
Environment=AGENTS_DIR=${CORE_DIR}
Environment=WORKSPACE_BASE=${CORE_DIR}
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now agent-brain-gateway

# ---- 10) Wait for brain gateway readiness ----
info "Waiting for brain gateway..."
WAITED=0
until curl -sf http://127.0.0.1:${C_GATEWAY_PORT}/healthz > /dev/null 2>&1; do
  sleep 2; WAITED=$((WAITED+2))
  [[ $WAITED -ge 60 ]] && { echo "[ERROR] Brain gateway did not start within 60s"; exit 1; }
done
info "Brain gateway is ready (took ~${WAITED}s)."

# ---- 11) Warm-up probe (pre-warm ADC tokens) ----
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"brain/cortex","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ============================================================
# PHASE 3 — finalize
# ============================================================

# ---- 12) Write prime-config.json ----
cat > "${CORE_DIR}/corekit/prime-config.json" <<PCFG
{
  "primeId": "${PRIME_ID}",
  "projectId": "${GCP_PROJECT_ID}",
  "role": "prime"
}
PCFG

# ---- 12b) Write identity lockfile ----
PRIME_EMAIL=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/agent_user_email" 2>/dev/null || true)
if [[ -n "${PRIME_EMAIL}" ]]; then
  echo "${PRIME_EMAIL}" > "${CORE_DIR}/.identity-lock"
  chmod 444 "${CORE_DIR}/.identity-lock"
  info "Identity lock: ${PRIME_EMAIL}"
fi

# ---- 12c) Shared workspace architecture ----
info "Setting up shared workspace architecture..."
SHARED_DIR="${CORE_DIR}/shared"
mkdir -p "$SHARED_DIR"
for dir in "${CORE_DIR}"/workspace*; do
  if [[ -d "$dir" ]]; then
    ln -snf "$SHARED_DIR" "$dir/shared"
  fi
done

# ---- 12d) Final permissions sweep ----
info "Final permissions sweep..."
find "${CORE_DIR}" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${CORE_DIR}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- 13) Install agent-ears, agent-mouth, agent-brain, agent-introspect as systemd services ----
info "Installing systemd services..."
for svc in agent-ears agent-mouth agent-brain agent-introspect; do
  SVC_SRC="${CORE_DIR}/corekit/${svc}.service"
  if [[ -f "$SVC_SRC" ]]; then
    cp "$SVC_SRC" "/etc/systemd/system/${svc}.service"
  fi
done

systemctl daemon-reload
systemctl enable agent-ears agent-mouth agent-brain agent-introspect 2>/dev/null || true
systemctl start agent-ears agent-mouth agent-brain agent-introspect

# ---- 14) Install command-runner as systemd service ----
info "Installing command-runner systemd service..."
cat > /etc/systemd/system/command-runner.service <<CRUNIT
[Unit]
Description=Architect Prime Command Runner (Deterministic Operations)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=CORE_ROOT=${CORE_ROOT}
Environment=GCP_PROJECT_ID=${GCP_PROJECT_ID}
Environment=PRIME_ID=${PRIME_ID}
Environment=POLL_INTERVAL=5
ExecStart=${CORE_DIR}/bin/command-runner
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
CRUNIT

systemctl daemon-reload
systemctl enable command-runner
systemctl start command-runner

# ---- 15) Install fleet-health-check timer ----
info "Installing fleet-health-check systemd timer..."
cp "${CORE_DIR}/corekit/fleet-health-check.service" /etc/systemd/system/fleet-health-check.service
cp "${CORE_DIR}/corekit/fleet-health-check.timer" /etc/systemd/system/fleet-health-check.timer
chmod +x "${CORE_DIR}/bin/fleet-health-check"
chmod +x "${CORE_DIR}/bin/update-deep-truths"
systemctl daemon-reload
systemctl enable fleet-health-check.timer
systemctl start fleet-health-check.timer

# ---- Done ----
echo
echo "============================================"
echo "  PRIME VM SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  CoreKit        : ${GH_OWNER}/${GH_REPO}@${CORE_REF}"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "  Prime ID       : ${PRIME_ID}"
echo "  I/O Services   : agent-ears + agent-mouth"
echo "  Health check   : fleet-health-check.timer"
echo "============================================"
