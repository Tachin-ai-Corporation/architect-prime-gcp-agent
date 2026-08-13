#!/usr/bin/env bash
# ============================================================
# fleet-bootstrap.sh — Fleet Agent VM setup (Native Node.js Brain)
#
# Downloaded and executed by fleet-deploy's boot stub.
# All config is read from VM metadata attributes.
# ============================================================
set -euo pipefail

export HOME="${HOME:-/root}"
export USER="${USER:-$(whoami)}"

LOG_FILE="/var/log/fleet-agent-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'echo; echo "[ERROR] Line $LINENO failed: $BASH_COMMAND"; echo "Log: $LOG_FILE"; exit 1' ERR

info(){ echo -e "\n==> $*\n"; }
ok()  { echo -e "\n[ OK ] $*\n"; }
warn(){ echo -e "\n[WARN] $*\n"; }

# ---- Read config from VM metadata ----
META="http://metadata.google.internal/computeMetadata/v1"
MH="Metadata-Flavor: Google"
AGENT_ID="$(curl -sf -H "$MH" "$META/instance/attributes/agent_id" || echo 'unknown')"
SPECIALTY="$(curl -sf -H "$MH" "$META/instance/attributes/specialty" || echo 'general')"
CORE_REF="$(curl -sf -H "$MH" "$META/instance/attributes/core_ref" || echo 'main')"
GH_OWNER="$(curl -sf -H "$MH" "$META/instance/attributes/gh_owner" || echo 'YOUR_GITHUB_ORG')"
GH_REPO="$(curl -sf -H "$MH" "$META/instance/attributes/gh_repo" || echo 'architect-prime-gcp-agent')"
GCP_PROJECT_ID="$(curl -sf -H "$MH" "$META/project/project-id")"
AGENT_USER_EMAIL="$(curl -sf -H "$MH" "$META/instance/attributes/agent_user_email" || true)"
AGENT_DISPLAY_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_display_name" || echo "$AGENT_ID")"
AGENT_FIRST_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_first_name" || true)"
AGENT_LAST_NAME="$(curl -sf -H "$MH" "$META/instance/attributes/agent_last_name" || true)"
CHAT_SPACE_ID="$(curl -sf -H "$MH" "$META/instance/attributes/chat_space_id" || true)"
DWD_SIGNER_SA="$(curl -sf -H "$MH" "$META/instance/attributes/dwd_signer_sa" || true)"
PRIME_ID="$(curl -sf -H "$MH" "$META/instance/attributes/prime_id" || true)"
DASHBOARD_URL="$(curl -sf -H "$MH" "$META/instance/attributes/dashboard_url" || true)"
OPERATOR_JOBS="$(curl -sf -H "$MH" "$META/instance/attributes/operator_jobs" || true)"

AGENT_MENTION="${AGENT_FIRST_NAME} ${AGENT_LAST_NAME}"
AGENT_MENTION="$(echo "$AGENT_MENTION" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

MY_TOKEN="$(openssl rand -hex 16)"
CORE_ROOT="/opt/corekit"
CORE_DIR="${CORE_ROOT}"
CORE_BASE="https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${CORE_REF}"

info "Fleet Agent Bootstrap: $(date -Is)"
echo "Agent       : ${AGENT_ID}"
echo "Specialty   : ${SPECIALTY}"
echo "Email       : ${AGENT_USER_EMAIL}"
echo "Display     : ${AGENT_DISPLAY_NAME}"
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


# ---- 2) Install Node.js & npm ----
info "Installing Node.js & npm..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi


# ---- 3) Install CoreKit via manifest ----
info "Installing CoreKit..."
mkdir -p "${CORE_DIR}"
curl -sfL "${CORE_BASE}/infra/install.sh" -o /tmp/install.sh
chmod +x /tmp/install.sh
# Export the CoreKit source so install.sh (a CHILD process) inherits it. Without `export`
# these are unexported shell variables — install.sh then silently falls back to its
# `GH_OWNER=YOUR_GITHUB_ORG` / `CORE_REF=main` defaults and 404s on the very first manifest
# fetch. (Only JOB_FLAGS is safe as a plain var: it is expanded by THIS shell on the bash line
# below, not read from install.sh's environment.) A missing trailing `\` on the JOB_FLAGS line
# had detached these assignments from the `bash /tmp/install.sh` invocation, so they applied to
# nothing.
export CORE_REF GH_OWNER GH_REPO CORE_ROOT
JOB_FLAGS="--job ${SPECIALTY}"
# Append operator job layers (comma-separated in VM metadata)
if [[ -n "$OPERATOR_JOBS" ]]; then
  IFS=',' read -ra OJ_ARRAY <<< "$OPERATOR_JOBS"
  for oj in "${OJ_ARRAY[@]}"; do
    oj="$(echo "$oj" | xargs)"  # trim whitespace
    [[ -n "$oj" ]] && JOB_FLAGS="$JOB_FLAGS --job $oj"
  done
fi
bash /tmp/install.sh --role fleet $JOB_FLAGS

# ---- 4) Read contracts.json for cross-cutting values ----
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

# ---- 5) Save gateway token for ears/mouth ----
echo "${MY_TOKEN}" > "${CORE_DIR}/.gateway-token"
chmod 600 "${CORE_DIR}/.gateway-token"

# ============================================================
# PHASE 2 — Brain Module setup
# ============================================================

# ---- 6) Install brain dependencies ----
info "Installing brain module dependencies..."
cd "${CORE_DIR}/corekit/brain"
npm install --omit=dev 2>&1 | tail -5
chown -R 1000:1000 node_modules 2>/dev/null || true

# ---- 7) Write agent configs from contracts ----
info "Writing agent configs..."
C_SUBAGENT_IDS="$(python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
print(' '.join(c['agents']['subagentIds']))
" 2>/dev/null || echo "temporal-research temporal-memory prefrontal motor cerebellum")"

for AGENT_ID_ITEM in cortex ${C_SUBAGENT_IDS}; do
  AGENT_DIR="${CORE_DIR}/workspace-${AGENT_ID_ITEM}"
  if [[ "${AGENT_ID_ITEM}" == "cortex" ]]; then
    AGENT_DIR="${CORE_DIR}/workspace"
  fi
  mkdir -p "${AGENT_DIR}"
  
  # config.json: model, fallback, maxSteps
  python3 -c "
import json
c = json.load(open('${CONTRACTS}'))
agent_config = {
  'model': c['vertex']['models'].get('cortex' if '${AGENT_ID_ITEM}' == 'cortex' else 'subagent', 'vertex-google/gemini-3.6-flash'),
  'fallbackModel': c['vertex']['models'].get('cortexFallback', 'vertex-google/gemini-3.6-flash'),
  'maxSteps': c['dispatch']['max_iterations'],
}
json.dump(agent_config, open('${AGENT_DIR}/config.json', 'w'), indent=2)
"
done

# ---- 8) Start brain as systemd service ----
info "Starting neural gateway service..."
cat > /etc/systemd/system/agent-neural-gateway.service <<UNIT
[Unit]
Description=Architect Prime Neural Gateway
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
Environment=AGENT_ID=${AGENT_ID}
ExecStart=/usr/bin/node index.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now agent-neural-gateway

# ---- 9) Wait for neural gateway readiness ----
info "Waiting for neural gateway..."
WAITED=0
until curl -sf http://127.0.0.1:${C_GATEWAY_PORT}/healthz > /dev/null 2>&1; do
  sleep 2; WAITED=$((WAITED+2))
  [[ $WAITED -ge 60 ]] && { echo "[ERROR] Neural gateway did not start within 60s"; exit 1; }
done
info "Neural gateway is ready (took ~${WAITED}s)."

# ---- 10) Warm-up probe (pre-warm ADC tokens) ----
info "Running warm-up probe..."
curl -s --max-time 30 -X POST "http://localhost:${C_GATEWAY_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MY_TOKEN}" \
  -d '{"model":"brain/cortex","messages":[{"role":"user","content":"System warm-up. Respond: ready."}]}' \
  > /dev/null 2>&1 || warn "Warm-up probe failed (non-fatal)"

# ============================================================
# PHASE 3 — finalize
# ============================================================

# ---- 11) Write chat-config.json (ears uses this to select gchat channel) ----
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  info "Writing Google Chat config..."
  cat > "${CORE_DIR}/corekit/chat-config.json" <<CHATCFG
{
  "primeId": "${PRIME_ID}",
  "agentId": "${AGENT_ID}",
  "agentDisplayName": "${AGENT_DISPLAY_NAME}",
  "agentUserEmail": "${AGENT_USER_EMAIL}",
  "chatSpaceId": "${CHAT_SPACE_ID}",
  "agentFirstName": "${AGENT_FIRST_NAME}",
  "agentLastName": "${AGENT_LAST_NAME}",
  "agentMention": "${AGENT_MENTION}",
  "projectId": "${GCP_PROJECT_ID}",
  "dwdSignerSa": "${DWD_SIGNER_SA}",
  "geminiProject": "${GCP_PROJECT_ID}",
  "agentType": "${SPECIALTY}",
  "specialty": "${SPECIALTY}"
}
CHATCFG
fi

# ---- 11b) Write identity lockfile ----
if [[ -n "${AGENT_USER_EMAIL}" ]]; then
  echo "${AGENT_USER_EMAIL}" > "${CORE_DIR}/.identity-lock"
  chmod 444 "${CORE_DIR}/.identity-lock"
  info "Identity lock: ${AGENT_USER_EMAIL}"
fi

# ---- 11c) Shared workspace architecture ----
info "Setting up shared workspace architecture..."
SHARED_DIR="${CORE_DIR}/shared"
mkdir -p "$SHARED_DIR"
for dir in "${CORE_DIR}"/workspace*; do
  if [[ -d "$dir" ]]; then
    ln -snf "$SHARED_DIR" "$dir/shared"
  fi
done

# ---- 11e) Provision git artifact substrate bucket (idempotent) ----
info "Provisioning git artifact bucket..."
GIT_BUCKET="$(node -e "const c=JSON.parse(require('fs').readFileSync('${CORE_DIR}/corekit/contracts.json','utf8'));console.log((c.git||{}).bucket||'')" 2>/dev/null || echo '')"
GIT_BUCKET="${GIT_BUCKET//\$\{TENANT\}/${GCP_PROJECT_ID}}"
if [[ -n "$GIT_BUCKET" ]]; then
  if gcloud storage buckets describe "gs://${GIT_BUCKET}" --project="${GCP_PROJECT_ID}" &>/dev/null; then
    info "Git bucket gs://${GIT_BUCKET} already exists — skipping"
  else
    gcloud storage buckets create "gs://${GIT_BUCKET}" \
      --project="${GCP_PROJECT_ID}" \
      --location="us-central1" \
      --uniform-bucket-level-access \
      --public-access-prevention 2>&1 || warn "Git bucket creation failed (may already exist)"
    info "Git bucket gs://${GIT_BUCKET} created"
  fi
  SA_EMAIL="$(curl -sf -H "$MH" "$META/instance/service-accounts/default/email" || echo '')"
  if [[ -n "$SA_EMAIL" ]]; then
    gcloud storage buckets add-iam-policy-binding "gs://${GIT_BUCKET}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="roles/storage.objectAdmin" \
      --project="${GCP_PROJECT_ID}" 2>&1 || warn "Git bucket IAM binding failed"
  fi
fi

# ---- 11d) Final permissions sweep ----
info "Final permissions sweep..."
find "${CORE_DIR}" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "${CORE_DIR}/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true

# ---- Render workspace templates ----
echo "==> Rendering workspace templates"
# Escape sed-special chars in values
TPL_NAME_ESC="${AGENT_DISPLAY_NAME//&/\\&}"
TPL_SPECIALTY_ESC="${SPECIALTY//&/\\&}"
TPL_EMAIL_ESC="${AGENT_USER_EMAIL//&/\\&}"
TPL_PROJECT_ESC="${GCP_PROJECT_ID//&/\\&}"
for f in "${CORE_ROOT}"/workspace*/*.md; do
  [[ -f "$f" ]] || continue
  sed -i \
    -e "s|{{AGENT_NAME}}|${TPL_NAME_ESC}|g" \
    -e "s|{{SPECIALTY}}|${TPL_SPECIALTY_ESC}|g" \
    -e "s|{{PROJECT_ID}}|${TPL_PROJECT_ESC}|g" \
    -e "s|{{AGENT_USER_EMAIL}}|${TPL_EMAIL_ESC}|g" \
    -e "s|{{DEPLOY_TIMESTAMP}}|$(date -u +%Y-%m-%dT%H:%M:%SZ)|g" \
    "$f"
done

# ---- 12) Run assemble-persona for this agent type ----
ASSEMBLE="${CORE_DIR}/bin/assemble-persona"
if [[ -x "$ASSEMBLE" ]]; then
  info "Assembling persona for fleet specialty: ${SPECIALTY}"
  CORE_DIR="${CORE_DIR}" "$ASSEMBLE" "${SPECIALTY}" || warn "assemble-persona failed"
fi

# ---- 12e) Install skill dependencies ----
SKILL_SETUP="${CORE_DIR}/bin/skill-setup"
if [[ -x "$SKILL_SETUP" ]]; then
  "$SKILL_SETUP" --all || warn "skill-setup had errors"
fi

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
systemctl start agent-brain agent-introspect || warn "agent-brain/introspect start failed"

if [[ -n "${AGENT_USER_EMAIL}" && -n "${DWD_SIGNER_SA}" ]]; then
  systemctl start agent-ears agent-mouth || warn "ears/mouth start failed (DWD may not be configured)"
else
  warn "ears/mouth not started — AGENT_USER_EMAIL or DWD_SIGNER_SA not set"
fi

# ---- 14) Report completion to Firestore via Prime's API ----
if [[ -n "$DASHBOARD_URL" && -n "$PRIME_ID" ]]; then
  info "Reporting completion to dashboard..."
  STATUS_BODY="{\"agent\":\"${AGENT_ID}\",\"status\":\"online\",\"actionRequired\":{\"type\":\"workspace_user\",\"title\":\"Create Workspace user and add to Chat space\",\"instructions\":[\"Create Workspace user at https://admin.google.com/ac/users — First: ${AGENT_FIRST_NAME:-Agent}, Last: ${AGENT_LAST_NAME:-${AGENT_ID}}, Email: ${AGENT_USER_EMAIL}\",\"Add ${AGENT_USER_EMAIL} to the AI Fleet Command Chat space\",\"The agent will come online automatically once the user exists\"]}}"

  STATUS_RESP="$(curl -s --max-time 15 -X POST \
    "${DASHBOARD_URL}/api/primes/${PRIME_ID}/fleet/update-status" \
    -H "Content-Type: application/json" \
    -d "$STATUS_BODY" 2>&1)" || STATUS_RESP="CURL_ERROR"

  if echo "$STATUS_RESP" | grep -q '"success"'; then
    info "Dashboard status updated: online"
  else
    warn "Dashboard status update failed: ${STATUS_RESP:0:200}"
  fi
else
  warn "Skipping dashboard status update (DASHBOARD_URL=${DASHBOARD_URL:-unset}, PRIME_ID=${PRIME_ID:-unset})"
fi

# ---- Done ----
echo
echo "============================================"
echo "  FLEET AGENT SETUP COMPLETE"
echo "============================================"
echo "  Log file       : ${LOG_FILE}"
echo "  Gateway token  : ${MY_TOKEN}"
echo "  Brain module   : installed natively"
echo "  Agent          : ${AGENT_DISPLAY_NAME} (${SPECIALTY})"
echo "  Project        : ${GCP_PROJECT_ID}"
echo "============================================"
